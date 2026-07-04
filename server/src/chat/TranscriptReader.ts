import { closeSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { type ChatEvent, normalizeTranscriptLine } from '@muxpad/shared';

/** ~/.claude/projects (or $CLAUDE_CONFIG_DIR/projects). */
export function projectsDir(): string {
  const base = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  return join(base, 'projects');
}

/**
 * Locate a session's transcript by its id. The filename IS the session-id
 * (a UUID) and is globally unique, so we scan project dirs for `<sid>.jsonl`
 * rather than trying to invert the lossy cwd→dir-name encoding (the encoding
 * collapses every non-alphanumeric char to `-`, so it isn't reversible —
 * opcode/CloudCLI hit the same wall). Returns null until the file exists
 * (Claude creates it on the first prompt, not at launch).
 */
export function findTranscript(sid: string, dir = projectsDir()): string | null {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  for (const d of entries) {
    const candidate = join(dir, d, `${sid}.jsonl`);
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // not this dir
    }
  }
  return null;
}

export type TailPhase = 'history' | 'live' | 'older';

export interface TranscriptTailOpts {
  onEvents: (events: ChatEvent[], phase: TailPhase) => void;
  /** Override the projects dir (tests). */
  dir?: string;
  /** Poll interval for `start()`. Tests drive `tick()` directly instead. */
  pollMs?: number;
  /**
   * When set, the initial history load reads only the last ~this many bytes of
   * the file (snapped to a line boundary) instead of the whole thing — so
   * opening a chat with a 90 MB transcript doesn't ship 90 MB over the socket.
   * Older history is fetched on demand via {@link loadOlder}. Undefined = load
   * the whole file (the original behaviour).
   */
  tailBytes?: number;
}

const NL = 0x0a; // '\n' — newline byte, for line-boundary math on the raw buffer

/**
 * Tails a Claude transcript file for one session id: emits `history` (either the
 * whole file, or just the recent tail when `tailBytes` is set), then streams
 * appended lines as `live`. Byte-offset based with a carry buffer, so a
 * half-written trailing line is never parsed until its newline lands. If the
 * file shrinks (a `/compact` rewrite), it resets and re-emits as `history` — the
 * client dedupes by event id.
 *
 * With `tailBytes`, `loadOlder()` walks backward a chunk at a time (emitting
 * `older`) so the client can page in earlier messages on scroll-up. All offset
 * math is on raw bytes (not decoded chars) so multibyte UTF-8 can't desync it.
 *
 * S1 (docs/plans/2026-07-01-...) confirmed this is safe against a live writer:
 * lines land newline-delimited and atomically.
 */
export class TranscriptTail {
  private offset = 0; // live read pointer — sits at EOF after init
  private carry = ''; // trailing partial line, prepended to the next live read
  private historyStart = 0; // byte offset of the oldest loaded line (for loadOlder)
  private initialized = false;
  private path: string | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private closed = false;

  constructor(
    private readonly sid: string,
    private readonly opts: TranscriptTailOpts,
  ) {}

  /** Begin polling. Fires an immediate tick, then every `pollMs` (default 250). */
  start(): void {
    this.tick();
    this.timer = setInterval(() => this.tick(), this.opts.pollMs ?? 250);
  }

  /** One read cycle. Public so tests can drive it without timers. */
  tick(): void {
    if (this.closed) return;
    if (!this.path) {
      this.path = findTranscript(this.sid, this.opts.dir ?? projectsDir());
      if (!this.path) return; // file not created yet (no first prompt)
    }
    let size: number;
    try {
      size = statSync(this.path).size;
    } catch {
      this.path = null; // vanished (moved/deleted); re-resolve next tick
      return;
    }
    if (!this.initialized) {
      // Set BEFORE loadHistory: its failure paths reset `initialized` to false
      // to retry next tick — assigning after the call would clobber that signal
      // and the next tick would misread the whole file as a `live` append.
      this.initialized = true;
      this.loadHistory(size);
      return;
    }
    if (size < this.offset) {
      // File shrank → rewrite/compaction. Reset and re-load history.
      this.offset = 0;
      this.carry = '';
      this.historyStart = 0;
      this.loadHistory(size);
      return;
    }
    if (size > this.offset) {
      const buf = this.readBytes(this.offset, size);
      if (!buf) return;
      this.offset = size;
      const text = this.carry + buf.toString('utf8');
      const parts = text.split('\n');
      this.carry = parts.pop() ?? ''; // trailing (possibly partial) line
      this.emit(parts, 'live');
    }
  }

