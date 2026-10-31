import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { EventBus } from './events.js';
import { PtydCache } from './ptyd-cache.js';
import type { PtydClient } from './ptyd-client/PtydClient.js';
import { PaneStore } from './store/PaneStore.js';
import { TabStore } from './store/TabStore.js';
import { WorkspaceStore } from './store/WorkspaceStore.js';
import { openDb } from './store/db.js';
import { attachWsServer } from './ws.js';

/**
 * BACKGROUND SHELL COMMANDS REACHING THE CHAT.
 *
 * The runner has always reported them (`{t:'background', live}`), and the
 * server has always used that to settle a worker whose turn ended with one
 * still going. Nothing forwarded it to the browser, so the cockpit showed
 * NOTHING for the only kind of live work it could not see: no row, no mark,
 * no count — just a completion notice in the log, minutes later, which read
 * as "what is this and why is it not a sub-agent?".
 *
 * Two things have to hold: a chat that is open hears about the change, and a
 * chat that connects LATER is told the current number — a build running for
 * twenty minutes must not be invisible to a reload.
 */

const sockets: WebSocket[] = [];
const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(() => {
  for (const s of sockets.splice(0)) s.close();
  for (const h of servers.splice(0)) h.close();
});

const pushes: Array<[string, string]> = [];

