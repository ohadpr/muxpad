import { describe, it, expect } from 'vitest';
import { PaneManager } from './PaneManager.js';

describe('PaneManager', () => {
  it('lazily creates a runtime on first access and reuses it', () => {
    const mgr = new PaneManager();
    const r = mgr.getOrCreate({
      id: 'p1',
      shell: '/bin/sh',
      startup_cmd: 'sleep 1',
      cwd: '/tmp',
    });
    expect(r).toBeTruthy();
    expect(mgr.getOrCreate({ id: 'p1', shell: '/bin/sh', cwd: '/tmp' })).toBe(r);
    return mgr.killAll();
  });

  it('removes a runtime after explicit kill', async () => {
    const mgr = new PaneManager();
    mgr.getOrCreate({ id: 'p2', shell: '/bin/sh', startup_cmd: 'sleep 5', cwd: '/tmp' });
    await mgr.kill('p2');
    expect(mgr.has('p2')).toBe(false);
  });

  it('removes a runtime after natural exit', async () => {
    const mgr = new PaneManager();
    const r = mgr.getOrCreate({
      id: 'p3',
      shell: '/bin/sh',
      startup_cmd: 'exit 0',
      cwd: '/tmp',
    });
    await new Promise<void>((resolve) => r.on('exit', () => resolve()));
    expect(mgr.has('p3')).toBe(false);
  });

  it('killAll terminates everything', async () => {
    const mgr = new PaneManager();
    mgr.getOrCreate({ id: 'a', shell: '/bin/sh', startup_cmd: 'sleep 5', cwd: '/tmp' });
    mgr.getOrCreate({ id: 'b', shell: '/bin/sh', startup_cmd: 'sleep 5', cwd: '/tmp' });
    await mgr.killAll();
    expect(mgr.has('a')).toBe(false);
    expect(mgr.has('b')).toBe(false);
  });
});
