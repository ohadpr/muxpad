import { readdirSync } from 'node:fs';
import * as pty from 'node-pty';
import { describe, expect, it } from 'vitest';
import { releasePtyHandle } from './PaneRuntime.js';

/**
 * Does node-pty give every descriptor back when a pane's life is over?
 *
 * This is a test of the LIBRARY, not of muxpad, and it is here because getting
 * the answer wrong bricked the machine: ptyd held 505 handles against a
 * `kern.tty.ptmx_max` of 511 and nothing on the box could open a terminal, an
 * app or a browser again.
 *
 * node-pty 1.1.0 leaks THREE descriptors per spawn on darwin, all inside
 * `pty_posix_spawn` / `SetupExitCallback` and none of them reachable from JS:
 *
 *   1. one `/dev/ptmx` — the `low_fds` prologue opens a throwaway pty to push
 *      the real master off fds 0-2, and the cleanup loop
 *      `for (; count > 0; count--) close(low_fds[count])` never closes index 0.
 *      In a running process the first `posix_openpt` already returns >= 2, so it
 *      breaks with `count == 0` and the body never runs at all.
 *   2. one pty SLAVE — opened in the parent, and `posix_spawn_file_actions_addclose`
 *      only closes it in the child. Shows up as `/dev/ttysNNN` while the pane
 *      lives and `(revoked)` once the device is torn down.
 *   3. one KQUEUE — the exit watcher's `kqueue()` is never closed after the
 *      child is reaped.
 *
 * Measured, 8 spawn/exit cycles, each child fully exited and `destroy()`ed:
 *
 *              1.1.0                    1.2.0-beta.15
 *     ptmx     +8                       +0
 *     slave    +8  (as "(revoked)")     +0
 *     kqueue   +8                       +0
 *
 * So this counts ALL of the process's descriptors rather than just the pty ones.
 * Only two of the three are pty devices, and the sweep in `ptmx-leak.ts` can
 * reach exactly one of them — a kqueue is indistinguishable from the ones libuv
 * opens for its own reasons, so there is no ownership rule that could safely
 * close it. Nothing but a fixed node-pty closes all three.
 */

const DARWIN = process.platform === 'darwin';

/** How many descriptors this process holds, of every kind. */
const openFdCount = () => readdirSync('/dev/fd').length;

/** One pane's whole life: spawn, run to completion, reap, release. */
async function spawnAndExit(): Promise<void> {
  const term = pty.spawn('/bin/sh', ['-c', 'exit 0'], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: '/tmp',
    env: process.env as Record<string, string>,
  });
  term.onData(() => {});
  await new Promise<void>((resolve) => term.onExit(() => resolve()));
  // Same release the runtime does, and duck-typed for the same reason: `destroy`
  // is on the concrete UnixTerminal, not on the `IPty` interface we hold.
  releasePtyHandle(term);
  // The exit watcher closes its side on a separate thread, after the reap.
  await new Promise((r) => setTimeout(r, 200));
}

describe.runIf(DARWIN)('node-pty descriptor accounting', () => {
  it('gives every descriptor back when a pane has lived and died', async () => {
    // One cycle first, so lazy native init is not counted as a leak.
    await spawnAndExit();
    const before = openFdCount();

    const cycles = 5;
    for (let i = 0; i < cycles; i++) await spawnAndExit();

    const after = openFdCount();
    // 1.1.0 leaks 3 per cycle — +15 here. The slack is for unrelated churn in
    // the test runner, not for a per-spawn leak: any of those is >= +5.
    expect(after - before).toBeLessThanOrEqual(2);
  }, 30_000);
});