async function boot() {
  pushes.length = 0;
  const db = openDb(':memory:');
  const workspace = new WorkspaceStore(db).create({ name: 'W' });
  const tab = new TabStore(db).create({ name: 'T', layout: '', workspace_id: workspace.id });
  const pane = new PaneStore(db).create({ tab_id: tab.id, startup_cmd: 'muxpad agent' });
  const http = createServer();
  servers.push(http);
  attachWsServer({
    http,
    db,
    events: new EventBus(),
    cache: new PtydCache(),
    ptyd: { on: () => {} } as unknown as PtydClient,
    notifyPane: (paneId: string, body: string) => {
      pushes.push([paneId, body]);
      return 'sent';
    },
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const port = (http.address() as AddressInfo).port;

  /** Opens a socket AND starts collecting immediately — the session frame can
   *  arrive in the same tick as the open, so a listener attached afterwards
   *  misses the very thing these tests are about. */
  const open = async (path: string) => {
    const sock = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    sockets.push(sock);
    const seen: Array<Record<string, unknown>> = [];
    sock.on('message', (data) => {
      try {
        seen.push(JSON.parse(String(data)) as Record<string, unknown>);
      } catch {
        // not ours
      }
    });
    await new Promise<void>((resolve, reject) => {
      sock.once('open', resolve);
      sock.once('error', reject);
    });
    return { sock, seen };
  };

  const { sock: runner } = await open(`/ws/agent-runner/${pane.id}`);
  runner.send(
    JSON.stringify({
      t: 'hello',
      sid: '11111111-2222-3333-4444-555555555555',
      cwd: '/tmp',
      pid: 4242,
      turnActive: false,
    }),
  );
  return { pane, open, runner, db };
}

const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

describe('the background-command count', () => {
  it('reaches an open chat when it changes', async () => {
    const { pane, open, runner } = await boot();
    const { seen } = await open(`/ws/chat/${pane.id}`);
    await settle();

    runner.send(JSON.stringify({ t: 'background', live: 2 }));
    await settle();

    const frames = seen.filter((f) => f.t === 'background');
    expect(frames).toHaveLength(1);
    expect(frames[0]?.live).toBe(2);
  });

  it('is on the session frame, so a reload is not blind to a running build', async () => {
    const { pane, open, runner } = await boot();
    runner.send(JSON.stringify({ t: 'background', live: 3 }));
    await settle();

    // Somebody opens the chat now — long after the command started.
    const { seen } = await open(`/ws/chat/${pane.id}`);
    await settle(400);

    const session = seen.find((f) => f.t === 'session');
    expect(session?.background).toBe(3);
  });

  it('says nothing at all when nothing is running', async () => {
    const { pane, open } = await boot();
    const { seen } = await open(`/ws/chat/${pane.id}`);
    await settle(400);
    // Absent, not `background: 0` — every other backend sends no such field,
    // and absence already reads as none everywhere.
    const session = seen.find((f) => f.t === 'session');
    expect(session && 'background' in session).toBe(false);
  });

  it('reports the drain, so the cell can go away', async () => {
    const { pane, open, runner } = await boot();
    const { seen } = await open(`/ws/chat/${pane.id}`);
    await settle();

    runner.send(JSON.stringify({ t: 'background', live: 1 }));
    await settle();
    runner.send(JSON.stringify({ t: 'background', live: 0 }));
    await settle();

    expect(seen.filter((f) => f.t === 'background').map((f) => f.live)).toEqual([1, 0]);
  });

  it('ignores a frame that is not a number', async () => {
    const { pane, open, runner } = await boot();
    const { seen } = await open(`/ws/chat/${pane.id}`);
    await settle();
    runner.send(JSON.stringify({ t: 'background', live: 'two' }));
    await settle();
    expect(seen.filter((f) => f.t === 'background')).toHaveLength(0);
  });
});

/**
 * THE BOLD MARK, AND THE TURN THAT HAS NOTHING TO SAY.
 *
 * Reported as "@Investing keeps showing as new message but nothing is
 * happening there". That chat carries six scheduled jobs; the hourly one
 * refreshes a card and is told in its own prompt to say nothing. Every fire
 * was a turn, and every turn-done bolded the row — so the rail promised
 * something to read that the log did not contain.
 */
describe('unread after a turn', () => {
  const unread = (db: ReturnType<typeof openDb>, paneId: string) =>
    (db.prepare('SELECT unread FROM panes WHERE id = ?').get(paneId) as { unread: number }).unread;

  it('does NOT bold the chat for a silent machine turn', async () => {
    const { pane, runner, db } = await boot();
    runner.send(JSON.stringify({ t: 'turn-start' }));
    await settle();
    runner.send(JSON.stringify({ t: 'turn-done', ok: true, silent: true }));
    await settle();
    expect(unread(db, pane.id)).toBe(0);
  });

  it('bolds it when the turn said something', async () => {
    const { pane, runner, db } = await boot();
    runner.send(JSON.stringify({ t: 'turn-start' }));
    await settle();
    runner.send(JSON.stringify({ t: 'turn-done', ok: true }));
    await settle();
    expect(unread(db, pane.id)).toBe(1);
  });

  it('bolds it for a backend that has never heard of the field', async () => {
    // The failure direction that matters: an extra mark is noise, a missing
    // one loses news. codex and cursor send no `silent`, ever.
    const { pane, runner, db } = await boot();
    runner.send(JSON.stringify({ t: 'turn-start' }));
    await settle();
    runner.send(JSON.stringify({ t: 'turn-done', ok: true, silent: false }));
    await settle();
    expect(unread(db, pane.id)).toBe(1);
  });

  it('bolds it when a silent turn FAILED — an error is always news', async () => {
    const { pane, runner, db } = await boot();
    runner.send(JSON.stringify({ t: 'turn-start' }));
    await settle();
    runner.send(JSON.stringify({ t: 'turn-done', ok: false, error: 'boom' }));
    await settle();
    expect(unread(db, pane.id)).toBe(1);
  });
});

/**
 * THE QUIET CHANNEL AND THE LOUD ONE HAVE TO AGREE.
 *
 * The bold mark asks `silent`; the PUSH did not. So a scheduled job told to
 * say nothing left the sidebar correctly unbolded and still vibrated a phone
 * on every fire — found on a half-hourly cron whose only job is to rewrite a
 * card:
 * "every hour or so it sends me a push notification about a card being
 * updated". The channel nobody can ignore was the one being noisy.
 */
/**
 * Relay a cron fire and then LEAVE — the socket is closed before the turn
 * ends, because an open chat suppresses the push on its own
 * (`chatClients.has`). A cron test that kept it open would pass for the wrong
 * reason and keep passing if the cron gate were deleted.
 */
async function fireCron(
  open: (path: string) => Promise<{ sock: WebSocket }>,
  paneId: string,
): Promise<void> {
  const { sock } = await open(`/ws/chat/${paneId}`);
  sock.send(
    JSON.stringify({
      t: 'send',
      text: '<muxpad-cron id="c1" name="nw-hourly" at="1">refresh the card</muxpad-cron>do it',
    }),
  );
  await settle();
  await new Promise<void>((resolve) => {
    sock.once('close', () => resolve());
    sock.close();
  });
  await settle();
}

describe('push notifications and the silent turn', () => {
  it('does NOT push for a silent machine turn', async () => {
    const { runner } = await boot();
    runner.send(JSON.stringify({ t: 'turn-start' }));
    await settle();
    runner.send(JSON.stringify({ t: 'turn-done', ok: true, silent: true }));
    await settle();
    expect(pushes).toEqual([]);
  });

  it('does NOT push while somebody has the chat OPEN', async () => {
    // The dominant source of "a ton of push notifications": the gate asked
    // when the user last TYPED, so any turn over two minutes buzzed a phone —
    // including one they were watching. 938 of 4,094 turns in this install
    // qualified, 463 of them in one foreground chat.
    const { pane, open, runner } = await boot();
    await open(`/ws/chat/${pane.id}`);
    await settle();
    runner.send(JSON.stringify({ t: 'turn-start' }));
    await settle();
    runner.send(JSON.stringify({ t: 'turn-done', ok: true, summary: 'done' }));
    await settle();
    expect(pushes).toEqual([]);
  });

  it('pushes when the turn actually said something', async () => {
    const { pane, runner } = await boot();
    runner.send(JSON.stringify({ t: 'turn-start' }));
    await settle();
    runner.send(JSON.stringify({ t: 'turn-done', ok: true, summary: 'card refreshed' }));
    await settle();
    expect(pushes.map(([id]) => id)).toEqual([pane.id]);
  });

  it('does NOT push a CRON fire, whatever its prose said', async () => {
    // THE SAME LEAK, A SECOND TIME, AND THE REASON IT IS ASKED TWICE.
    // `nw-hourly` is a card refresher whose prompt says "Say nothing" three
    // different ways. The runner-side fix (proseSpeaks) stops it setting
    // `silent: false` — but a runner is a long-lived process, and that one had
    // been up for seven days when the fix shipped, so it kept buzzing a phone.
    // The screenshot read "Portfolio from muxpad — Quiet.", which is the
    // agent's own prose arriving as a notification.
    //
    // The server restarts on every deploy and a runner must not be respawned
    // to deliver a fix (it kills background subagents and wakeups). So the
    // gate asks here too — and this test deliberately sends `silent: false`,
    // i.e. an OLD runner's answer.
    const { pane, open, runner } = await boot();
    await fireCron(open, pane.id);
    runner.send(JSON.stringify({ t: 'turn-start' }));
    await settle();
    runner.send(JSON.stringify({ t: 'turn-done', ok: true, silent: false, summary: 'Quiet.' }));
    await settle();
    expect(pushes).toEqual([]);
  });

  it('…and a FAILED cron fire still does, because an error is news', async () => {
    const { pane, open, runner } = await boot();
    await fireCron(open, pane.id);
    runner.send(JSON.stringify({ t: 'turn-start' }));
    await settle();
    runner.send(JSON.stringify({ t: 'turn-done', ok: false, error: 'boom' }));
    await settle();
    expect(pushes.map(([id]) => id)).toEqual([pane.id]);
  });

  it('STILL pushes a silent turn that FAILED — an error is news', async () => {
    // `silent` is already false for a failed turn (isSilentTurn), so this is
    // the belt: a future change that starts sending `silent: true` alongside a
    // failure must not take the error notification with it.
    const { pane, runner } = await boot();
    runner.send(JSON.stringify({ t: 'turn-start' }));
    await settle();
    runner.send(JSON.stringify({ t: 'turn-done', ok: false, error: 'boom' }));
    await settle();
    expect(pushes.map(([id]) => id)).toEqual([pane.id]);
  });
});
