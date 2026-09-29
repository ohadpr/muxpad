// THE SIDEBAR MUST NOT WAIT FOR ptyd.
//
// `POST /api/tabs` is the web app's entire create path, and the web app cannot
// navigate to a new chat until it answers. It used to answer only after ptyd
// acknowledged the eager pty spawn — and that acknowledgement is gated on a
// synchronous pty fork on ptyd's single event loop, so it is fast when ptyd is
// idle and arbitrarily slow when it is not. Measured against the live cockpit:
// 0.03s idle, 19.5s and 38.6s under load, for a request whose row work is
// 4–90ms. The user's report was "create new tab just many many seconds", and
// this is all of it.
//
// bootstrapTab now STARTS the spawn eagerly and stops WAITING for it after
// EAGER_SPAWN_WAIT_MS. These tests pin both halves of that: the cap actually
// caps, and the spawn is still asked for (and still asked for with the right
// spec) when it does not answer in time.
import type { PaneSpec } from '@muxpad/shared';
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { bootstrapTab } from './agent-tab.js';
import { EventBus } from './events.js';
import { PtydCache } from './ptyd-cache.js';
import type { PtydClient } from './ptyd-client/PtydClient.js';
import { WorkspaceStore } from './store/WorkspaceStore.js';
import { openDb } from './store/db.js';

/** Resolve after `ms`, for racing against the production cap. */
const after = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface Harness {
  db: Database.Database;
  ptyd: PtydClient;
  cache: PtydCache;
  events: EventBus;
  /** Every spec ptyd was asked to ensure, in order. */
  ensured: PaneSpec[];
  wsId: string;
}

let open: Array<() => void> = [];
afterEach(() => {
  for (const c of open) c();
  open = [];
});

/** `ensureDelay` is how long the stub ptyd takes to acknowledge a spawn. */
function harness(ensureDelay: number): Harness {
  const db = openDb(':memory:');
  open.push(() => db.close());
  const ensured: PaneSpec[] = [];
  const ptyd = {
    socketPath: '/tmp/muxpad-agent-tab-test.sock',
    ensurePane: async (spec: PaneSpec) => {
      ensured.push(spec);
      await after(ensureDelay);
    },
    killPane: async () => {},
    getForegroundCommand: async () => null,
    on: () => {},
  } as unknown as PtydClient;
  return {
    db,
    ptyd,
    cache: new PtydCache(),
    events: new EventBus(),
    ensured,
    wsId: new WorkspaceStore(db).create({ name: 'W' }).id,
  };
}

const agentTab = (h: Harness) =>
  bootstrapTab(h, {
    workspace_id: h.wsId,
    name: 'New chat',
    bootstrap: 'agent',
    backend: 'claude',
    mode: 'chat',
  });

describe('bootstrapTab does not hold the response open for the pty spawn', () => {
  it('answers well before a ptyd that takes seconds to acknowledge', async () => {
    const h = harness(5_000);
    const started = Date.now();
    const created = await agentTab(h);
    const elapsed = Date.now() - started;
    // The cap is 250ms. A generous ceiling here so the assertion is about
    // "did not wait for ptyd" (5s) rather than about timer precision.
    expect(elapsed).toBeLessThan(2_000);
    // …and the rows are real, not a placeholder the caller has to reconcile.
    expect(created.tab.id).toBeTruthy();
    expect(created.tab.slug).toBeTruthy();
    expect(created.pane?.face).toBe('chat');
  });

  it('still ASKS for the spawn, with the pane it just created', async () => {
    // The cap must not have turned the eager spawn into no spawn. Nothing else
    // starts a chat-face pane — its client attaches to /ws/chat, never to the
    // pty — so a dropped ensurePane is a permanently dead chat.
    const h = harness(5_000);
    const created = await agentTab(h);
    expect(h.ensured).toHaveLength(1);
    expect(h.ensured[0]?.id).toBe(created.pane?.id);
    expect(h.ensured[0]?.startup_cmd).toBe('muxpad agent --mode chat');
    expect(h.ensured[0]?.tab_id).toBe(created.tab.id);
  });

  it('emits tab.added before it answers, so the sidebar can paint immediately', async () => {
    const h = harness(5_000);
    const seen: string[] = [];
    h.events.subscribe((e) => seen.push(e.type));
    const created = await agentTab(h);
    // Both structural events are out by the time the caller is resumed — the
    // web client's `tab.added` handler is what keeps every other surface
    // (corpus, workspace rollup) in step with the row it navigates to.
    expect(seen).toContain('tab.added');
    expect(seen).toContain('pane.added');
    expect(created.tab.id).toBeTruthy();
  });

  it('a ptyd that never answers at all is still not fatal', async () => {
    // The pre-existing contract: ptyd unreachable → rows commit anyway. It used
    // to be a swallowed `await`; it is now a swallowed rejection on a promise
    // nobody holds, which is the easier one to get wrong (an unhandled
    // rejection takes the server down).
    const h = harness(0);
    (h.ptyd as unknown as { ensurePane: () => Promise<void> }).ensurePane = () =>
      Promise.reject(new Error('ptyd disconnected'));
    const created = await agentTab(h);
    expect(created.tab.id).toBeTruthy();
    expect(created.pane).not.toBeNull();
    // Give the rejection a tick to go unhandled if it is going to.
    await after(10);
  });

  it('an idle ptyd is answered at its own speed, not at the cap', async () => {
    // The cap is a ceiling, not a delay. This is what keeps the common case
    // honest — and what keeps the pty genuinely present by the time the client
    // lands, which is the assumption ChatPane's no-session grace rests on.
    const h = harness(0);
    const started = Date.now();
    await agentTab(h);
    expect(Date.now() - started).toBeLessThan(200);
  });
});
