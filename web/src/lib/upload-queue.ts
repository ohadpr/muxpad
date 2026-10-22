/**
 * THE COMPOSER'S UPLOAD QUEUE — what makes a multi-file attach legible.
 *
 * What it replaced: a `for (const f of files) await upload(f)` loop behind one
 * boolean. Picking five photos showed a spinning paperclip and nothing else —
 * no count, no order, no sizes, no way to tell a stalled 300 MB video from a
 * finished one, and no way to cancel. The chips appeared one at a time, after
 * each upload finished, so the UI's first news of a file was that it was
 * already done. On a 512 MB ceiling (this route takes screen recordings) that
 * is minutes of a screen that says only "something is happening".
 *
 * So the queue is a value with a shape a UI can render:
 *
 *   · every picked file EXISTS IMMEDIATELY, in `queued`, in pick order — the
 *     row of chips is the receipt for the pick, drawn before a byte moves;
 *   · each item carries `loaded`/`size`, so a chip can draw a real bar and the
 *     strip above them can say "2 of 5 · 61 MB of 184 MB";
 *   · `cancel` aborts the transfer rather than hiding its result, and `retry`
 *     exists because the alternative after a dropped connection is re-opening
 *     the picker and finding the file again.
 *
 * It is a plain class with an injected `upload`, so all of that is testable
 * without a DOM, a server or a React tree — which is the other half of why it
 * is not a `useState` tangle inside the composer.
 */

export type UploadState = 'queued' | 'uploading' | 'done' | 'error' | 'canceled';

export interface UploadItem {
  readonly id: string;
  readonly name: string;
  /** Bytes, from the File. 0 for a blob that does not know (rare; a paste). */
  readonly size: number;
  /** Bytes sent so far. Equals `size` on `done` so a finished bar reads full. */
  readonly loaded: number;
  readonly state: UploadState;
  /** The server path, once it has one. The thing the message actually sends. */
  readonly path?: string;
  /** A sentence for the user, already unwrapped from the server's envelope. */
  readonly error?: string;
}

/** Performs one transfer. Injected so the queue can be tested, and so the
 *  composer can keep its own error-unwrapping in one place. */
export type UploadFn = (
  file: File | Blob,
  name: string,
  handlers: { onProgress: (loaded: number, total: number | null) => void; signal: AbortSignal },
) => Promise<{ path: string }>;

interface Entry {
  item: UploadItem;
  file: File | Blob;
  controller: AbortController | null;
}

/**
 * TWO AT A TIME.
 *
 * One is the old behaviour and wastes the link on a pick of twenty photos.
 * Unbounded is worse than it looks: every transfer competes for the same
 * uplink, so the FIRST file finishes last, and a UI whose whole point is
 * "where are my files" shows twenty bars crawling together and nothing
 * arriving. Two keeps the link busy while the first item still finishes first,
 * which is what makes the progress readable.
 */
const DEFAULT_CONCURRENCY = 2;

export class UploadQueue {
  private entries: Entry[] = [];
  private seq = 0;
  private running = 0;
  constructor(
    private readonly upload: UploadFn,
    private readonly onChange: (items: UploadItem[]) => void,
    private readonly concurrency = DEFAULT_CONCURRENCY,
  ) {}

  items(): UploadItem[] {
    return this.entries.map((e) => e.item);
  }

  /** Queue files and start pumping. Returns the ids, in pick order. */
  add(files: { file: File | Blob; name: string }[]): string[] {
    const ids: string[] = [];
    for (const f of files) {
      const id = `u${++this.seq}`;
      ids.push(id);
      this.entries.push({
        file: f.file,
        controller: null,
        item: { id, name: f.name, size: f.file.size ?? 0, loaded: 0, state: 'queued' },
      });
    }
    this.emit();
    this.pump();
    return ids;
  }

  /**
   * Take in an attachment that is ALREADY on the server — editing a queued
   * message pulls its files back into the composer, and those were uploaded
   * when it was first sent. They enter `done`, with their path, so the chip
   * row is one list with one set of rules rather than two lists that have to
   * agree about which is which.
   */
  adopt(files: { name: string; path: string; size?: number }[]): string[] {
    const ids: string[] = [];
    for (const f of files) {
      const id = `u${++this.seq}`;
      ids.push(id);
      this.entries.push({
        file: new Blob(),
        controller: null,
        item: {
          id,
          name: f.name,
          size: f.size ?? 0,
          loaded: f.size ?? 0,
          state: 'done',
          path: f.path,
        },
      });
    }
    this.emit();
    return ids;
  }

  /** Stop a transfer, or drop one that has not started. Deliberately keeps the
   *  item — a chip that vanishes mid-upload is indistinguishable from a bug;
   *  `canceled` says what happened and `remove` is the user's next click. */
  cancel(id: string): void {
    const e = this.entries.find((x) => x.item.id === id);
    if (!e || e.item.state === 'done') return;
    e.controller?.abort();
    this.patch(id, { state: 'canceled', loaded: 0 });
    this.pump();
  }

  /** A failed or canceled item goes back to the end of the queue. The file is
   *  still here, which is the point: the alternative is the picker again. */
  retry(id: string): void {
    const e = this.entries.find((x) => x.item.id === id);
    if (!e || (e.item.state !== 'error' && e.item.state !== 'canceled')) return;
    const { error: _dropped, ...rest } = e.item;
    e.item = { ...rest, state: 'queued', loaded: 0 };
    this.emit();
    this.pump();
  }

