import { execFile } from 'node:child_process';
import { appendFile, chmod, open, rename, stat, statfs, unlink, utimes } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
/** statfs f_type of APFS on macOS. */
const APFS_FTYPE = 0x1a;

/**
 * RE-CLONE ON SETTLE — give the archive copy back its shared blocks.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────
 *
 * The archive is a byte-for-byte mirror of `~/.claude/projects` (and of
 * muxpad's own agent-transcripts). Claude never reaps those sources
 * (cleanupPeriodDays is 36500 on this machine), so every mirrored byte is
 * stored twice. APFS can store it once: a clone shares physical blocks until
 * one side writes. A one-time clone pass reclaimed ~7 GB, but the archiver
 * mirrors new bytes with `appendFile` (Archiver.copyAppend), which never
 * clones — measured 2026-11-25, every file written in the two days after the
 * pass was fully unshared again (2,968 files, ~1.15 GB). The archiver itself
 * creates the divergence, so the archiver is what repairs it.
 *
 * ── WHY REPLACING THE FILE DOES NOT BREAK "NOTHING IS EVER OVERWRITTEN" ──
 *
 * Archiver.ts promises the archive never overwrites or loses anything, which
 * is why a shrunk source is sealed as `.vN` instead of truncated. That rule
 * exists to guarantee no DATA is lost. This routine does replace the file,
 * so it breaks the letter of the rule, but it keeps the purpose exactly: the
 * replacement is proven byte-identical to the file it replaces by a full
 * byte compare made immediately before the swap, and the swap is a single
 * atomic `rename` from a temp file on the same volume, so there is no instant
 * at which the path holds anything but a complete copy. The inode changes;
 * the contents cannot. Anything that fails a check is left exactly as it was.
 * This was decided deliberately (owner, 2026-11-25), not done carelessly.
 *
 * ── WHAT IS NEVER TOUCHED ────────────────────────────────────────────────
 *
 *   source gone   → the archive is the ONLY copy; there is nothing to clone
 *   not settled   → source or mirror written in the settle window (24 h)
 *   mid-update    → source size ≠ ledger offset (unmirrored tail, or a
 *                   shrink awaiting its seal), or mirror size ≠ offset
 *   sealed .vN    → a frozen history version; its source content is gone
 *   differs       → the clone's bytes are not the mirror's bytes
 *
 * The source is only ever READ (cloned from). Nothing here writes to it.
 */

export type RecloneOutcome =
  | 'recloned'
  | 'source-gone'
  | 'archive-missing'
  | 'not-settled'
  | 'mid-update'
  | 'sealed'
  | 'differs'
  | 'changed-during'
  | 'clone-unsupported'
  | 'raced-repaired'
  | 'error';

export interface RecloneResult {
  outcome: RecloneOutcome;
  /** Mirror bytes now sharing blocks with the source (0 unless recloned). */
  bytes: number;
  detail?: string | undefined;
}

export interface RecloneTarget {
  sourcePath: string;
  /** Absolute path of the archive mirror. */
  archivedAbs: string;
  /** Ledger offset: how many source bytes the mirror holds. */
  offset: number;
}

export interface RecloneOpts {
  /** No writes to source or mirror within this window. Default 24 h. */
  settleMs?: number | undefined;
  /** Clock, for tests. */
  now?: () => number;
  /** Paces the byte compare so a pass never saturates the disk. */
  throttle?: ByteThrottle | undefined;
  chunkBytes?: number | undefined;
}

export const DEFAULT_SETTLE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CHUNK = 1024 * 1024;
const SEALED_RE = /\.v\d+\.jsonl$/;

