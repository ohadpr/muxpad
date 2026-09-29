import { closeSync, fstatSync, readdirSync, statSync } from 'node:fs';

/**
 * A tripwire for pty descriptors that belong to nobody.
 *
 * THIS IS NO LONGER THE FIX. The leak was in node-pty, and node-pty is pinned to
 * a version that does not have it (`1.2.0-beta.15`; see
 * `node-pty-fd-leak.test.ts` for the measurement and `docs/` history for why the
 * pin is exact rather than a caret). What remains here WATCHES, so that a
 * downgrade, a stale `node_modules`, or a new leak somewhere else shows up as a
 * loud line in the log instead of as a machine that cannot open a terminal.
 *
 * WHAT THE LEAK WAS. node-pty 1.1.0 lost THREE descriptors per spawn on darwin,
 * measured over 8 spawn/exit cycles with every child reaped and released:
 *
 *                            1.1.0     1.2.0-beta.15
 *     /dev/ptmx              +8        +0
 *     pty slave              +8        +0
 *     kqueue                 +8        +0
 *
 * All three are inside `pty_posix_spawn` / `SetupExitCallback` and none is
 * reachable from JS. The ptmx one is an off-by-one: the `low_fds` prologue opens
 * a throwaway pty to push the real master off fds 0-2, and cleanup reads
 * `for (; count > 0; count--) close(low_fds[count])` — which never closes index
 * 0, and in a running process (where the first `posix_openpt` already returns
 * >= 2) breaks with `count == 0` so the body never runs at all.
 *
 * On this machine that ceiling is `kern.tty.ptmx_max` — 511. Reached after a day
 * of ordinary use: 505 handles held, 72 ptys actually in use, and nothing on the
 * box able to open a terminal, an app or a browser again.
 *
 * WHY THIS ONLY OBSERVES NOW. Closing a descriptor by inference, inside the
 * daemon that owns every terminal on the machine, is a bad trade once the real
 * leak is gone: the failure mode of a wrong guess is somebody's live session,
 * and the thing it was buying is now bought at the source. It also could never
 * be complete — a kqueue is indistinguishable from the ones libuv opens for its
 * own reasons, so two of the three leaked descriptors were always out of reach.
 * So the default is to count and report. Set `MUXPAD_PTMX_SWEEP=close` to get
 * the old closing behaviour back, which is worth having if a leaky node-pty ever
 * has to be run on purpose.
 */

/** Open descriptor numbers for this process. Empty when the platform has no /dev/fd. */
export function openFds(dir = '/dev/fd'): number[] {
  try {
    return readdirSync(dir)
      .map(Number)
      .filter((n) => Number.isInteger(n));
  } catch {
    return [];
  }
}

export interface PtmxSweepDeps {
  /** Every descriptor currently open in this process. */
  open: readonly number[];
  /** The pty masters this daemon owns. Everything else is nobody's. */
  owned: ReadonlySet<number>;
  /** True when this descriptor is a character device on the pty driver. */
  isPtmx: (fd: number) => boolean;
}

/**
 * Which pty descriptors belong to nobody. Pure, so the rule that decides what
 * gets reported — and, in `close` mode, closed — can be tested without opening
 * anything.
 */
export function strayPtmxFds(deps: PtmxSweepDeps): number[] {
  return deps.open.filter((fd) => !deps.owned.has(fd) && deps.isPtmx(fd));
}

/**
 * The pty masters this process opened on purpose.
 *
 * PROCESS-WIDE, not module-scoped, and keyed by DEVICE as well as by descriptor
 * number. Both halves of that matter:
 *
 *   - One register per module INSTANCE is wrong wherever a process loads this
 *     twice — vitest gives every test file its own registry — because then one
 *     instance's live pty is absent from another instance's register and reads
 *     as "nobody's". In `close` mode that is one test file closing another's
 *     terminal. Production has a single instance, so the old design was correct
 *     by luck rather than by construction.
 *   - Descriptor numbers are RECYCLED. Keying on the number alone lets a fresh
 *     descriptor inherit a stale claim from whatever held that number before.
 *     The device is read from the same `fstat` the sweep already does, so this
 *     costs one extra `fstat` per pty CREATED and nothing per sweep.
 */
const REGISTER_KEY = Symbol.for('muxpad.ownedPtys');
type Register = Map<number, number>;
const globalStore = globalThis as unknown as Record<symbol, Register | undefined>;
if (!globalStore[REGISTER_KEY]) globalStore[REGISTER_KEY] = new Map<number, number>();
const register: Register = globalStore[REGISTER_KEY];