  /** Forget an item. Aborts first if it is still moving, so removing a chip
   *  mid-flight does not leave an orphan transfer writing to disk. */
  remove(id: string): void {
    const e = this.entries.find((x) => x.item.id === id);
    if (!e) return;
    if (e.item.state === 'uploading' || e.item.state === 'queued') e.controller?.abort();
    this.entries = this.entries.filter((x) => x.item.id !== id);
    this.emit();
    this.pump();
  }

  /** Everything, after a send or a pane change. */
  clear(): void {
    for (const e of this.entries)
      if (e.item.state === 'uploading' || e.item.state === 'queued') e.controller?.abort();
    this.entries = [];
    this.emit();
  }

  private patch(id: string, patch: Partial<UploadItem>): void {
    const e = this.entries.find((x) => x.item.id === id);
    if (!e) return;
    e.item = { ...e.item, ...patch };
    this.emit();
  }

  private emit(): void {
    this.onChange(this.items());
  }

  private pump(): void {
    while (this.running < this.concurrency) {
      const next = this.entries.find((e) => e.item.state === 'queued');
      if (!next) return;
      this.running += 1;
      void this.run(next);
    }
  }

  private async run(entry: Entry): Promise<void> {
    const { id } = entry.item;
    const controller = new AbortController();
    entry.controller = controller;
    this.patch(id, { state: 'uploading', loaded: 0 });
    try {
      const { path } = await this.upload(entry.file, entry.item.name, {
        signal: controller.signal,
        onProgress: (loaded) => {
          // A progress frame for an item the user has since canceled or
          // removed must not resurrect it: `patch` is a no-op for a removed
          // id, and the state guard covers the canceled one.
          const cur = this.entries.find((x) => x.item.id === id)?.item;
          if (cur?.state === 'uploading') this.patch(id, { loaded });
        },
      });
      // The size the FILE reported is what every bar was drawn against; a
      // finished item sets loaded = size so the last frame is full rather than
      // 99% from a rounding difference in the last progress event.
      const size = this.entries.find((x) => x.item.id === id)?.item.size ?? 0;
      this.patch(id, { state: 'done', path, loaded: size });
    } catch (error) {
      const canceled =
        (error instanceof DOMException && error.name === 'AbortError') ||
        (error instanceof Error && error.name === 'AbortError');
      // A cancel already wrote its own state, and the abort that follows must
      // not overwrite it with a failure the user caused on purpose.
      if (!canceled)
        this.patch(id, {
          state: 'error',
          error: error instanceof Error ? error.message : String(error),
        });
    } finally {
      entry.controller = null;
      this.running -= 1;
      this.pump();
    }
  }
}

/** Bytes, for a human, in as few characters as possible: the strip this goes
 *  in is one line on a 320px phone. */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 MB';
  if (n < 1000) return `${n} B`;
  if (n < 1000 * 1000) return `${Math.round(n / 1000)} KB`;
  const mb = n / (1000 * 1000);
  if (mb < 1000) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  return `${(mb / 1000).toFixed(1)} GB`;
}

export interface UploadSummary {
  /** Items still queued or uploading. Zero means the strip should not draw. */
  active: number;
  /** How many of the in-flight batch have landed, and out of how many. */
  done: number;
  total: number;
  loaded: number;
  bytes: number;
  /** 0-100 across the whole batch, by BYTES — see below. */
  pct: number;
  failed: number;
}

/**
 * The one-line answer for a batch.
 *
 * PROGRESS IS BY BYTES, NOT BY FILE COUNT. "2 of 5" moves in five jumps and
 * sits still through the 300 MB video that is the only reason anybody is
 * watching; the byte ratio moves continuously and is the honest answer to "how
 * much longer". The count rides along because it is what names WHICH file.
 *
 * Canceled items leave the batch entirely — they are not failures and counting
 * them would make a batch the user deliberately trimmed look stuck.
 */
export function summarize(items: readonly UploadItem[]): UploadSummary {
  const batch = items.filter((i) => i.state !== 'canceled');
  const active = batch.filter((i) => i.state === 'queued' || i.state === 'uploading').length;
  const done = batch.filter((i) => i.state === 'done').length;
  const bytes = batch.reduce((n, i) => n + i.size, 0);
  const loaded = batch.reduce((n, i) => n + (i.state === 'done' ? i.size : i.loaded), 0);
  return {
    active,
    done,
    total: batch.length,
    loaded,
    bytes,
    // A batch of blobs with no size (a paste) would divide by zero; fall back
    // to the file count so the bar still moves.
    pct:
      bytes > 0
        ? Math.min(100, (loaded / bytes) * 100)
        : batch.length
          ? (done / batch.length) * 100
          : 0,
    failed: batch.filter((i) => i.state === 'error').length,
  };
}

/** What the strip says. Short by construction: it shares a 320px line with a
 *  cancel button, and the per-file detail is on the chips right below it. */
export function summaryLabel(s: UploadSummary): string {
  if (s.active === 0) return s.failed > 0 ? `${s.failed} failed` : '';
  const which = s.total > 1 ? `${Math.min(s.done + 1, s.total)} of ${s.total} · ` : '';
  const size = s.bytes > 0 ? ` · ${formatBytes(s.loaded)} of ${formatBytes(s.bytes)}` : '';
  return `${which}${Math.floor(s.pct)}%${size}`;
}
