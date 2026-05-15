export interface ChunkedWriterOptions {
  chunkSize: number;
  raf: (cb: FrameRequestCallback) => number;
}

/**
 * Caps each downstream write at `chunkSize` characters and defers chunking
 * to the next animation frame. Without the cap, multi-MB writes (reconnect
 * ring-buffer replay, cat of a large file) can stall xterm's WebGL renderer
 * and produce torn frames during heavy streaming.
 */
export class ChunkedWriter {
  private pending = '';
  private scheduled = false;
  constructor(
    private readonly write: (s: string) => void,
    private readonly opts: ChunkedWriterOptions,
  ) {}

  push(data: string): void {
    this.pending += data;
    if (!this.scheduled) {
      this.scheduled = true;
      this.opts.raf(() => this.flush());
    }
  }

  private flush(): void {
    this.scheduled = false;
    const { chunkSize } = this.opts;
    let buf = this.pending;
    this.pending = '';
    while (buf.length > 0) {
      const slice = buf.slice(0, chunkSize);
      buf = buf.slice(chunkSize);
      this.write(slice);
    }
  }

  dispose(): void {
    this.pending = '';
    this.scheduled = false;
  }
}

const SYNC_BEGIN = '\x1b[?2026h';
const SYNC_END = '\x1b[?2026l';

export interface SyncBlockExtractorOptions {
  raf: (cb: FrameRequestCallback) => number;
  /** Force-flush a held sync block if it's been outstanding this long. */
  maxHoldMs?: number;
}

/**
 * Holds data between DEC 2026 sync-block markers (\x1b[?2026h / \x1b[?2026l)
 * so a downstream xterm.write() only ever sees complete frames. Claude Code
 * (Ink) emits a redraw as one logical frame, but the network can split it
 * across packets; without coalescing, xterm paints torn frames during heavy
 * streaming. When markers are absent, data passes straight through. A
 * `maxHoldMs` safety timer prevents a stuck half-frame from freezing output.
 */
export class SyncBlockExtractor {
  private buf = '';
  private holding = false;
  private holdStartedAt = 0;
  private scheduled = false;
  constructor(
    private readonly emit: (s: string) => void,
    private readonly opts: SyncBlockExtractorOptions,
  ) {}

  push(data: string): void {
    this.buf += data;
    this.drain();
    if (!this.scheduled) {
      this.scheduled = true;
      this.opts.raf(() => {
        this.scheduled = false;
        this.drain();
      });
    }
  }

  /** Emit anything we can; hold partial sync blocks. */
  private drain(): void {
    while (this.buf.length > 0) {
      if (!this.holding) {
        const begin = this.buf.indexOf(SYNC_BEGIN);
        if (begin < 0) {
          this.emit(this.buf);
          this.buf = '';
          return;
        }
        if (begin > 0) this.emit(this.buf.slice(0, begin));
        this.buf = this.buf.slice(begin + SYNC_BEGIN.length);
        this.holding = true;
        this.holdStartedAt = Date.now();
      }
      const end = this.buf.indexOf(SYNC_END);
      if (end < 0) return; // wait for more
      this.emit(this.buf.slice(0, end));
      this.buf = this.buf.slice(end + SYNC_END.length);
      this.holding = false;
    }
  }

  /** External force-flush hook (called on a timer). */
  flushStale(nowMs: number): void {
    const hold = this.opts.maxHoldMs ?? 50;
    if (this.holding && nowMs - this.holdStartedAt >= hold) {
      this.emit(this.buf);
      this.buf = '';
      this.holding = false;
    }
  }

  /** Synchronous drain — used in tests. */
  flush(): void {
    this.drain();
  }

  dispose(): void {
    this.buf = '';
    this.holding = false;
    this.scheduled = false;
  }
}