/** A token bucket over bytes read. `take` resolves once the budget allows. */
export class ByteThrottle {
  private next = 0;
  constructor(private readonly bytesPerSec: number) {}
  async take(n: number): Promise<void> {
    if (!(this.bytesPerSec > 0)) return;
    const now = Date.now();
    const start = Math.max(now, this.next);
    this.next = start + (n / this.bytesPerSec) * 1000;
    const wait = start - now;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
}

export function isSealedArchiveName(path: string): boolean {
  return SEALED_RE.test(basename(path));
}

/**
 * Replace one settled mirror with an APFS clone of its source, verified
 * byte-identical first. Never throws; every refusal is an outcome.
 */
export async function recloneOne(t: RecloneTarget, opts: RecloneOpts = {}): Promise<RecloneResult> {
  const settleMs = opts.settleMs ?? DEFAULT_SETTLE_MS;
  const now = opts.now ?? Date.now;
  const chunk = opts.chunkBytes ?? DEFAULT_CHUNK;

  if (isSealedArchiveName(t.archivedAbs)) return { outcome: 'sealed', bytes: 0 };

  let src: Awaited<ReturnType<typeof stat>>;
  try {
    src = await stat(t.sourcePath);
  } catch {
    return { outcome: 'source-gone', bytes: 0 };
  }
  let arch: Awaited<ReturnType<typeof stat>>;
  try {
    arch = await stat(t.archivedAbs);
  } catch {
    return { outcome: 'archive-missing', bytes: 0 };
  }
  const cutoff = now() - settleMs;
  if (src.mtimeMs > cutoff || arch.mtimeMs > cutoff) return { outcome: 'not-settled', bytes: 0 };
  if (src.size !== t.offset || arch.size !== t.offset || t.offset === 0) {
    return {
      outcome: 'mid-update',
      bytes: 0,
      detail: `source=${src.size} mirror=${arch.size} offset=${t.offset}`,
    };
  }

  const tmp = join(
    dirname(t.archivedAbs),
    `.reclone-${process.pid}-${Math.random().toString(36).slice(2, 10)}-${basename(t.archivedAbs)}`,
  );
  let tmpLive = false;
  // Pin the mirror's CURRENT inode: the compare reads it, and after the swap
  // its fd reveals whether anything appended to it in the window.
  let oldFh: Awaited<ReturnType<typeof open>> | null = null;
  try {
    oldFh = await open(t.archivedAbs, 'r');
    const pinned = await oldFh.stat();
    if (pinned.ino !== arch.ino || pinned.size !== t.offset) {
      return { outcome: 'changed-during', bytes: 0, detail: 'mirror changed before clone' };
    }

    // HOW WE CLONE, AND WHY NOT fs.copyFile. Node's COPYFILE_FICLONE_FORCE
    // is ENOSYS on macOS, and plain COPYFILE_FICLONE silently makes a FULL
    // copy (measured 2026-11-25 with F_LOG2PHYS_EXT: different physical
    // blocks). A full copy would turn a reclaim into a cost, so we use
    // `cp -c` (clonefile(2)). cp itself falls back to a full copy across
    // filesystems or on a filesystem without clones; per its man page those
    // are the only fallback cases, so both are ruled out first: APFS, and the
    // source on the same device as the mirror.
    try {
      const fs = await statfs(dirname(t.archivedAbs));
      if (process.platform !== 'darwin' || fs.type !== APFS_FTYPE || src.dev !== arch.dev) {
        return {
          outcome: 'clone-unsupported',
          bytes: 0,
          detail: `fstype=${fs.type} dev ${src.dev}/${arch.dev}`,
        };
      }
      tmpLive = true;
      await execFileP('/bin/cp', ['-c', t.sourcePath, tmp]);
    } catch (err) {
      return { outcome: 'clone-unsupported', bytes: 0, detail: String(err) };
    }
    const cloned = await stat(tmp);
    const srcAfter = await stat(t.sourcePath);
    if (
      cloned.size !== t.offset ||
      srcAfter.size !== src.size ||
      srcAfter.mtimeMs !== src.mtimeMs
    ) {
      return { outcome: 'changed-during', bytes: 0, detail: 'source changed during clone' };
    }

    // THE BYTE COMPARE — the whole file, immediately before the swap.
    const same = await bytesEqual(tmp, oldFh, t.offset, chunk, opts.throttle);
    if (!same.equal) return { outcome: 'differs', bytes: 0, detail: same.detail };

    // Keep the mirror's own metadata, not the source's.
    await chmod(tmp, pinned.mode & 0o7777);
    await utimes(tmp, pinned.atime, pinned.mtime);

    // Last look before the swap: same inode, same length.
    const lastLook = await stat(t.archivedAbs);
    if (lastLook.ino !== pinned.ino || lastLook.size !== t.offset) {
      return { outcome: 'changed-during', bytes: 0, detail: 'mirror changed before swap' };
    }
    await rename(tmp, t.archivedAbs);
    tmpLive = false;

    // Did a writer append to the OLD inode between the last look and the
    // rename? Inside the archiver that cannot happen (per-path lock); from an
    // out-of-process pass it is a microsecond window on a file settled for a
    // day. If it did, carry those bytes over so nothing is lost.
    const oldAfter = await oldFh.stat();
    if (oldAfter.size > t.offset) {
      const extra = Buffer.alloc(oldAfter.size - t.offset);
      await oldFh.read(extra, 0, extra.length, t.offset);
      const nowNew = await stat(t.archivedAbs);
      if (nowNew.size === t.offset) {
        await appendFile(t.archivedAbs, extra);
        return { outcome: 'raced-repaired', bytes: t.offset, detail: `+${extra.length} carried` };
      }
      // Both inodes grew: keep the old inode's whole content beside it.
      const orphan = `${t.archivedAbs}.reclone-orphan-${Date.now()}`;
      const all = Buffer.alloc(oldAfter.size);
      await oldFh.read(all, 0, all.length, 0);
      await appendFile(orphan, all);
      return { outcome: 'raced-repaired', bytes: 0, detail: `old inode kept as ${orphan}` };
    }
    return { outcome: 'recloned', bytes: t.offset };
  } catch (err) {
    return { outcome: 'error', bytes: 0, detail: String(err) };
  } finally {
    await oldFh?.close().catch(() => {});
    if (tmpLive) await unlink(tmp).catch(() => {});
  }
}

async function bytesEqual(
  aPath: string,
  bFh: Awaited<ReturnType<typeof open>>,
  len: number,
  chunk: number,
  throttle: ByteThrottle | undefined,
): Promise<{ equal: boolean; detail?: string }> {
  const aFh = await open(aPath, 'r');
  try {
    const a = Buffer.allocUnsafe(chunk);
    const b = Buffer.allocUnsafe(chunk);
    for (let pos = 0; pos < len; ) {
      const n = Math.min(chunk, len - pos);
      await throttle?.take(2 * n);
      const ra = await aFh.read(a, 0, n, pos);
      const rb = await bFh.read(b, 0, n, pos);
      if (ra.bytesRead !== n || rb.bytesRead !== n) {
        return { equal: false, detail: `short read at ${pos}` };
      }
      if (a.compare(b, 0, n, 0, n) !== 0)
        return { equal: false, detail: `differs in [${pos}, ${pos + n})` };
      pos += n;
    }
    return { equal: true };
  } finally {
    await aFh.close();
  }
}

export interface RecloneTally {
  byOutcome: Partial<Record<RecloneOutcome, { files: number; bytes: number }>>;
  recloned: string[];
}

/**
 * Run `recloneOne` over many targets in batches, pausing between batches so
 * the owner's machine stays responsive. `onResult` sees every outcome (the
 * caller logs; this function does not know where logs go).
 */
export async function reclonePass(
  targets: Iterable<RecloneTarget>,
  opts: RecloneOpts & {
    batchFiles?: number;
    pauseMs?: number;
    shouldStop?: () => boolean;
    onResult?: (t: RecloneTarget, r: RecloneResult) => void;
    /** Wraps each file, e.g. the archiver's per-path lock. */
    around?: <T>(t: RecloneTarget, fn: () => Promise<T>) => Promise<T>;
  } = {},
): Promise<RecloneTally> {
  const tally: RecloneTally = { byOutcome: {}, recloned: [] };
  const batch = opts.batchFiles ?? 50;
  const pause = opts.pauseMs ?? 250;
  let i = 0;
  for (const t of targets) {
    if (opts.shouldStop?.()) break;
    const run = () => recloneOne(t, opts);
    const r = opts.around ? await opts.around(t, run) : await run();
    const e = tally.byOutcome[r.outcome] ?? { files: 0, bytes: 0 };
    e.files += 1;
    e.bytes += r.outcome === 'recloned' || r.outcome === 'raced-repaired' ? r.bytes : t.offset;
    tally.byOutcome[r.outcome] = e;
    if (r.outcome === 'recloned' || r.outcome === 'raced-repaired')
      tally.recloned.push(t.archivedAbs);
    opts.onResult?.(t, r);
    if (++i % batch === 0 && pause > 0) await new Promise((res) => setTimeout(res, pause));
  }
  return tally;
}
