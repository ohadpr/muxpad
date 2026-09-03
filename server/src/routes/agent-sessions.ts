import { type ChatEvent, normalizeTranscriptLine } from '@muxpad/shared';
import type Database from 'better-sqlite3';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AgentBridge } from '../agent-bridge.js';
import { findTranscript, identityNormalize, muxpadLocate } from '../chat/TranscriptReader.js';
import { readTailLines } from '../chat/has-messages.js';
import type { EventBus } from '../events.js';
import type { PtydClient } from '../ptyd-client/PtydClient.js';
import { AgentSessionStore } from '../store/AgentSessionStore.js';
import { PaneStore } from '../store/PaneStore.js';

// How much of a transcript's tail to read when serving /transcript. Bounds
// the read on multi-GB transcripts; comfortably holds the max `tail` events
// (image-heavy lines run to hundreds of KB, hence the generous window).
const TRANSCRIPT_TAIL_BYTES = 4 * 1024 * 1024;

// Session ids become a filename (`<sid>.jsonl`) that the tail resolves by
// scanning project dirs — so constrain the charset to prevent a crafted id
// (`../…`, absolute paths) from making the reader probe/stream arbitrary files.
const SessionId = z.string().regex(/^[A-Za-z0-9._-]{1,128}$/);

const RegisterSchema = z.object({
  pane_id: z.string().min(1),
  assistant: z.string().optional(),
  cwd: z.string().optional(),
  session_id: SessionId.optional(),
  pid: z.number().int().positive().optional(),
});

const HookSchema = z.object({
  pane_id: z.string().min(1),
  session_id: SessionId,
  source: z.string().optional(),
});

/**
 * Agent-session tracking. Because muxpad owns every Claude launch (the
 * `muxpad claude` wrapper), discovery is deterministic, not fs-watched:
 *   - `POST /register` — the wrapper, at launch, with the minted --session-id.
 *   - `POST /hook` — the SessionStart hook the wrapper installs, on every
 *     start / resume / compact / fork, with the real provider session-id.
 * See docs/plans/2026-07-01-web-chat-session-switching.md.
 */