  /**
   * Page in the chunk of history immediately before what's already loaded.
   * Emits those events as `older` (chronological). Returns true if still more
   * history remains before this batch, false once the file start is reached.
   */
  loadOlder(): boolean {
    if (this.closed || !this.path || this.historyStart <= 0) return false;
    const to = this.historyStart; // always a line boundary (byte after a '\n')
    const from = Math.max(0, to - (this.opts.tailBytes ?? 65536));
    const buf = this.readBytes(from, to);
    if (!buf) return false;
    // Snap past the partial leading line unless we've reached the file start;
    // its full copy arrives on the next loadOlder (this chunk's from = its to).
    let sliceFrom = 0;
    let newStart = 0;
    if (from > 0) {
      const nl = buf.indexOf(NL);
      if (nl === -1) {
        // One line longer than the window — read from the file start to
        // guarantee forward progress instead of spinning on the same chunk.
        const full = this.readBytes(0, to);
        if (full) {
          this.historyStart = 0;
          this.emit(full.toString('utf8').split('\n'), 'older');
        }
        return false;
      }
      sliceFrom = nl + 1;
      newStart = from + nl + 1;
    }
    this.historyStart = newStart;
    // buf ends at `to` (a line boundary), so the last split part is '' — no
    // carry to manage here; emit() skips blank lines.
    this.emit(buf.toString('utf8', sliceFrom).split('\n'), 'older');
    return this.historyStart > 0;
  }

  private loadHistory(size: number): void {
    const tb = this.opts.tailBytes;
    if (!tb || size <= tb) {
      // Whole file as history.
      const buf = this.readBytes(0, size);
      if (!buf) {
        this.initialized = false;
        return;
      }
      this.historyStart = 0;
      this.offset = size;
      const parts = buf.toString('utf8').split('\n');
      this.carry = parts.pop() ?? '';
      this.emit(parts, 'history');
      return;
    }
    // Tail only: read the last `tb` bytes, drop the partial leading line.
    const from = size - tb;
    const buf = this.readBytes(from, size);
    if (!buf) {
      this.initialized = false;
      return;
    }
    const nl = buf.indexOf(NL);
    if (nl === -1) {
      // The whole tail window is one unterminated line → fall back to full read.
      const full = this.readBytes(0, size);
      if (!full) {
        this.initialized = false;
        return;
      }
      this.historyStart = 0;
      this.offset = size;
      const parts = full.toString('utf8').split('\n');
      this.carry = parts.pop() ?? '';
      this.emit(parts, 'history');
      return;
    }
    this.historyStart = from + nl + 1;
    this.offset = size;
    const parts = buf.toString('utf8', nl + 1).split('\n');
    this.carry = parts.pop() ?? ''; // trailing partial (a live writer at EOF)
    this.emit(parts, 'history');
  }

  /** Read [from, to) as a Buffer; null if the file rotated out from under us. */
  private readBytes(from: number, to: number): Buffer | null {
    const len = to - from;
    if (len <= 0) return Buffer.alloc(0);
    try {
      const fd = openSync(this.path as string, 'r');
      const buf = Buffer.allocUnsafe(len);
      try {
        readSync(fd, buf, 0, len, from);
      } finally {
        closeSync(fd);
      }
      return buf;
    } catch {
      // Rotated/removed between statSync and open (a /compact rewrite or a
      // resume rotating the file). Never throw out of the poll timer — drop the
      // path and re-resolve next tick.
      this.path = null;
      return null;
    }
  }

  private emit(lines: string[], phase: TailPhase): void {
    const events: ChatEvent[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      let obj: unknown;
      try {
        obj = JSON.parse(line);
      } catch {
        continue; // torn/garbage line — skip, never break the feed
      }
      events.push(...normalizeTranscriptLine(obj));
    }
    if (events.length) this.opts.onEvents(events, phase);
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
  }
}
