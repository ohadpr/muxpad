import { decodeServerMessage, encodeInput } from '@muxpad/shared';
import type Database from 'better-sqlite3';
import { Hono } from 'hono';
import WebSocket from 'ws';
import { z } from 'zod';
import type { PtydCache } from '../ptyd-cache.js';
import type { PtydClient } from '../ptyd-client/PtydClient.js';
import { PaneStore } from '../store/PaneStore.js';

/**
 * Read/write access to a terminal pane's PTY over HTTP — the orchestration
 * plumbing from docs/plans/2026-08-21-ceo-pane.md (A1 scrollback, A2 input).
 *
 * Both endpoints act as a short-lived pty client: they open the same
 * `/pty/:id` WS on ptyd that `proxyAttach` bridges for browsers, do their one
 * job, and disconnect. Deliberately no ptyd change (a ptyd bounce kills every
 * terminal): the ring-buffer replay a fresh attach receives IS the scrollback.
 *
 * Verified attach side effects: none. ptyd's `attachPty` sends the replay and
 * registers output listeners; `markSeen` is an explicit control RPC (never
 * fired on attach), and `PaneRuntime.connectedClients` — which drives resize
 * arbitration — only grows when a client sends an OP_RESIZE frame, which we
 * never do. Other attached clients (the real browser) are untouched: ptyd
 * supports concurrent pty clients and our close only removes our listeners.
 */

/**
 * Named keys for POST /:id/input — the small fixed table from the spec,
 * translated server-side so callers never craft raw escape bytes.
 */
const NAMED_KEYS: Record<string, string> = {
  enter: '\r',
  esc: '\x1b',
  tab: '\t',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
};
for (let i = 0; i < 26; i++) {
  // ctrl-a … ctrl-z → 0x01 … 0x1a
  NAMED_KEYS[`ctrl-${String.fromCharCode(97 + i)}`] = String.fromCharCode(i + 1);
}

// Matches the escape sequences a terminal stream carries: OSC (title/app-url
// markers), CSI (colors/cursor), DCS/SOS/PM/APC strings, two-char Fe escapes,
// and charset designations. Applied before control-char removal so sequence
// payloads (which may contain printable text, e.g. OSC titles) go with them.
const ANSI_RE = new RegExp(
  [
    '\\u001b\\][^\\u0007\\u001b]*(?:\\u0007|\\u001b\\\\)?', // OSC … BEL/ST (or cut off)
    '\\u001b\\[[0-9;?<=>]*[ -/]*[@-~]', // CSI … final byte
    '\\u001b[PX^_][^\\u001b]*(?:\\u001b\\\\)?', // DCS/SOS/PM/APC … ST
    '\\u001b[()][0-9A-Za-z]', // charset designation
    '\\u001b[@-Z\\\\-_]', // two-char Fe escape
  ].join('|'),
  'g',
);

/**
 * Turn raw PTY output into grep-able plain text: drop escape sequences,
 * emulate carriage-return overwrites (progress bars redraw a line with \r —
 * keep the final rendering, not every intermediate), and strip remaining
 * control chars except newline/tab. Exported for unit tests.
 */
export function stripScrollback(s: string): string {
  const noAnsi = s.replace(ANSI_RE, '');
  const lines = noAnsi
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => {
      if (!line.includes('\r')) return line;
      // \r rewinds to column 0; the last non-empty segment is what the
      // terminal ended up showing (a trailing bare \r leaves the prior text).
      const segs = line.split('\r');
      for (let i = segs.length - 1; i >= 0; i--) {
        const seg = segs[i];
        if (seg !== '') return seg;
      }
      return '';
    });
  // Strip any remaining stray control chars except newline and tab.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
  return lines.join('\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
}

/**
 * Attach to ptyd's `/pty/:id`, capture the ring-buffer replay burst, detach.
 *
 * End-of-replay detection: the pty protocol has NO explicit marker, but ptyd
 * sends the whole snapshot as a single OP_OUTPUT frame synchronously on
 * attach (pty-bridge.ts) — so "first frame + a short quiet gap" is reliable.
 * The quiet gap also folds in any live output that streams right behind the
 * replay (it's equally part of "what the terminal shows"). Guards: a longer
 * first-frame wait covers an empty ring (no frame at all), and a hard cap
 * bounds the request when a pane is streaming continuously.
 */
