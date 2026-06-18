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

  it('marks busy on paneActivity and decays to idle after busyQuietMs', async () => {
    // Busy policy lives here, not in ptyd: a raw activity tick → busy, and the
    // pane decays to idle busyQuietMs after the last tick. Short window so the
    // test is fast.
    const cache = new PtydCache({ busyQuietMs: 80 });
    const c = fakeClient();
    cache.attach(c);
    const changes: string[] = [];
    cache.on('paneChange', (id) => changes.push(id));

    (c as unknown as EventEmitter).emit('paneActivity', { id: 'p1' });
    expect(cache.getBusy('p1')).toBe(true);
    // A second tick within the window keeps it busy and emits no extra change.
    (c as unknown as EventEmitter).emit('paneActivity', { id: 'p1' });
    expect(cache.getBusy('p1')).toBe(true);

    await new Promise((r) => setTimeout(r, 140));
    expect(cache.getBusy('p1')).toBe(false);
    // Exactly two transitions reached consumers: busy:true then busy:false.
    expect(changes.filter((id) => id === 'p1')).toEqual(['p1', 'p1']);
  });

  it('clears the decay timer on paneExit so it cannot resurrect the entry', async () => {
    const cache = new PtydCache({ busyQuietMs: 60 });
    const c = fakeClient();
    cache.attach(c);
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
