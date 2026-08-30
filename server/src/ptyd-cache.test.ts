import { EventEmitter } from 'node:events';
import type { PaneSpec } from '@muxpad/shared';
import { describe, expect, it } from 'vitest';
import { PtydCache, decoratePane } from './ptyd-cache.js';
import type { PtydClient } from './ptyd-client/PtydClient.js';

// We don't need a real PtydClient for unit tests — only the EventEmitter
// surface PtydCache uses. Cast a bare emitter as PtydClient + a stub
// flushCwds so attach() compiles.
function fakeClient(initialCwds: Array<{ id: string; cwd: string }> = []): PtydClient {
  const e = new EventEmitter() as EventEmitter & { flushCwds: () => Promise<typeof initialCwds> };
  e.flushCwds = async () => initialCwds;
  return e as unknown as PtydClient;
}

describe('PtydCache', () => {
  it('updates cwd on paneCwd event and exposes it synchronously', () => {
    const cache = new PtydCache();
    const c = fakeClient();
    cache.attach(c);
    (c as unknown as EventEmitter).emit('paneCwd', { id: 'p1', cwd: '/tmp' });
    expect(cache.getCwd('p1')).toBe('/tmp');
  });

  it('updates fg on paneFg and exposes synchronously', () => {
    const cache = new PtydCache();
    const c = fakeClient();
    cache.attach(c);
    (c as unknown as EventEmitter).emit('paneFg', { id: 'p1', cmd: 'vim' });
    expect(cache.getFg('p1')).toBe('vim');
  });

  it('updates title and attention', () => {
    const cache = new PtydCache();
    const c = fakeClient();
    cache.attach(c);
    (c as unknown as EventEmitter).emit('paneTitle', { id: 'p1', title: 'hello' });
    (c as unknown as EventEmitter).emit('paneAttention', { id: 'p1', attention: true });
    expect(cache.getTitle('p1')).toBe('hello');
    expect(cache.getAttention('p1')).toBe(true);
  });

  it('marks busy once output is sustained past warmup, then decays to idle', async () => {
    // Busy policy lives here, not in ptyd. Warmup: the first tick only starts
    // warming up; busy flips true once activity persists past busyWarmupMs.
    // Then it decays to idle busyQuietMs after the last tick. Short windows so
    // the test is fast.
    const cache = new PtydCache({ busyQuietMs: 120, busyWarmupMs: 40 });
    const c = fakeClient();
    cache.attach(c);
    const changes: string[] = [];
    cache.on('paneChange', (id) => changes.push(id));

    // First tick: warming up, not busy yet.
    (c as unknown as EventEmitter).emit('paneActivity', { id: 'p1' });
    expect(cache.getBusy('p1')).toBe(false);

    // A later tick, past the warmup window → real work → busy.
    await new Promise((r) => setTimeout(r, 55));
    (c as unknown as EventEmitter).emit('paneActivity', { id: 'p1' });
    expect(cache.getBusy('p1')).toBe(true);

    await new Promise((r) => setTimeout(r, 200));
    expect(cache.getBusy('p1')).toBe(false);
    // Exactly two transitions reached consumers: busy:true then busy:false.
    expect(changes.filter((id) => id === 'p1')).toEqual(['p1', 'p1']);
  });

  it('does not blip busy for a single transient burst (e.g. a tab-open redraw)', async () => {
    const cache = new PtydCache({ busyQuietMs: 60, busyWarmupMs: 40 });
    const c = fakeClient();
    cache.attach(c);
    const changes: string[] = [];
    cache.on('paneChange', (id) => changes.push(id));
    // One lone tick, then silence — never qualifies as busy.
    (c as unknown as EventEmitter).emit('paneActivity', { id: 'p1' });
    expect(cache.getBusy('p1')).toBe(false);
    await new Promise((r) => setTimeout(r, 90));
    expect(cache.getBusy('p1')).toBe(false);
    expect(changes.filter((id) => id === 'p1')).toEqual([]); // no transitions emitted
  });

  it('discounts echo: activity right after user input does not trip busy', async () => {
    // Typing echoes back as output; that echo must not light the spinner.
    const cache = new PtydCache({ busyQuietMs: 300, busyWarmupMs: 30, busyInputGraceMs: 80 });
    const c = fakeClient();
    cache.attach(c);
    // Simulate the user typing: each keystroke notes input, then its echo
    // arrives as an activity tick. All within the input-grace window.
    for (let i = 0; i < 4; i++) {
      cache.noteInput('p1');
      (c as unknown as EventEmitter).emit('paneActivity', { id: 'p1' });
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(cache.getBusy('p1')).toBe(false);

    // Now the app works on its own (no further input). Once activity sustains
    // past the grace + warmup, it trips busy normally.
    await new Promise((r) => setTimeout(r, 120)); // let input grace lapse
    (c as unknown as EventEmitter).emit('paneActivity', { id: 'p1' });
    await new Promise((r) => setTimeout(r, 50));
    (c as unknown as EventEmitter).emit('paneActivity', { id: 'p1' });
    expect(cache.getBusy('p1')).toBe(true);
  });

  it('clears decay/warmup state on paneExit so it cannot resurrect the entry', async () => {
    const cache = new PtydCache({ busyQuietMs: 60, busyWarmupMs: 20 });
    const c = fakeClient();
    cache.attach(c);
    (c as unknown as EventEmitter).emit('paneActivity', { id: 'p1' });
    await new Promise((r) => setTimeout(r, 30));
    (c as unknown as EventEmitter).emit('paneActivity', { id: 'p1' });
    expect(cache.getBusy('p1')).toBe(true);
    (c as unknown as EventEmitter).emit('paneExit', { id: 'p1', code: 0, cause: 'natural' });
    // Past when the decay timer would have fired update({busy:false}).
    await new Promise((r) => setTimeout(r, 100));
    expect(cache.get('p1')).toBeUndefined();
  });

  it('drops entry on paneExit and emits paneRemoved', () => {
    const cache = new PtydCache();
    const c = fakeClient();
    cache.attach(c);
    (c as unknown as EventEmitter).emit('paneCwd', { id: 'p1', cwd: '/tmp' });
    const removed: string[] = [];
    cache.on('paneRemoved', (id) => removed.push(id));
    (c as unknown as EventEmitter).emit('paneExit', { id: 'p1', code: 0, cause: 'natural' });
    expect(cache.getCwd('p1')).toBeNull();
    expect(removed).toEqual(['p1']);
  });

  it('emits paneChange only when a field actually changes', () => {
    const cache = new PtydCache();
    const c = fakeClient();
    cache.attach(c);
    const changes: string[] = [];
    cache.on('paneChange', (id) => changes.push(id));
    (c as unknown as EventEmitter).emit('paneCwd', { id: 'p1', cwd: '/tmp' });
    (c as unknown as EventEmitter).emit('paneCwd', { id: 'p1', cwd: '/tmp' });
    expect(changes).toEqual(['p1']);
  });

  it('seeds cwd via flushCwds on connected', async () => {
    const cache = new PtydCache();
    const c = fakeClient([{ id: 'p1', cwd: '/tmp/seed' }]);
    cache.attach(c);
    (c as unknown as EventEmitter).emit('connected');
    // flushCwds is async; let it resolve.
    await new Promise((r) => setImmediate(r));
    expect(cache.getCwd('p1')).toBe('/tmp/seed');
  });

  it('seedCwds primes lookup before any event arrives and a real event supersedes the seed', () => {
    const cache = new PtydCache();
    const c = fakeClient();
    cache.attach(c);
    // No events yet — seed from "SQLite".
    cache.seedCwds([
      { id: 'p1', cwd: '/seed/one' },
      { id: 'p2', cwd: '/seed/two' },
    ]);
    expect(cache.getCwd('p1')).toBe('/seed/one');
    expect(cache.getCwd('p2')).toBe('/seed/two');
    // A real paneCwd event for p1 wins over the seed.
    (c as unknown as EventEmitter).emit('paneCwd', { id: 'p1', cwd: '/live/one' });
    expect(cache.getCwd('p1')).toBe('/live/one');
    // Re-seeding does NOT overwrite a value already in the cache (event
    // arrived first → seedCwds is a no-op for that id).
    cache.seedCwds([{ id: 'p1', cwd: '/seed/stale' }]);
    expect(cache.getCwd('p1')).toBe('/live/one');
  });

  it('forget() drops the entry and emits paneRemoved', () => {
    const cache = new PtydCache();
    const c = fakeClient();
    cache.attach(c);
    (c as unknown as EventEmitter).emit('paneCwd', { id: 'p1', cwd: '/tmp' });
    const removed: string[] = [];
    cache.on('paneRemoved', (id) => removed.push(id));
    cache.forget('p1');
    expect(removed).toEqual(['p1']);
    cache.forget('p1');
    expect(removed).toEqual(['p1']); // idempotent
  });

  it('setAgentBusy makes a pane busy with zero PTY activity and fans paneChange edges', () => {
    // A headless chat turn writes the transcript file, not the PTY — the
    // activity detector never sees it. setAgentBusy is what lights the
    // tab/workspace spinner for chat work.
    const cache = new PtydCache();
    const c = fakeClient();
    cache.attach(c);
    const changes: string[] = [];
    cache.on('paneChange', (id) => changes.push(id));
    expect(cache.getBusy('p1')).toBe(false);
    cache.setAgentBusy('p1', true);
    expect(cache.getBusy('p1')).toBe(true);
    cache.setAgentBusy('p1', true); // idempotent — no duplicate event
    cache.setAgentBusy('p1', false);
    expect(cache.getBusy('p1')).toBe(false);
    expect(changes).toEqual(['p1', 'p1']); // exactly the true and false edges
  });

  it('agent busy composes with PTY busy: no spurious edges while the other holds it', async () => {
    const cache = new PtydCache({ busyQuietMs: 120, busyWarmupMs: 20 });
    const c = fakeClient();
    cache.attach(c);
    // Drive PTY busy true first.
    (c as unknown as EventEmitter).emit('paneActivity', { id: 'p1' });
    await new Promise((r) => setTimeout(r, 30));
    (c as unknown as EventEmitter).emit('paneActivity', { id: 'p1' });
    expect(cache.getBusy('p1')).toBe(true);
    const changes: string[] = [];
    cache.on('paneChange', (id) => changes.push(id));
    // Agent turn starts and ends while PTY busy holds — effective busy never
    // flips, so no agent-driven edges fan out.
    cache.setAgentBusy('p1', true);
    cache.setAgentBusy('p1', false);
    expect(changes).toEqual([]);
    // Now agent busy holds through the PTY decay: still busy after quiet.
    cache.setAgentBusy('p1', true);
    await new Promise((r) => setTimeout(r, 200));
    expect(cache.getBusy('p1')).toBe(true); // PTY decayed; agent turn holds it
    cache.setAgentBusy('p1', false);
    expect(cache.getBusy('p1')).toBe(false);
  });

  it('forget() clears agent busy so a recreated pane id starts clean', () => {
    const cache = new PtydCache();
    cache.setAgentBusy('p1', true);
    expect(cache.getBusy('p1')).toBe(true);
    cache.forget('p1');
    expect(cache.getBusy('p1')).toBe(false);
  });

  it('decoratePane stamps busy from an agent turn (the tab/workspace rollup source)', () => {
    const cache = new PtydCache();
    const pane: PaneSpec = {
      id: 'p1',
      tab_id: 't1',
      kind: 'shell',
      url: null,
      shell: '/bin/zsh',
      startup_cmd: null,
      mode: 'deep',
      cwd: '/tmp',
      env: null,
      face: 'terminal',
      face_url: null,
      created_at: 0,
    };
    expect(decoratePane(cache, pane).busy).toBe(false);
    cache.setAgentBusy('p1', true);
    expect(decoratePane(cache, pane).busy).toBe(true);
  });

  it('a live subagent roster holds busy with NO decay window, and is count-edge-triggered', async () => {
    // Replaces the old 15s-decay poke. Measured (P1, 2026-08): a background
    // subagent parked in one tool call goes 44s+ without a frame while alive,
    // so any decay window evicts a running agent. Membership now has real
    // launch/finish edges and no timer at all.
    const cache = new PtydCache();
    const events: string[] = [];
    cache.on('paneChange', (id: string) => events.push(id));

    cache.setSubagentCount('p1', 1);
    expect(cache.getBusy('p1')).toBe(true);
    expect(cache.getSubagentCount('p1')).toBe(1);
    expect(events).toEqual(['p1']);

    // The runner's keepalive re-announces the SAME roster — no event, no churn.
    cache.setSubagentCount('p1', 1);
    expect(events).toEqual(['p1']);

    // A second subagent IS a visible change (the badge shows the number).
    cache.setSubagentCount('p1', 2);
    expect(events).toEqual(['p1', 'p1']);

    // Long silence changes nothing — there is no window to expire.
    await new Promise((r) => setTimeout(r, 80));
    expect(cache.getBusy('p1')).toBe(true);

    // Only an explicit empty roster clears it.
    cache.setSubagentCount('p1', 0);
    expect(cache.getBusy('p1')).toBe(false);
    expect(cache.getSubagentCount('p1')).toBe(0);
    expect(events).toEqual(['p1', 'p1', 'p1']);
  });

  it('the roster ORs with agent-turn busy, and outlives turn-done', () => {
    // The exact D3 shape: the turn ends, the background subagent does not.
    const cache = new PtydCache();
    cache.setAgentBusy('p1', true);
    cache.setSubagentCount('p1', 1);
    expect(cache.getBusy('p1')).toBe(true);
    cache.setAgentBusy('p1', false);
    expect(cache.getBusy('p1')).toBe(true);
    cache.forget('p1');
    expect(cache.getBusy('p1')).toBe(false);
    expect(cache.getSubagentCount('p1')).toBe(0);
  });
});

describe('the five-state status model', () => {
  const pane = (over: Partial<PaneSpec> = {}): PaneSpec => ({
    id: 'p1',
    tab_id: 't1',
    kind: 'shell',
    url: null,
    shell: '/bin/zsh',
    startup_cmd: null,
    mode: 'deep',
    cwd: '/tmp',
    env: null,
    face: 'terminal',
    face_url: null,
    created_at: 0,
    ...over,
  });

  it('evaluates the documented precedence', () => {
    const cache = new PtydCache();
    expect(cache.getStatus('p1', false)).toBe('idle');

    // done ← the persisted unread flag
    expect(cache.getStatus('p1', true)).toBe('done');

    // dead outranks done (see STATUS_ORDER's note): a crash must not be
    // masked by an unread turn
    cache.setDead('p1', true);
    expect(cache.getStatus('p1', false)).toBe('dead');
    expect(cache.getStatus('p1', true)).toBe('dead');

    // working outranks both
    cache.setAgentBusy('p1', true);
    expect(cache.getStatus('p1', true)).toBe('working');

    // blocked outranks everything
    cache.setBlocked('p1', true);
    expect(cache.getStatus('p1', true)).toBe('blocked');

    cache.setBlocked('p1', false);
    expect(cache.getStatus('p1', true)).toBe('working');
  });

  it('gates the pty heuristic to RUNNER-LESS panes (D4)', async () => {
    // The rest of the codebase already tells agents never to trust `busy` for
    // turn state. This makes the sidebar agree: on a runner-owned pane, pty
    // output is not a status source at all — so `tail -f` in an agent pane's
    // terminal face no longer spins forever, and a silently-thinking agent no
    // longer reads idle.
    const cache = new PtydCache({ busyQuietMs: 200, busyWarmupMs: 20 });
    const c = fakeClient();
    cache.attach(c);
    const tick = () => (c as unknown as EventEmitter).emit('paneActivity', { id: 'p1' });

    tick();
    await new Promise((r) => setTimeout(r, 30));
    tick();
    // No runner → the heuristic still speaks for the pane.
    expect(cache.getStatus('p1', false)).toBe('working');

    // A runner attaches: pty output stops counting, and the flip itself is an
    // edge the nav must be told about.
    const changes: string[] = [];
    cache.on('paneChange', (id: string) => changes.push(id));
    cache.setRunnerOwned('p1', true);
    expect(cache.getStatus('p1', false)).toBe('idle');
    expect(changes).toEqual(['p1']);

    // …and the registry now speaks for it instead.
    cache.setAgentBusy('p1', true);
    expect(cache.getStatus('p1', false)).toBe('working');
  });

  it('the echo gate suppresses the RISE but never ends a running spell (D6)', async () => {
    // Typing into an ALREADY-BUSY pane used to starve the decay re-arm: the
    // echo check returned before the timer block, so busy expired
    // busyQuietMs later while the app was still streaming.
    const cache = new PtydCache({ busyQuietMs: 150, busyWarmupMs: 20, busyInputGraceMs: 100 });
    const c = fakeClient();
    cache.attach(c);
    const tick = () => (c as unknown as EventEmitter).emit('paneActivity', { id: 'p1' });

    // Typing alone never trips busy.
    cache.noteInput('p1');
    tick();
    await new Promise((r) => setTimeout(r, 25));
    cache.noteInput('p1');
    tick();
    expect(cache.getBusy('p1')).toBe(false);

    // Real output (no recent keystroke) crosses the warmup.
    await new Promise((r) => setTimeout(r, 120));
    tick();
    await new Promise((r) => setTimeout(r, 30));
    tick();
    expect(cache.getBusy('p1')).toBe(true);

    // Now type continuously while the app keeps streaming. Every tick lands
    // inside the input grace — the old code dropped them all and let busy
    // expire mid-work.
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, 60));
      cache.noteInput('p1');
      tick();
    }
    expect(cache.getBusy('p1')).toBe(true);

    // Output really stops → it decays normally.
    await new Promise((r) => setTimeout(r, 220));
    expect(cache.getBusy('p1')).toBe(false);
  });

  it('…but echo can only SUSTAIN a spell for a bounded window', async () => {
    // Ticks are indistinguishable at this layer, so "the app is streaming while
    // you type" and "the app went quiet while you type" look identical. The
    // sustain is therefore capped past the last NON-echo tick — otherwise
    // steady typing would hold a quiet pane `working` indefinitely.
    const cache = new PtydCache({
      busyQuietMs: 150,
      busyWarmupMs: 20,
      busyInputGraceMs: 100,
      busyEchoSustainMs: 200,
    });
    const c = fakeClient();
    cache.attach(c);
    const tick = () => (c as unknown as EventEmitter).emit('paneActivity', { id: 'p1' });

    // Get genuinely busy off real output.
    tick();
    await new Promise((r) => setTimeout(r, 30));
    tick();
    expect(cache.getBusy('p1')).toBe(true);

    // Type steadily, with NO further real output, past the sustain cap.
    for (let i = 0; i < 8; i++) {
      await new Promise((r) => setTimeout(r, 50));
      cache.noteInput('p1');
      tick();
    }
    await new Promise((r) => setTimeout(r, 200));
    expect(cache.getBusy('p1')).toBe(false);
  });

  it('decoratePane carries status + agents, with busy as an exact alias', () => {
    const cache = new PtydCache();
    expect(decoratePane(cache, pane())).toMatchObject({ status: 'idle', busy: false, agents: 0 });

    cache.setSubagentCount('p1', 2);
    const working = decoratePane(cache, pane());
    expect(working.status).toBe('working');
    expect(working.busy).toBe(true);
    expect(working.agents).toBe(2);

    cache.setSubagentCount('p1', 0);
    expect(decoratePane(cache, pane({ unread: true })).status).toBe('done');

    // `attention` keeps its ORIGINAL meaning (raw BEL), deliberately — a
    // question-blocked pane must not re-trigger the attention push.
    cache.setBlocked('p1', true);
    const blocked = decoratePane(cache, pane());
    expect(blocked.status).toBe('blocked');
    expect(blocked.attention).toBe(false);
  });
});