function captureReplay(opts: {
  socketPath: string;
  paneId: string;
  quietMs?: number;
  firstFrameMs?: number;
  maxMs?: number;
}): Promise<string> {
  const { socketPath, paneId, quietMs = 150, firstFrameMs = 500, maxMs = 2000 } = opts;
  return new Promise<string>((resolve, reject) => {
    const ws = new WebSocket(`ws+unix://${socketPath}:/pty/${paneId}`);
    ws.binaryType = 'nodebuffer';
    const chunks: string[] = [];
    let settled = false;
    let quietTimer: ReturnType<typeof setTimeout> | null = null;
    let maxTimer: ReturnType<typeof setTimeout> | null = null;

    const finish = (err?: Error): void => {
      if (settled) return;
      settled = true;
      if (quietTimer) clearTimeout(quietTimer);
      if (maxTimer) clearTimeout(maxTimer);
      try {
        ws.close(1000);
      } catch {
        // already closing; ignore
      }
      if (err) reject(err);
      else resolve(chunks.join(''));
    };

    const armQuiet = (ms: number): void => {
      if (quietTimer) clearTimeout(quietTimer);
      quietTimer = setTimeout(() => finish(), ms);
    };

    ws.on('open', () => {
      // No frame yet → wait the (longer) first-frame window; an empty ring
      // sends nothing at all and this is the only way to conclude "empty".
      armQuiet(firstFrameMs);
      maxTimer = setTimeout(() => finish(), maxMs);
    });
    ws.on('message', (data: WebSocket.RawData) => {
      const buf = Buffer.isBuffer(data)
        ? data
        : Array.isArray(data)
          ? Buffer.concat(data)
          : Buffer.from(data);
      try {
        const msg = decodeServerMessage(new Uint8Array(buf));
        if (msg.kind === 'output') chunks.push(msg.data);
      } catch {
        // unknown frame — ignore; replay completeness is time-based anyway
      }
      armQuiet(quietMs);
    });
    ws.on('close', (code: number, reason: Buffer) => {
      // 4404 = pane not found on ptyd (raced a kill); anything else mid-read
      // just ends the capture with what we have.
      if (!settled && code === 4404) finish(new Error(reason.toString('utf8') || 'pane not found'));
      else finish();
    });
    ws.on('error', (err: Error) => finish(err));
  });
}

/** Open `/pty/:id` (replay suppressed), write one input frame, disconnect. */
function writeInput(opts: { socketPath: string; paneId: string; data: string }): Promise<void> {
  const { socketPath, paneId, data } = opts;
  return new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(`ws+unix://${socketPath}:/pty/${paneId}?replay=0`);
    ws.binaryType = 'nodebuffer';
    let settled = false;
    const finish = (err?: Error): void => {
      if (settled) return;
      settled = true;
      try {
        ws.close(1000);
      } catch {
        // already closing; ignore
      }
      if (err) reject(err);
      else resolve();
    };
    ws.on('open', () => {
      ws.send(encodeInput(data), (err) => finish(err ?? undefined));
    });
    ws.on('close', (code: number, reason: Buffer) => {
      if (!settled)
        finish(
          new Error(
            code === 4404
              ? reason.toString('utf8') || 'pane not found'
              : 'pty socket closed before write',
          ),
        );
    });
    ws.on('error', (err: Error) => finish(err));
  });
}