/** The device behind a descriptor, or null if it cannot be read. */
function deviceOf(fd: number): number | null {
  try {
    return fstatSync(fd).rdev;
  } catch {
    return null;
  }
}

/** Call with the master descriptor the moment a pty is created. */
export function ownPty(fd: number): void {
  if (!Number.isInteger(fd) || fd < 0) return;
  const dev = deviceOf(fd);
  if (dev === null) return;
  register.set(fd, dev);
}

/** Call when the pty is gone, so a recycled number is not mistaken for ours. */
export function disownPty(fd: number): void {
  register.delete(fd);
}

/** For tests and diagnostics. */
export function ownedPtyCount(): number {
  return register.size;
}

/**
 * The descriptors we still claim, as the sweep sees them: a number is only ours
 * while it still points at the device we claimed it for.
 */
export function ownedFdSet(devices: ReadonlyMap<number, number | null> = new Map()): Set<number> {
  const owned = new Set<number>();
  for (const [fd, dev] of register) {
    const seen = devices.has(fd) ? devices.get(fd) : dev;
    if (seen === dev) owned.add(fd);
  }
  return owned;
}

/** The major half of a device number — the driver, shared by all its clones. */
export function deviceMajor(rdev: number): number {
  return (rdev >> 24) & 0xff;
}

/**
 * Whether `fd` is one of the pty master devices.
 *
 * MAJOR ONLY. `/dev/ptmx` CLONES: every open produces a fresh device, so the
 * descriptors have different rdevs from the node and from each other. Measured
 * on one spawn —
 *
 *     /dev/ptmx   major 15  minor 149
 *     stray fd    major 15  minor 147
 *     the pty     major 15  minor 148
 *
 * — so comparing whole device numbers matches nothing at all, and an earlier
 * attempt that used it silently closed nothing while reporting success. The
 * driver is the thing they share.
 */
export function isPtmxFd(fd: number, ptmxMajor: number | null): boolean {
  if (ptmxMajor === null) return false;
  try {
    const st = fstatSync(fd);
    return st.isCharacterDevice() && deviceMajor(st.rdev) === ptmxMajor;
  } catch {
    return false;
  }
}

/** The pty driver's major number, or null where there is no /dev/ptmx. */
export function ptmxRdev(path = '/dev/ptmx'): number | null {
  try {
    return deviceMajor(statSync(path).rdev);
  } catch {
    return null;
  }
}

/** Counting only, or actually closing? Closing is opt-in — see the header. */
export function sweepMode(env: NodeJS.ProcessEnv = process.env): 'observe' | 'close' {
  return env.MUXPAD_PTMX_SWEEP === 'close' ? 'close' : 'observe';
}

export interface SweepResult {
  /** Pty descriptors in this process that nobody claims. */
  strays: number[];
  /** How many were closed. Always 0 in `observe` mode. */
  closed: number;
  mode: 'observe' | 'close';
}

/**
 * Looks for pty descriptors that belong to nobody.
 *
 * Failures are counted, not thrown: an exception here is a pane that never
 * starts, which is worse than any descriptor.
 */
export function sweepStrayPtmx(
  major: number | null = ptmxRdev(),
  mode: 'observe' | 'close' = sweepMode(),
): SweepResult {
  const open = openFds();
  // ONE fstat per open descriptor, answering both questions the sweep asks:
  // "is this a pty?" and "is this number still pointing where we claimed it?".
  const devices = new Map<number, number | null>();
  const isPty = new Map<number, boolean>();
  for (const fd of open) {
    try {
      const st = fstatSync(fd);
      devices.set(fd, st.rdev);
      isPty.set(fd, major !== null && st.isCharacterDevice() && deviceMajor(st.rdev) === major);
    } catch {
      devices.set(fd, null);
      isPty.set(fd, false);
    }
  }
  const strays = strayPtmxFds({
    open,
    owned: ownedFdSet(devices),
    isPtmx: (fd) => isPty.get(fd) === true,
  });
  let closed = 0;
  if (mode === 'close') {
    for (const fd of strays) {
      try {
        closeSync(fd);
        closed++;
      } catch {
        // Already gone, or not ours to close. Either way, not worth a pane.
      }
    }
  }
  return { strays, closed, mode };
}
