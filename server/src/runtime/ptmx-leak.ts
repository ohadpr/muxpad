import { closeSync, fstatSync, readdirSync, statSync } from 'node:fs';

/**
 * node-pty leaks one `/dev/ptmx` handle per spawn. This closes it.
 *
 * MEASURED, because the first fix for this was a no-op. Counting a process's
 * own ptmx handles through one pty's life:
 *
 *     after spawn                 2
 *     after the child exited      1     ← node-pty releases its own
 *     after calling destroy()     1     ← does nothing for the other
 *     after dropping it + gc()    1     ← not retention; it is unreachable
 *
 * The surviving handle is not the one node-pty knows about. `term._fd` is
 * released when the child exits; the other is opened inside the native
 * `forkpty` and never recorded on the JS object, so no API call, no teardown
 * and no garbage collection will ever free it. One per pane, for the life of
 * the daemon.
 *
 * That ceiling is `kern.tty.ptmx_max` — 511 on this machine. Reached it after a
 * day of ordinary use: 505 handles held, 72 ptys actually in use, and nothing
 * on the machine able to open a terminal, an app or a browser again.
 *
 * WHY CLOSING IT IS SAFE, and how that was established rather than assumed: the
 * stray is closed immediately after spawn, then the pty is written to and its
 * output read back. The round trip works, the child exits normally, and the
 * process is left holding ZERO ptmx handles. The native side never touches it
 * again — it is the handle the pty was created FROM, not the one it is driven
 * through.
 *
 * IDENTIFIED BY OWNERSHIP, NOT BY ARRIVAL. The obvious rule — "a ptmx that
 * appeared during this spawn" — is unsound, and silently so: descriptor numbers
 * are RECYCLED. Measured, with the diff in place and reporting success:
 *
 *     before spawn   0,1,2..11          ← 11 is a directory handle, then closed
 *     after spawn    0,1,2..16
 *     ptmx fds now   11, 12             ← 12 is the pty; 11 is the stray
 *     stray by diff  (none)             ← because 11 was in "before"
 *
 * So the sweep matched nothing while looking like it worked, which is the same
 * failure as the fix before it. What is knowable for certain is which ptys are
 * OURS: every one this daemon opens is registered here. Any other ptmx
 * descriptor in the process belongs to nobody — nothing else in ptyd opens one
 * — and that is the one to close.
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
 * gets closed can be tested without opening anything.
 */
export function strayPtmxFds(deps: PtmxSweepDeps): number[] {
  return deps.open.filter((fd) => !deps.owned.has(fd) && deps.isPtmx(fd));
}

/**
 * The pty masters this process opened on purpose.
 *
 * Module-level because it is a fact about the PROCESS, not about any one pane,
 * and the sweep has to be able to tell one pane's pty from another's stray.
 */
const ownedPtys = new Set<number>();

/** Call with the master descriptor the moment a pty is created. */
export function ownPty(fd: number): void {
  if (Number.isInteger(fd) && fd >= 0) ownedPtys.add(fd);
}

/** Call when the pty is gone, so a recycled number is not mistaken for ours. */
export function disownPty(fd: number): void {
  ownedPtys.delete(fd);
}

/** For tests and diagnostics. */
export function ownedPtyCount(): number {
  return ownedPtys.size;
}

/** The major half of a device number — the driver, shared by all its clones. */
export function deviceMajor(rdev: number): number {
  return (rdev >> 24) & 0xff;
}

/**
 * Whether `fd` is one of the pty master devices.
 *
 * MAJOR ONLY, and this is the part that was wrong the first time. `/dev/ptmx`
 * CLONES: every open produces a fresh device, so the descriptors have different
 * rdevs from the node and from each other. Measured on one spawn —
 *
 *     /dev/ptmx   major 15  minor 149
 *     stray fd    major 15  minor 147
 *     the pty     major 15  minor 148
 *
 * — so comparing whole device numbers matches nothing at all, and the sweep
 * that used it silently closed nothing while reporting success. The driver is
 * the thing they share.
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

/**
 * Closes what the spawn leaked, and says how many.
 *
 * Failures are counted, not thrown: a descriptor we could not close is a slow
 * leak, and an exception here is a pane that never starts.
 */
export function closeStrayPtmx(major: number | null = ptmxRdev()): number {
  let closed = 0;
  for (const fd of strayPtmxFds({
    open: openFds(),
    owned: ownedPtys,
    isPtmx: (f) => isPtmxFd(f, major),
  })) {
    try {
      closeSync(fd);
      closed++;
    } catch {
      // Already gone, or not ours to close. Either way, not worth a pane.
    }
  }
  return closed;
}