export function paneIoRoutes(deps: {
  db: Database.Database;
  ptyd: PtydClient;
  cache: PtydCache;
}): Hono {
  const app = new Hono();
  const panes = new PaneStore(deps.db);

  // A pane must exist, be a shell pane, and have a live pty for either
  // endpoint to make sense. Returns the error to send, or null when ok.
  const guard = async (
    id: string,
  ): Promise<{ status: 400 | 404 | 503; code: string; message: string } | null> => {
    const p = panes.getById(id);
    if (!p) return { status: 404, code: 'not_found', message: 'pane not found' };
    if (p.kind !== 'shell')
      return { status: 400, code: 'bad_request', message: 'not a terminal pane' };
    let running = false;
    try {
      running = await deps.ptyd.hasPane(id);
    } catch {
      return { status: 503, code: 'ptyd_unavailable', message: 'ptyd is unreachable' };
    }
    if (!running) return { status: 400, code: 'bad_request', message: 'pane has no live pty' };
    return null;
  };

  // A1 — read a terminal pane's scrollback. Plain text; ?raw=1 keeps escape
  // sequences, ?lines=N trims to the last N lines.
  app.get('/:id/scrollback', async (c) => {
    const id = c.req.param('id');
    const g = await guard(id);
    if (g) return c.json({ error: { code: g.code, message: g.message } }, g.status);
    let captured: string;
    try {
      captured = await captureReplay({ socketPath: deps.ptyd.socketPath, paneId: id });
    } catch (err) {
      return c.json({ error: { code: 'attach_failed', message: String(err) } }, 503);
    }
    let text = c.req.query('raw') === '1' ? captured : stripScrollback(captured);
    const linesQ = c.req.query('lines');
    if (linesQ !== undefined) {
      const n = Number(linesQ);
      if (!Number.isInteger(n) || n < 1)
        return c.json(
          { error: { code: 'bad_request', message: 'lines must be a positive integer' } },
          400,
        );
      text = text.split('\n').slice(-n).join('\n');
    }
    return c.text(text);
  });

  // A2 — inject input into a terminal pane. Body: {text, enter?} or
  // {keys: [...]} (mutually exclusive). This is typing into someone's live
  // terminal, so every injection is logged for auditability.
  app.post('/:id/input', async (c) => {
    const id = c.req.param('id');
    const parsed = z
      .object({
        text: z
          .string()
          .max(64 * 1024)
          .optional(),
        enter: z.boolean().optional(),
        keys: z.array(z.string()).min(1).max(64).optional(),
      })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success)
      return c.json(
        {
          error: {
            code: 'bad_request',
            message: parsed.error.issues[0]?.message ?? 'invalid body',
          },
        },
        400,
      );
    const body = parsed.data;
    if ((body.text === undefined) === (body.keys === undefined))
      return c.json(
        { error: { code: 'bad_request', message: 'exactly one of text/keys required' } },
        400,
      );
    let data: string;
    if (body.keys) {
      const bad = body.keys.find((k) => !(k in NAMED_KEYS));
      if (bad !== undefined)
        return c.json(
          {
            error: {
              code: 'bad_request',
              message: `unknown key '${bad}' (known: ${Object.keys(NAMED_KEYS).join(', ')})`,
            },
          },
          400,
        );
      data = body.keys.map((k) => NAMED_KEYS[k]).join('');
    } else {
      data = (body.text as string) + (body.enter ? '\r' : '');
    }
    const g = await guard(id);
    if (g) return c.json({ error: { code: g.code, message: g.message } }, g.status);
    // Audit trail: a misbehaving orchestrator must be diagnosable from
    // server.log. Text is previewed (not dumped) so a pasted blob stays sane.
    const what = body.keys
      ? `keys=${body.keys.join(',')}`
      : `text=${JSON.stringify((body.text as string).slice(0, 120))}${body.enter ? '+enter' : ''}`;
    console.log(`[pane-input] pane=${id} ${what}`);
    // Mirror proxyAttach's onInput: injected keystrokes are "the user typed",
    // so their echo shouldn't light the busy spinner (the command's real
    // output streams past the grace window and still trips it).
    deps.cache.noteInput(id);
    try {
      await writeInput({ socketPath: deps.ptyd.socketPath, paneId: id, data });
    } catch (err) {
      return c.json({ error: { code: 'write_failed', message: String(err) } }, 503);
    }
    return c.body(null, 204);
  });

  return app;
}
