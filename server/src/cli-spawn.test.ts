import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const MUXPAD_BIN = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'scripts',
  'muxpad',
);

/**
 * `muxpad agent new` — WHAT IT ASKS FOR, and what it refuses to guess.
 *
 * A spawn's place is its parent's business (see routes/tabs.ts). The server is
 * where that is decided and where it is tested against real rows; what is left
 * for the CLI is the decision it makes BEFORE asking — whether to name a
 * workspace at all — and that decision used to be the whole bug: it read
 * `$MUXPAD_WORKSPACE_ID` out of its own environment, a value stamped into the
 * pane at birth, and sent it as fact.
 *
 * So this drives the script against a RECORDING stub rather than the real app:
 * the assertion is about the request body, the whole point is that no real
 * workspace is involved, and a full-stack version would need a ptyd, a runner
 * and thirty seconds of send-polling to observe one JSON field.
 */
describe('muxpad agent new — the workspace it names', () => {
  let server: Server;
  let port: number;
  let tmp: string;
  /** Every POST /api/tabs body the script sent, parsed. */
  let posted: Record<string, unknown>[] = [];
  /** Every first-message body it sent afterwards — the other half of a spawn. */
  let sent: { text?: string }[] = [];
  /** What the stub server answers `POST /api/tabs` with, so a test can put a
   *  `spawn_brief` in it the way the real route does. */
  let tabResponse: Record<string, unknown> = {};

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'muxpad-cli-spawn-'));
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = req.url ?? '';
      const json = (code: number, body: unknown) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.method === 'POST' && url === '/api/tabs') {
        let raw = '';
        req.on('data', (c) => {
          raw += c;
        });
        req.on('end', () => {
          posted.push(JSON.parse(raw || '{}') as Record<string, unknown>);
          // The server answers with where it PUT the tab — which for a spawn is
          // the parent's workspace, and is the only way the caller finds out.
          json(201, {
            id: 't-child',
            slug: 'child-slug',
            workspace_id: 'ws-parent',
            ...tabResponse,
          });
        });
        return;
      }
      if (req.method === 'GET' && url === '/api/tabs/t-child') {
        return json(200, { id: 't-child', panes: [{ id: 'p-child' }] });
      }
      if (req.method === 'POST' && url === '/api/agent-sessions/p-child/send') {
        let raw = '';
        req.on('data', (c) => {
          raw += c;
        });
        req.on('end', () => {
          sent.push(JSON.parse(raw || '{}') as { text?: string });
          json(202, { queued: false });
        });
        return;
      }
      if (req.method === 'GET' && url.startsWith('/api/workspaces')) {
        return json(200, [
          { id: 'ws-parent', slug: 'parent-ws', hidden: false },
          { id: 'ws-stale', slug: 'stale-ws', hidden: false },
        ]);
      }
      // The URL-printing helper probes this and tolerates any failure.
      return json(404, { error: 'no' });
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    port = (server.address() as { port: number }).port;
  });

  afterAll(async () => {
    await new Promise<void>((done) => server.close(() => done()));
    rmSync(tmp, { recursive: true, force: true });
  });

  afterEach(() => {
    posted = [];
    sent = [];
    tabResponse = {};
  });

  function run(env: Record<string, string>, args: string[] = ['agent', 'new', 'go']) {
    return execFileAsync('bash', [MUXPAD_BIN, ...args], {
      env: {
        ...process.env,
        MUXPAD_API_URL: `http://127.0.0.1:${port}`,
        MUXPAD_DATA_DIR: tmp,
        ...env,
      },
    });
  }

  it('names NO workspace when it is spawning from inside a pane', async () => {
    // The stale env value is present and deliberately WRONG — it is what a pane
    // that has since been moved carries, and what kept re-seeding a workspace
    // the user had abandoned.
    const { stdout } = await run({
      MUXPAD_PANE_ID: 'p-parent',
      MUXPAD_WORKSPACE_ID: 'ws-stale',
    });
    expect(posted).toHaveLength(1);
    expect(posted[0]?.spawned_by_pane).toBe('p-parent');
    expect('workspace_id' in (posted[0] as object)).toBe(false);
    // …and the URL it prints is where the server said the worker landed.
    expect(stdout).toContain('/w/parent-ws/t/child-slug');
  });

  it('works with no workspace in the environment at all', async () => {
    // The flag was the workaround for the bug. Without a parent this used to be
    // a hard error before a single request went out.
    await run({ MUXPAD_PANE_ID: 'p-parent', MUXPAD_WORKSPACE_ID: '' });
    expect(posted).toHaveLength(1);
    expect(posted[0]?.spawned_by_pane).toBe('p-parent');
  });

  it('says out loud that --workspace is ignored for a spawn with a parent', async () => {
    const { stderr } = await run({ MUXPAD_PANE_ID: 'p-parent' }, [
      'agent',
      'new',
      '--workspace=ws-stale',
      'go',
    ]);
    expect(stderr).toMatch(/--workspace is ignored/);
    expect('workspace_id' in (posted[0] as object)).toBe(false);
  });

  it('still names one for a ROOT spawn — no pane, no parent', async () => {
    await run({ MUXPAD_PANE_ID: '', MUXPAD_WORKSPACE_ID: 'ws-parent' });
    expect(posted[0]?.workspace_id).toBe('ws-parent');
    expect('spawned_by_pane' in (posted[0] as object)).toBe(false);
  });

  it('refuses a ROOT spawn with nothing to go on, before asking the server', async () => {
    await expect(run({ MUXPAD_PANE_ID: '', MUXPAD_WORKSPACE_ID: '' })).rejects.toThrow(
      /--workspace=<id> required/,
    );
    expect(posted).toHaveLength(0);
  });

  /**
   * THE REPORT-BACK BRIEFING, from the server's response into the worker's first
   * message.
   *
   * "I just got a push notification about A2 completing their work and I come
   * here and I can't find anything about that subject." The server composes the
   * instruction (it knows the parent and its pane); this script knows the task.
   * So the only thing the CLI does is put one in front of the other — and the
   * reason it does no more than that is the quoting: the briefing contains a
   * `muxpad agent send '<pane>' '<marker>'` command that has already been got
   * wrong once, there are /bin/sh -n tests over it, and a second copy of it in
   * shell would be a second place for it to break. Here it is inert data.
   */
  describe('the spawn briefing it prepends', () => {
    const brief =
      '<muxpad-direct id="t-child" from="Ohad\'s project" pane="p-parent">\nreport back with: muxpad agent send \'p-parent\' \'<muxpad-report/>\n</muxpad-direct>\n\n';

    it('puts the server’s briefing in front of the task, verbatim', async () => {
      tabResponse = { spawn_brief: brief };
      await run({ MUXPAD_PANE_ID: 'p-parent' });
      expect(sent).toHaveLength(1);
      // Byte-for-byte: the briefing ends with its own blank line, so the two
      // halves concatenate into the string a one-shot compose would have made.
      expect(sent[0]?.text).toBe(`${brief}go`);
    });

    it('does not mangle the marker or the quoted command on the way through', async () => {
      // It rides a JSON body, so an apostrophe in a chat name, a `<`, a newline
      // and a single-quoted shell word all arrive as themselves. This is the
      // whole reason the composition is not done here.
      tabResponse = { spawn_brief: brief };
      await run({ MUXPAD_PANE_ID: 'p-parent' });
      expect(sent[0]?.text).toContain('from="Ohad\'s project"');
      expect(sent[0]?.text).toContain("muxpad agent send 'p-parent'");
    });

    it('sends the message UNTOUCHED when the server offers no briefing', async () => {
      // A root spawn, or a parent with no pane that could receive a send. The
      // old behaviour exactly — and `// empty` rather than `//""` so a `null`
      // cannot reach the message as the four characters "null".
      tabResponse = { spawn_brief: null };
      await run({ MUXPAD_PANE_ID: '', MUXPAD_WORKSPACE_ID: 'ws-parent' });
      expect(sent[0]?.text).toBe('go');
    });
  });
});
