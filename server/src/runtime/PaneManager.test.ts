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

  it('snapshotCwds returns current cwd for every live runtime', async () => {
    const mgr = new PaneManager();
    mgr.getOrCreate({ id: 's1', shell: '/bin/sh', startup_cmd: 'sleep 5', cwd: '/tmp' });
    mgr.getOrCreate({ id: 's2', shell: '/bin/sh', startup_cmd: 'sleep 5', cwd: '/tmp' });
    try {
      // Give the PTYs a brief moment to spawn so lsof can resolve their cwd.
      await new Promise((r) => setTimeout(r, 100));
      const snap = mgr.snapshotCwds();
      const ids = snap.map((e) => e.id).sort();
      expect(ids).toEqual(['s1', 's2']);
      for (const entry of snap) {
        expect(typeof entry.cwd).toBe('string');
        expect(entry.cwd.length).toBeGreaterThan(0);
      }
    } finally {
      await mgr.killAll();
    }
  });

  it('snapshotCwds returns empty when no runtimes exist', () => {
    const mgr = new PaneManager();
    expect(mgr.snapshotCwds()).toEqual([]);
    return mgr.killAll();
  });
});

describe('PaneManager → raw change callbacks (no PaneStore)', () => {
  // These tests prove the new onPaneChange/onPaneExit callbacks fire
  // independently of the EventBus + PaneStore path. They mirror the
  // ptyd usage shape: the daemon has no db, only the manager + callbacks.

  it('fires onPaneChange with kind:title when an OSC title is set', async () => {
    type Change = { id: string; kind: string; title?: string | null; cmd?: string | null; attention?: boolean };
    const changes: Change[] = [];
    const mgr = new PaneManager({
      cmdPollInterval: 50,
      onPaneChange: (id, change) => {
        changes.push({ id, ...change });
      },
    });
    const runtime = mgr.getOrCreate({
      id: 't1',
      shell: '/bin/sh',
      startup_cmd: `printf '\\033]2;raw-title\\007'`,
      cwd: '/tmp',
    });
    try {
      await new Promise((r) => setTimeout(r, 300));
      expect(runtime.getCurrentTitle()).toBe('raw-title');
      const titleChange = changes.find(
        (c) => c.id === 't1' && c.kind === 'title' && c.title === 'raw-title',
      );
      expect(titleChange).toBeDefined();
    } finally {
      await mgr.killAll();
    }
  });

  it('fires onPaneChange with kind:fg when the foreground command resolves', async () => {
    type Change = { id: string; kind: string; cmd?: string | null };
    const changes: Change[] = [];
    const mgr = new PaneManager({
      cmdPollInterval: 50,
      onPaneChange: (id, change) => {
        if (change.kind === 'fg') changes.push({ id, kind: change.kind, cmd: change.cmd });
      },
    });
    mgr.getOrCreate({ id: 'fg1', shell: '/bin/sh', startup_cmd: 'sleep 5', cwd: '/tmp' });
    try {
      // Wait long enough for at least a couple of 50ms cmd-poll ticks.
      await new Promise((r) => setTimeout(r, 400));
      const fgChange = changes.find((c) => c.id === 'fg1' && typeof c.cmd === 'string');
      expect(fgChange).toBeDefined();
    } finally {
      await mgr.killAll();
    }
  });

  it('fires onPaneChange with kind:attention when a BEL flips needsAttention', async () => {
    type Change = { id: string; kind: string; attention?: boolean };
    const changes: Change[] = [];
    const mgr = new PaneManager({
      cmdPollInterval: 50,
      onPaneChange: (id, change) => {
        if (change.kind === 'attention') {
          changes.push({ id, kind: change.kind, attention: change.attention });
        }
      },
    });
    const runtime = mgr.getOrCreate({
      id: 'a1',
      shell: '/bin/sh',
      startup_cmd: `printf '\\007'`,
      cwd: '/tmp',
    });
    try {
      await new Promise((r) => setTimeout(r, 300));
      expect(runtime.getNeedsAttention()).toBe(true);
      const attChange = changes.find(
        (c) => c.id === 'a1' && c.kind === 'attention' && c.attention === true,
      );
      expect(attChange).toBeDefined();
    } finally {
      await mgr.killAll();
    }
  });

  it('does not re-fire onPaneChange when the value is unchanged across ticks', async () => {
    // Regression for the diff-emit invariant: the manager's lastTitle /
    // lastFg / lastAttention maps must suppress redundant callbacks across
    // consecutive cmd-poll ticks. A previous bug emitted on every tick,
    // which (via PtydCache → pane.updated) fanned a fresh event out to
    // every browser even when nothing had actually changed.
    type Change = { id: string; kind: string; title?: string | null; cmd?: string | null; attention?: boolean };
    const changes: Change[] = [];
    const mgr = new PaneManager({
      // Short poll so we observe at least two ticks well within the test
      // timeout. The OSC title is set by the startup_cmd before the first
      // tick, so the first tick fires `title` and the rest must not.
      cmdPollInterval: 50,
      onPaneChange: (id, change) => {
        changes.push({ id, ...change });
      },
    });
    const runtime = mgr.getOrCreate({
      id: 'diff1',
      shell: '/bin/sh',
      // Set a stable OSC title then sleep long enough to span multiple
      // cmd-poll ticks. The title doesn't change after the printf.
      startup_cmd: `printf '\\033]2;diff-title\\007'; sleep 5`,
      cwd: '/tmp',
    });
    try {
      // Wait for ~6 ticks so we are well past the first emit. Any
      // non-suppressed re-fire would have piled up by now.
      await new Promise((r) => setTimeout(r, 350));
      expect(runtime.getCurrentTitle()).toBe('diff-title');

      const titleEvents = changes.filter(
        (c) => c.id === 'diff1' && c.kind === 'title' && c.title === 'diff-title',
      );
      // The first tick fires; every subsequent tick with the same value
      // must be suppressed. Exactly one event for this title.
      expect(titleEvents).toHaveLength(1);
    } finally {
      await mgr.killAll();
    }
  });

  it('fires onPaneExit with cause:natural when the pty exits on its own', async () => {
    const exits: Array<{ id: string; code: number; cause: string }> = [];
    const mgr = new PaneManager({
      onPaneExit: (id, code, cause) => exits.push({ id, code, cause }),
    });
    mgr.getOrCreate({ id: 'e1', shell: '/bin/sh', startup_cmd: 'exit 0', cwd: '/tmp' });
    // Wait for natural exit; killAll just cleans up timers.
    await new Promise((r) => setTimeout(r, 500));
    const exit = exits.find((e) => e.id === 'e1');
    expect(exit).toBeDefined();
    expect(exit?.cause).toBe('natural');
    await mgr.killAll();
  });

  it('fires onPaneExit with cause:killed when killPane is invoked', async () => {
    const exits: Array<{ id: string; code: number; cause: string }> = [];
    const mgr = new PaneManager({
      onPaneExit: (id, code, cause) => exits.push({ id, code, cause }),
    });
    mgr.getOrCreate({ id: 'e2', shell: '/bin/sh', startup_cmd: 'sleep 30', cwd: '/tmp' });
    await mgr.kill('e2');
    const exit = exits.find((e) => e.id === 'e2');
    expect(exit).toBeDefined();
    expect(exit?.cause).toBe('killed');
    await mgr.killAll();
  });
});
