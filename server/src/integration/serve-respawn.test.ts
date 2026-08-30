// The real incident, reproduced against a REAL ptyd.
//
// Panes 01KXAYH4EX… (Notes) and 01KXQGRMDY… (Reader) were `muxpad serve` panes.
// After a ptyd restart every AGENT pane came back — the dead-runner sweep in
// ws.ts rebuilt them — while the serve panes stayed dead, because nothing swept
// them and their pty is only created when something attaches to the terminal
// face (which never happens for a pane watched through its web face). Both apps
// were down until someone hand-rolled POST /api/panes/:id/respawn.
//
// The unit tests (serve-supervisor.test.ts) prove the rails against a fake ptyd.
// This one proves the actual claim end to end: a serve pane with no runtime in a
// live ptyd gets one back, its startup command really reaches the pty, and an
// agent pane in the same DB is left alone for ws.ts.
import { decodeServerMessage } from '@muxpad/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { EventBus } from '../events.js';
import { createServeSupervisor } from '../serve-supervisor.js';
import { PaneStore } from '../store/PaneStore.js';
import { TabStore } from '../store/TabStore.js';
import { WorkspaceStore } from '../store/WorkspaceStore.js';
import { openDb } from '../store/db.js';
import { type SpawnedPtyd, spawnPtyd } from '../test-helpers/spawnPtyd.js';

const SERVE_CMD = 'muxpad serve --url http://127.0.0.1:4321 -- ./start';

let ptyd: SpawnedPtyd | null = null;
afterEach(async () => {
  if (ptyd) await ptyd.cleanup();
  ptyd = null;
});

describe('serve pane recovery against a live ptyd', () => {
  it('gives a runtime-less serve pane its pty (and startup command) back', async () => {
    ptyd = await spawnPtyd();
    const db = openDb(':memory:');
    const workspaces = new WorkspaceStore(db);
    const tabs = new TabStore(db);
    const panes = new PaneStore(db);
    const ws = workspaces.create({ name: 'W' });
    const tab = tabs.create({ name: 'T', layout: '', workspace_id: ws.id });

    // /bin/cat as the "shell" for the same reason the other integration tests
    // use it: a real shell's prompt output is nondeterministic. cat echoing the
    // typed startup command back is exactly the evidence we want.
    const serve = panes.create({
      tab_id: tab.id,
      shell: '/bin/cat',
      cwd: '/tmp',
      startup_cmd: SERVE_CMD,
    });
    const agent = panes.create({
      tab_id: tab.id,
      shell: '/bin/cat',
      cwd: '/tmp',
      startup_cmd: 'muxpad agent --resume abc123',
    });
    // Both panes predate the startup grace (panes the user made days ago).
    for (const id of [serve.id, agent.id]) {
      db.prepare('UPDATE panes SET created_at = ? WHERE id = ?').run(1, id);
    }

    // The post-ptyd-restart state: ptyd knows nothing about either pane.
    expect(await ptyd.client.hasPane(serve.id)).toBe(false);
    expect(await ptyd.client.hasPane(agent.id)).toBe(false);

    const sup = createServeSupervisor({
      db,
      ptyd: ptyd.client,
      events: new EventBus(),
      log: () => {},
    });
    await sup.sweep();

    // The serve pane is running again…
    expect(await ptyd.client.hasPane(serve.id)).toBe(true);
    // …and the agent pane is untouched. That one is ws.ts's job; two
    // supervisors racing to respawn the same pty is precisely what we don't
    // want, which is why each sweep's SQL is a disjoint startup_cmd prefix.
    expect(await ptyd.client.hasPane(agent.id)).toBe(false);

    // Attach to the recovered pty and read its buffer: the startup command
    // was typed, so cat has echoed it back.
    //
    // The listener goes on BEFORE we await 'open' (same as ws.test.ts's replay
    // test): ptyd sends its snapshot from the connection handler, and a
    // listener attached afterwards can miss it.
    const sock = new WebSocket(`ws+unix://${ptyd.socketPath}:/pty/${serve.id}`);
    let seen = '';
    sock.on('message', (b: Buffer) => {
      try {
        const msg = decodeServerMessage(new Uint8Array(b));
        if (msg.kind === 'output') seen += msg.data;
      } catch {
        // non-output frame — ignore
      }
    });
    await new Promise<void>((resolve, reject) => {
      sock.once('open', () => resolve());
      sock.once('error', reject);
    });
    // Generous deadline on purpose. hasPane goes true the moment ptyd
    // REGISTERS the runtime; the PTY itself spawns asynchronously, then waits
    // 50ms before typing the startup command. Under a parallel full-suite run
    // (other files driving real ptys and agent runners) that chain can take
    // seconds — the shape that already flakes ws.test.ts and main-restart. A
    // real regression still fails: the command would never appear at all.
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline && !seen.includes(SERVE_CMD)) {
      await new Promise((r) => setTimeout(r, 30));
    }
    expect(seen).toContain(SERVE_CMD);
    sock.close();

    // A second sweep is a no-op now that it's alive: no kill/respawn churn.
    await sup.sweep();
    expect(await ptyd.client.hasPane(serve.id)).toBe(true);

    db.close();
  }, 30_000);
});
