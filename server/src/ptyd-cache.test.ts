import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { PtydCache } from './ptyd-cache.js';
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
});
