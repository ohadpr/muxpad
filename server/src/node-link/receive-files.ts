import { closeSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

/**
 * RECEIVING A PATH FROM A HOST, into a staging directory on this machine.
 *
 * The counterpart to node-agent/send-files.ts. The wire format is a list of
 * (relative path, bytes) and nothing else — it cannot describe a symlink, a
 * device, a hard link or a permission bit — so the only thing that has to be
 * defended here is the relative path itself.
 *
 * ── EVERY PATH IS RE-DERIVED AND RE-CHECKED ──────────────────────────────
 * `rel` arrives from a machine that may be compromised, so it is not joined
 * and trusted: it is joined, resolved, and then checked to still be inside the
 * staging root. That catches `../`, an absolute path, a Windows-ish drive
 * prefix, and the ones that are easy to forget — a `rel` of `..` alone, or a
 * segment that is empty. `..%2f` and friends cannot appear because nothing
 * here URL-decodes.
 *
 * The staging root is a fresh directory per transfer under the data dir, so
 * even a successful escape attempt lands somewhere nothing serves.
 */

/** Matches node-agent/send-files.ts. Exceeding either is a refusal, not a trim. */
export const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
export const MAX_FILES = 4000;

export class FileReceiver {
  private readonly open = new Map<string, number>();
  private readonly seen = new Set<string>();
  private bytes = 0;
  private failed: string | null = null;

  /**
   * @param root an EMPTY directory this receiver owns and may delete.
   */
  constructor(private readonly root: string) {
    mkdirSync(root, { recursive: true });
  }

  /** The reason this transfer is dead, or null while it is healthy. */
  get error(): string | null {
    return this.failed;
  }

  /**
   * One chunk. `rel` of `''` means the transfer is a single FILE — it is
   * written under a placeholder name and {@link finish} renames it, because
   * the real filename only arrives with `done`.
   */
  chunk(rel: string, b64: string, last: boolean): void {
    if (this.failed) return;
    const target = this.pathFor(rel);
    if (!target) {
      this.fail(`refusing a path outside the staging dir: ${rel}`);
      return;
    }
    if (!this.seen.has(target)) {
      if (this.seen.size >= MAX_FILES) {
        this.fail(`too many files (> ${MAX_FILES})`);
        return;
      }
      this.seen.add(target);
    }
    try {
      let fd = this.open.get(target);
      if (fd === undefined) {
        mkdirSync(dirname(target), { recursive: true });
        // 'w' — a transfer owns a fresh directory, so there is nothing to
        // append to, and 'a' would silently double a file if a host ever
        // re-sent one.
        fd = openSync(target, 'w');
        this.open.set(target, fd);
      }
      if (b64) {
        const buf = Buffer.from(b64, 'base64');
        this.bytes += buf.length;
        if (this.bytes > MAX_TOTAL_BYTES) {
          this.fail(`too large (> ${Math.round(MAX_TOTAL_BYTES / 1024 / 1024)}MB)`);
          return;
        }
        writeSync(fd, buf);
      }
      if (last) {
        closeSync(fd);
        this.open.delete(target);
      }
    } catch (e) {
      this.fail((e as Error).message);
    }
  }

  /**
   * The transfer is complete. Returns the absolute path to hand to publish, or
   * null if the transfer failed.
   *
   * For a single file the staged placeholder is renamed to `name`, so the
   * artifact keeps the filename the user published rather than a staging id —
   * publish reads `basename(path)` and a lone `.html` becomes the slug's
   * index.
   */
  finish(kind: 'file' | 'dir', name: string): string | null {
    this.closeAll();
    if (this.failed) return null;
    const safe = sanitizeName(name);
    if (kind === 'dir') {
      // Publish copies the CONTENTS of a directory, and takes the slug from
      // `--name` or mints one, so the directory's own name does not matter
      // here. The root is handed over as it is.
      return this.root;
    }
    if (!safe) {
      this.fail(`unusable filename: ${name}`);
      return null;
    }
    const from = join(this.root, SINGLE);
    const to = join(this.root, safe);
    try {
      renameSync(from, to);
    } catch (e) {
      this.fail((e as Error).message);
      return null;
    }
    return to;
  }

  /** Close every descriptor and delete the staging tree. Idempotent. */
  dispose(): void {
    this.closeAll();
    rmSync(this.root, { recursive: true, force: true });
  }

  private closeAll(): void {
    for (const [, fd] of this.open) {
      try {
        closeSync(fd);
      } catch {
        /* a failed transfer may have left one half-open */
      }
    }
    this.open.clear();
  }

  private fail(reason: string): void {
    this.failed ??= reason;
    this.closeAll();
  }

  /**
   * Where `rel` is allowed to land, or null.
   *
   * The check is on the RESOLVED path, not on the string: a blocklist of `..`
   * is the version of this that gets bypassed.
   */
  private pathFor(rel: string): string | null {
    // NOT A STRING AT ALL is a real input, and it used to be a crash: this is
    // one call away from a WebSocket message handler, and a host that answered
    // a fetch with `rel: null` raised a TypeError there — uncaught, so the
    // whole server went. The link boundary refuses that frame now
    // (HostLink.wellFormed); this is the belt to its braces, because a
    // boundary check and a crash-on-bad-input one call behind it is a
    // single-point-of-failure arrangement.
    if (typeof rel !== 'string') return null;
    if (rel === '') return join(this.root, SINGLE);
    if (rel.includes('\0') || isAbsolute(rel)) return null;
    const abs = resolve(this.root, rel);
    const prefix = this.root.endsWith(sep) ? this.root : this.root + sep;
    return abs.startsWith(prefix) ? abs : null;
  }
}

/** The placeholder a single-file transfer is written under. Not a real name,
 *  so it cannot collide with one. */
const SINGLE = '.incoming';

/**
 * A filename from a host, made safe to create here.
 *
 * Basename only and no separators, because this is a NAME and not a path —
 * everything structural has already been decided by `kind`.
 */
export function sanitizeName(name: string): string | null {
  const base = name.replace(/^.*[\\/]/, '').trim();
  if (!base || base === '.' || base === '..') return null;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: excluding them is the job
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 200);
  return clean || null;
}
