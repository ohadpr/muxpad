// ATTACHMENTS FOR A RUNNER THAT IS NOT ON THE SERVER'S MACHINE.
//
// The composer appends each attachment to the message as the SERVER's absolute
// path — `look at this /Users/<you>/.muxpad/attachments/3f2a9c1e.png` — and the
// server relays the text verbatim. For a local pane that path is the file. For
// a pane on a remote host it names nothing: the agent on the VM was handed a
// path to no file, guessed, and ended up telling its owner to `scp` the
// screenshot by hand.
//
// So before a message reaches the backend, every attachment path in it that
// does not exist HERE is fetched over the runner's own socket (see the
// `attachment` frame in protocol.ts), written into THIS machine's
// `<dataDir>/attachments/<name>`, and the path in the text is rewritten to
// that copy. The basename is kept, so the chat still renders it from the
// server by name. A path that cannot be fetched becomes a short, honest note —
// never a dangling path, because a dangling path is what made the agent guess.
//
// A local pane never fetches: the original path exists, and the check
// short-circuits before anything is asked.

import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { attachmentPathRe } from '@muxpad/shared';
import { attachmentNameProblem } from '../attachment-files.js';

/**
 * A FILESYSTEM path into an attachments dir — what the composer writes, and
 * nothing else.
 *
 * Not a URL. `\S*` alone also matched `https://host/attachments/report.pdf`,
 * so a link the user pasted was treated as a file reference and, on a remote
 * pane, edited out of their message: rewritten to an unrelated local file that
 * shared the basename, or replaced with a "could not be loaded" note.
 *
 *   · the token starts at the start of the text, after whitespace, or after an
 *     opening bracket/quote — so the `/` inside `https://` (preceded by `:`)
 *     can never begin one;
 *   · it starts with a single `/` (absolute, not `//host`) and holds no `:`;
 *   · the extension ends the name: a trailing `,` or `.` in prose is left out,
 *     and `x.png.bak` is not `x.png`.
 *
 * Any data dir is accepted, since MUXPAD_DATA_DIR can move it from ~/.muxpad.
 */
const ATTACHMENT_PATH_RE = attachmentPathRe();

export type AttachmentRef = { path: string; name: string };

/** Every distinct attachment path in `text`, in order of first appearance. */
export function findAttachmentRefs(text: string): AttachmentRef[] {
  const seen = new Set<string>();
  const out: AttachmentRef[] = [];
  for (const m of text.matchAll(ATTACHMENT_PATH_RE)) {
    const path = m[0];
    const name = m[1] ?? '';
    if (seen.has(path)) continue;
    seen.add(path);
    out.push({ path, name });
  }
  return out;
}

export type FetchResult = { ok: true; bytes: Buffer } | { ok: false; reason: string };

export interface LocalizeDeps {
  /** This machine's muxpad data dir (`MUXPAD_DATA_DIR ?? ~/.muxpad`). */
  dataDir: string;
  /** Ask the server for one attachment's bytes. Must settle (time out) on its own. */
  fetch: (name: string) => Promise<FetchResult>;
  /** Injected for tests; defaults to the real filesystem. */
  exists?: (path: string) => boolean;
}

/** What the agent reads in place of a path it cannot have. */
export function attachmentUnavailableNote(name: string, reason: string): string {
  return `[attachment ${name} could not be loaded on this machine: ${reason}]`;
}

/**
 * Rewrite `text` so every attachment path in it names a file that exists on
 * this machine, fetching the ones that do not. Text with no attachment, or
 * whose attachments are all already here, is returned unchanged (same string).
 */
export async function localizeAttachments(text: string, deps: LocalizeDeps): Promise<string> {
  const refs = findAttachmentRefs(text);
  if (!refs.length) return text;
  const exists = deps.exists ?? existsSync;
  const dir = join(deps.dataDir, 'attachments');
  const replacements = new Map<string, string>();
  for (const ref of refs) {
    if (exists(ref.path)) continue; // local pane, or a path this machine has
    const problem = attachmentNameProblem(ref.name);
    if (problem) {
      replacements.set(ref.path, attachmentUnavailableNote(ref.name, problem));
      continue;
    }
    const local = join(dir, ref.name);
    // Already fetched for an earlier message (names are content-unique).
    if (exists(local)) {
      replacements.set(ref.path, local);
      continue;
    }
    let got: FetchResult;
    try {
      got = await deps.fetch(ref.name);
    } catch (err) {
      got = { ok: false, reason: (err as Error).message || 'request failed' };
    }
    if (!got.ok) {
      replacements.set(ref.path, attachmentUnavailableNote(ref.name, got.reason));
      continue;
    }
    try {
      mkdirSync(dir, { recursive: true });
      // Write-then-rename, so a half-written file is never mistaken for a
      // fetched one by the `exists(local)` short-cut above.
      const tmp = `${local}.part-${process.pid}`;
      writeFileSync(tmp, got.bytes);
      renameSync(tmp, local);
      replacements.set(ref.path, local);
    } catch (err) {
      replacements.set(
        ref.path,
        attachmentUnavailableNote(ref.name, `could not be saved (${(err as Error).message})`),
      );
    }
  }
  if (!replacements.size) return text;
  return text.replace(ATTACHMENT_PATH_RE, (path) => replacements.get(path) ?? path);
}

/**
 * How long a runner waits for the server to answer one `attachment` request.
 * A server too old to know the frame never answers; this is what stops that
 * from hanging the turn. Generous, because 25 MB over a slow link is real.
 */
export const ATTACHMENT_FETCH_TIMEOUT_MS = 30_000;

/**
 * The runner's half of the `attachment` exchange: one pending promise per
 * request id, settled by the server's answer or by the timeout — whichever
 * comes first. Unknown or late answers are ignored.
 */
export class AttachmentRequester {
  private seq = 0;
  private readonly pending = new Map<
    string,
    { name: string; settle: (r: FetchResult) => void; timer: ReturnType<typeof setTimeout> }
  >();

  constructor(
    private readonly deps: {
      /** Send the request frame; false when there is no open socket. */
      send: (frame: { t: 'attachment'; id: string; name: string }) => boolean;
      timeoutMs?: number;
    },
  ) {}

  fetch = (name: string): Promise<FetchResult> =>
    new Promise((resolve) => {
      const id = `att-${process.pid}-${++this.seq}`;
      const timeoutMs = this.deps.timeoutMs ?? ATTACHMENT_FETCH_TIMEOUT_MS;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({
          ok: false,
          reason: `the muxpad server did not send it within ${Math.round(timeoutMs / 1000)}s`,
        });
      }, timeoutMs);
      this.pending.set(id, { name, settle: resolve, timer });
      if (!this.deps.send({ t: 'attachment', id, name })) {
        this.settle(id, { ok: false, reason: 'not connected to the muxpad server' });
      }
    });

  /** An `attachment-data` frame arrived. */
  onData(id: unknown, b64: unknown): void {
    if (typeof id !== 'string' || typeof b64 !== 'string') return;
    this.settle(id, { ok: true, bytes: Buffer.from(b64, 'base64') });
  }

  /** An `attachment-missing` frame arrived. */
  onMissing(id: unknown, reason: unknown): void {
    if (typeof id !== 'string') return;
    this.settle(id, {
      ok: false,
      reason: typeof reason === 'string' && reason ? reason : 'the server could not send it',
    });
  }

  private settle(id: string, r: FetchResult): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    clearTimeout(p.timer);
    p.settle(r);
  }
}
