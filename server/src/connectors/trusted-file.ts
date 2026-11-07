import {
  constants,
  type Stats,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

/**
 * READING A FILE THAT AN AGENT MUST NOT BE ABLE TO EDIT.
 *
 * Two things now depend on this — the connector policy (which machines may use
 * which connector) and the integration declarations (where an integration's
 * data and binary live). Both are root-owned files on a machine where the
 * thing they bind is the agent that would otherwise edit them, and both failed
 * in the same ways while this logic lived in one of them and was about to be
 * copied into the other.
 *
 * The rules, each of which was a bug first:
 *
 *   · ONLY "it is not there" is absent. Every other failure — a directory
 *     chmod 0 above it, ELOOP, ENOTDIR, a symlinked final component — is a
 *     file we cannot read, and reading that as "no file" lets an agent disable
 *     a rule by making it unreadable.
 *   · JUDGED THROUGH ONE FILE DESCRIPTOR. Stat-then-read is a race, and
 *     `readFileSync` follows a symlink that `lstatSync` only reported.
 *   · THE ANCESTORS COUNT. A root-owned file inside a directory the agent can
 *     write is a file the agent can replace.
 *   · AN EMPTY FILE IS NOT AN EMPTY RULE. Truncating to zero bytes was a way
 *     to turn scoping off.
 */

/**
 * The filesystem, as this module uses it.
 *
 * INJECTABLE BECAUSE THE REAL THING NEEDS ROOT. Every refusal below depends on
 * a file owned by uid 0 inside directories owned by uid 0, which a test cannot
 * create — so with the calls inline, twelve separate sabotages of this logic
 * passed the whole suite, including deleting the ancestor walk outright. A
 * seam here is the difference between code that is argued and code that is
 * checked.
 */
export interface FileIO {
  open(path: string): number;
  fstat(fd: number): Stats;
  read(fd: number): string;
  close(fd: number): void;
  lstat(path: string): Stats;
}

export const realIO: FileIO = {
  // O_NOFOLLOW refuses a symlinked final component outright. O_NONBLOCK so a
  // FIFO that passed every other check cannot park the server on open.
  open: (path) => openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK),
  fstat: (fd) => fstatSync(fd),
  read: (fd) => readFileSync(fd, 'utf8'),
  close: (fd) => closeSync(fd),
  lstat: (path) => lstatSync(path),
};

/** The directories above it must be root's too: a root-owned file in a
 *  directory the agent can write is a file the agent can replace. */
export function ancestorProblem(path: string, io: FileIO = realIO): string | null {
  let cur = dirname(path);
  for (;;) {
    let st: Stats;
    try {
      st = io.lstat(cur);
    } catch {
      return `${cur} could not be inspected`;
    }
    if (st.isSymbolicLink()) return `${cur} is a symlink`;
    if (!st.isDirectory()) return `${cur} is not a directory`;
    if (st.uid !== 0) return `${cur} is not root-owned`;
    if (st.mode & 0o022) return `${cur} is writable by its group or by everyone`;
    const up = dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
}

/**
 * Bytes from a file that PASSED the metadata checks.
 *
 * Pure and exported so the fail-closed branch can be tested without being
 * root: while this was inline, "a trusted file that does not parse fails open"
 * survived every sabotage because nothing could reach it.
 */

/**
 * What is wrong with this file's metadata, or null.
 *
 * Pure and exported so the branches can be table-tested without being root —
 * the mode and file-type refusals were untestable while this was inline, and
 * a sabotage of the mode check survived the whole suite.
 */
export function trustProblem(st: Stats, what: string): string | null {
  if (!st.isFile()) return `${what} is not a regular file`;
  if (st.uid !== 0) return `${what} is not root-owned`;
  if (st.mode & 0o022) return `${what} is writable by its group or by everyone`;
  // A hardlink means the same inode is reachable from a path we did not check,
  // so its ancestors are not the ones we just walked.
  if (st.nlink !== 1) return `${what} has more than one link`;
  return null;
}

export type TrustedFile =
  | { kind: 'absent' }
  | { kind: 'untrusted'; problem: string }
  | { kind: 'ok'; text: string };

/** The bytes of a file nothing but root could have written, or why not. */
export function loadTrustedText(path: string, io: FileIO = realIO): TrustedFile {
  let fd: number;
  try {
    fd = io.open(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' };
    return {
      kind: 'untrusted',
      problem: `${path} could not be opened (${(e as NodeJS.ErrnoException).code})`,
    };
  }
  try {
    const bad = trustProblem(io.fstat(fd), path) ?? ancestorProblem(path, io);
    if (bad) return { kind: 'untrusted', problem: bad };
    const text = io.read(fd);
    if (text.trim() === '') return { kind: 'untrusted', problem: `${path} is empty` };
    return { kind: 'ok', text };
  } catch {
    return { kind: 'untrusted', problem: `${path} could not be read` };
  } finally {
    // A close that throws must not turn a decision into an exception.
    try {
      io.close(fd);
    } catch {
      /* the answer is already made */
    }
  }
}

export type TrustedJson =
  | { kind: 'absent' }
  | { kind: 'untrusted'; problem: string }
  | { kind: 'ok'; value: unknown };

/** The same, parsed. Unparseable is UNTRUSTED, not absent: the file was put
 *  there deliberately, and a typo is not consent to drop what it says. */
export function loadJsonFile(path: string, io: FileIO = realIO): TrustedJson {
  const file = loadTrustedText(path, io);
  if (file.kind !== 'ok') return file;
  try {
    // A BOM is what several editors write and `readFileSync` does not strip it.
    return { kind: 'ok', value: JSON.parse(file.text.replace(/^\uFEFF/, '')) };
  } catch {
    return { kind: 'untrusted', problem: `${path} is not valid JSON` };
  }
}
