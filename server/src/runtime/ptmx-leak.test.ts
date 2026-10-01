import { describe, expect, it } from 'vitest';
import {
  deviceMajor,
  disownPty,
  isPtmxFd,
  openFds,
  ownPty,
  ownedFdSet,
  ownedPtyCount,
  ptmxRdev,
  strayPtmxFds,
  sweepMode,
  sweepStrayPtmx,
} from './ptmx-leak.js';

/**
 * The rule that decides whether a descriptor gets closed, on the daemon that
 * owns every terminal on the machine. Getting it wrong closes somebody's socket
 * mid-session, so the rule is tested on its own, away from any real fd.
 */

const sweep = (open: number[], owned: number[], ptmx: number[] = []) =>
  strayPtmxFds({ open, owned: new Set(owned), isPtmx: (fd) => ptmx.includes(fd) });

describe('deciding which pty descriptor belongs to nobody', () => {
  it('takes a pty descriptor this daemon never opened', () => {
    expect(sweep([1, 2, 11, 12], [12], [11, 12])).toEqual([11]);
  });

  it('never one we own', () => {
    // Closing this is closing a terminal somebody is typing in.
    expect(sweep([1, 12], [12], [12])).toEqual([]);
  });

  it('never something that is not a pty at all', () => {
    // A log file, a socket, a pipe. On the daemon that owns every terminal,
    // closing one of those is far worse than the leak.
    expect(sweep([1, 7, 11], [12], [11])).toEqual([11]);
    expect(sweep([1, 7], [12], [])).toEqual([]);
  });

  it('OWNERSHIP, not arrival — because descriptor numbers are recycled', () => {
    // The rule this replaced asked "did it appear during this spawn". Measured
    // with that in place: the stray was fd 11, which had been a directory
    // handle moments earlier and so counted as pre-existing. It matched nothing
    // and reported success, which is how the fix before it also failed.
    const openNow = [1, 2, 11, 12];
    expect(sweep(openNow, [12], [11, 12])).toEqual([11]);
  });

  it('finds nothing once every pty is accounted for', () => {
    // What a fixed node-pty looks like. The sweep must be a no-op then, not a
    // liability.
    expect(sweep([1, 2, 12, 13], [12, 13], [12, 13])).toEqual([]);
  });

  it('takes several when several are orphaned', () => {
    expect(sweep([10, 11, 12], [12], [10, 11, 12])).toEqual([10, 11]);
  });
});

describe('recognising a ptmx descriptor', () => {
  it('compares the DRIVER, not the whole device number', () => {
    // /dev/ptmx clones: every open makes a fresh device, so the node and the
    // descriptors all differ. Measured on one spawn — ptmx minor 149, the stray
    // 147, the pty 148, all major 15. Comparing whole rdevs matched nothing,
    // and the sweep silently closed nothing while looking like it worked.
    expect(deviceMajor(251658387)).toBe(15);
    expect(deviceMajor(251658388)).toBe(15);
    expect(deviceMajor(251658389)).toBe(15);
    expect(deviceMajor(268435604)).not.toBe(15);
  });

  it('says no for something that is not a character device', () => {
    // fd 1 is stdout — a pipe or a file here, never /dev/ptmx.
    expect(isPtmxFd(1, ptmxRdev())).toBe(false);
  });

  it('says no for a descriptor that is not open', () => {
    expect(isPtmxFd(99_999, ptmxRdev())).toBe(false);
  });

  it('says no when the platform has no /dev/ptmx', () => {
    // Then there is nothing to leak and nothing to close.
    expect(isPtmxFd(1, null)).toBe(false);
    expect(ptmxRdev('/dev/definitely-not-here')).toBeNull();
  });
});

describe('listing our own descriptors', () => {
  it('sees the ones every process has', () => {
    const fds = openFds();
    expect(fds).toContain(1);
    expect(fds).toContain(2);
  });

  it('reads a missing directory as "cannot tell", not as "none open"', () => {
    // An empty list makes every descriptor look new, which would turn the sweep
    // into a hunt. Better to find nothing than to close the wrong thing.
    expect(openFds('/definitely/not/here')).toEqual([]);
  });
});

describe('the register of ptys we own', () => {
  it('remembers and forgets', () => {
    const start = ownedPtyCount();
    // fd 1 is real, so it has a device to key on. A number with nothing behind
    // it cannot be claimed — see the next test.
    ownPty(1);
    expect(ownedPtyCount()).toBe(start + 1);
    disownPty(1);
    expect(ownedPtyCount()).toBe(start);
  });

  it('ignores a descriptor that is not one', () => {
    // node-pty's `_fd` is read off a private field; absent, it arrives as -1.
    // Registering that would make -1 "ours" forever.
    const start = ownedPtyCount();
    ownPty(-1);
    ownPty(Number.NaN);
    // Nothing is open on this number, so there is no device to claim it for.
    ownPty(99_999);
    expect(ownedPtyCount()).toBe(start);
  });

  it('is shared across module instances, not one per import', () => {
    // vitest gives every test file its own module registry. With a per-instance
    // register, THIS file's live pty is absent from THAT file's register and
    // reads as nobody's — which in close mode is one test closing another's
    // terminal. The register lives on globalThis so there is only ever one.
    ownPty(1);
    const shared = (globalThis as Record<symbol, unknown>)[Symbol.for('muxpad.ownedPtys')];
    expect(shared).toBeInstanceOf(Map);
    expect((shared as Map<number, number>).has(1)).toBe(true);
    disownPty(1);
  });

  it('drops a claim when the number stops pointing at the device we claimed', () => {
    // Descriptor numbers are RECYCLED. Keyed on the number alone, a fresh
    // descriptor would inherit whatever claim the previous holder left behind
    // and be treated as ours forever.
    ownPty(1);
    expect(ownedFdSet(new Map([[1, 999_999]])).has(1)).toBe(false);
    expect(ownedFdSet().has(1)).toBe(true);
    disownPty(1);
  });
});

describe('what the sweep does when it finds something', () => {
  it('counts without closing, unless closing is asked for', () => {
    expect(sweepMode({})).toBe('observe');
    expect(sweepMode({ MUXPAD_PTMX_SWEEP: 'close' })).toBe('close');
    // Anything else is observe. Closing descriptors in the daemon that owns
    // every terminal is not something a typo should be able to turn on.
    expect(sweepMode({ MUXPAD_PTMX_SWEEP: '1' })).toBe('observe');
    expect(sweepMode({ MUXPAD_PTMX_SWEEP: 'true' })).toBe('observe');
  });

  it('closes nothing on a platform with no pty driver', () => {
    const result = sweepStrayPtmx(null, 'close');
    expect(result.strays).toEqual([]);
    expect(result.closed).toBe(0);
  });

  it('leaves this process alone in observe mode', () => {
    // The real thing, against the real descriptor table: it must report without
    // touching anything. If it closed one of vitest's own fds the run would die.
    const result = sweepStrayPtmx(ptmxRdev(), 'observe');
    expect(result.mode).toBe('observe');
    expect(result.closed).toBe(0);
    expect(openFds()).toContain(1);
    expect(openFds()).toContain(2);
  });
});