export function agentSessionsRoutes(deps: {
  db: Database.Database;
  ptyd: PtydClient;
  events?: EventBus;
  agentBridge?: AgentBridge;
}): Hono {
  const app = new Hono();
  const store = new AgentSessionStore(deps.db);
  const emitChange = (paneId: string) =>
    deps.events?.emit({ type: 'agent_session.updated', pane_id: paneId });

  // Shared view mode (terminal | chat) for the session — persisted so the
  // choice propagates across devices (switch to chat on desktop → mobile shows
  // chat too, instead of an empty terminal whose Claude was taken over).
  app.post('/:paneId/view-mode', async (c) => {
    const body = z
      .object({ mode: z.enum(['terminal', 'chat']) })
      .parse(await c.req.json().catch(() => ({})));
    store.setViewMode(c.req.param('paneId'), body.mode);
    // Push (don't wait for the poll): other devices flip their face live.
    emitChange(c.req.param('paneId'));
    return c.body(null, 204);
  });

  // Deliver a user message to the pane's connected agent runner — HTTP
  // counterpart of the chat socket's `send` frame, for the CLI's
  // `muxpad agent new "message"` flow (and anything else scripted). Only
  // runner-owned panes: no headless-spawn fallback, none of its guard
  // cascade. 409 with a reason while the runner is still booting — callers
  // poll; the runner registers within a few seconds of pane spawn.
  app.post('/:paneId/send', async (c) => {
    const body = z
      .object({
        text: z
          .string()
          .min(1)
          .max(64 * 1024),
      })
      .parse(await c.req.json().catch(() => ({})));
    const res = deps.agentBridge?.send(c.req.param('paneId'), body.text) ?? {
      ok: false as const,
      reason: 'agent relay unavailable',
    };
    return c.json(res, res.ok ? 202 : 409);
  });

  app.post('/register', async (c) => {
    const body = RegisterSchema.parse(await c.req.json().catch(() => ({})));
    const session = store.register(body);
    emitChange(body.pane_id);
    return c.json(session, 201);
  });

  app.post('/hook', async (c) => {
    const body = HookSchema.parse(await c.req.json().catch(() => ({})));
    const session = store.recordSessionId(body.pane_id, body.session_id);
    // Unknown pane = a session muxpad didn't launch. Out of scope; ack softly
    // so the hook (which runs inside Claude) never surfaces an error.
    if (!session) return c.json({ ok: false, reason: 'no agent session for pane' }, 202);
    emitChange(body.pane_id);
    return c.json(session);
  });

  // `turn_active`: the runner registry's real turn state (true mid-turn,
  // false idle, false when no runner is connected). Deliberately NOT the
  // pane's `status`/`busy`, which is broader by design — it stays `working`
  // while a background subagent outlives the turn that launched it, and on a
  // runner-LESS pane it tracks raw pty output. This is the narrow "is a turn
  // in flight right now" that `muxpad agent wait` needs.
  const turnActive = (paneId: string): boolean => deps.agentBridge?.turnActive(paneId) === true;

  // Every tracked session. `mode` is joined in from the PANE row (the source
  // of truth for ⚡ do / 🧠 deep) rather than duplicated onto agent_sessions:
  // the mode belongs to the pane and must survive a session being re-minted.
  app.get('/', (c) => {
    const panes = new PaneStore(deps.db);
    return c.json(
      store.list().map((s) => ({
        ...s,
        mode: panes.getById(s.pane_id)?.mode ?? 'deep',
        turn_active: turnActive(s.pane_id),
      })),
    );
  });

  // Last N normalized transcript events for a pane's session, as JSONL —
  // role/text/tool-use ChatEvents, whatever the backend. CLI consumers must
  // never have to parse raw backend formats (Claude's projects JSONL vs the
  // muxpad-normalized log); the same TranscriptReader machinery the chat
  // socket uses does the translation here.
  app.get('/:paneId/transcript', (c) => {
    const paneId = c.req.param('paneId');
    const sess = store.getByPane(paneId);
    if (!sess) return c.json({ error: 'no agent session for pane' }, 404);
    const sid = sess.current_sid;
    if (!sid) return c.json({ error: 'session has no transcript yet' }, 404);
    // Claude writes ~/.claude/projects/**/<sid>.jsonl; codex/cursor write the
    // muxpad-normalized log. Same locator cascade as the summarize route.
    const path = (sess.assistant === 'claude' ? findTranscript(sid) : null) ?? muxpadLocate(sid);
    if (!path) return c.json({ error: 'transcript not found' }, 404);
    const tailQ = Number(c.req.query('tail') ?? 100);
    const tail = Number.isInteger(tailQ) && tailQ > 0 ? Math.min(tailQ, 1000) : 100;
    const normalize = sess.assistant === 'claude' ? normalizeTranscriptLine : identityNormalize;
    let lines: string[];
    try {
      lines = readTailLines(path, TRANSCRIPT_TAIL_BYTES);
    } catch {
      return c.json({ error: 'transcript unreadable' }, 404);
    }
    const events: ChatEvent[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      let obj: unknown;
      try {
        obj = JSON.parse(line);
      } catch {
        continue; // torn/garbage line — skip, never break the feed
      }
      events.push(...normalize(obj));
    }
    const body = events
      .slice(-tail)
      .map((e) => JSON.stringify(e))
      .join('\n');
    return c.text(body ? `${body}\n` : '', 200, { 'content-type': 'application/x-ndjson' });
  });

  app.get('/by-pane/:paneId', (c) => {
    const paneId = c.req.param('paneId');
    const session = store.getByPane(paneId);
    if (!session) return c.json({ error: 'not found' }, 404);
    return c.json({ ...session, turn_active: turnActive(paneId) });
  });

  return app;
}
