import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { type ChatEvent, normalizeTranscriptLine } from '@muxpad/shared';

/**
 * muxpad-owned normalized transcript log — used by backends (Codex/Cursor) that
 * don't write a Claude-format JSONL file. The runner appends ready-made
 * ChatEvents here as it streams a turn; the server tails it with the identity
 * normalizer below. Keyed by the backend's session ref (stable across resume).
 */
export function muxpadTranscriptDir(): string {
  return join(process.env.MUXPAD_DATA_DIR ?? join(homedir(), '.muxpad'), 'agent-transcripts');
}
export function muxpadTranscriptPath(sid: string): string {
  return join(muxpadTranscriptDir(), `${sid}.jsonl`);
}
/** Locator for a muxpad log (mirrors findTranscript's null-until-exists shape). */
export function muxpadLocate(sid: string): string | null {
  const p = muxpadTranscriptPath(sid);
  try {
    return statSync(p).isFile() ? p : null;
  } catch {
    return null;
  }
}
/** Our own log lines already ARE ChatEvents — no schema translation. */
export function identityNormalize(obj: unknown): ChatEvent[] {
  return obj && typeof obj === 'object' ? [obj as ChatEvent] : [];
}
/** Append one ChatEvent to a session's muxpad log (best-effort, creates dir). */
export function appendTranscriptEvent(sid: string, event: ChatEvent): void {
  const p = muxpadTranscriptPath(sid);
  mkdirSync(muxpadTranscriptDir(), { recursive: true });
  appendFileSync(p, `${JSON.stringify(event)}\n`);
}

/**
 * Move a session's accumulated log to a new id. Codex/Cursor mint a fresh
 * provider id when a resume re-mints or falls back to a new session; the log is
 * keyed by that id and the server tails whatever id the runner hellos, so
 * without this the pre-change conversation would orphan under the old filename.
 * Best-effort: prepends the old history to the (usually empty) new file, then
 * removes the old one. No-op if there's no old log or the ids match.
 */
export function migrateTranscript(oldSid: string, newSid: string): void {
  if (!oldSid || oldSid === newSid) return;
  const oldPath = muxpadTranscriptPath(oldSid);
  let prior: Buffer;
  try {
    if (!statSync(oldPath).isFile()) return;
    prior = readFileSync(oldPath);
  } catch {
    return; // no prior log to carry over
  }
  try {
    mkdirSync(muxpadTranscriptDir(), { recursive: true });
    const newPath = muxpadTranscriptPath(newSid);
    let existing: Buffer | null = null;
    try {
      existing = readFileSync(newPath);
    } catch {
      // new file doesn't exist yet — the common case
    }
    // Old history first, then anything already under the new id.
    writeFileSync(newPath, existing ? Buffer.concat([prior, existing]) : prior);
    rmSync(oldPath, { force: true });
  } catch {
    // best-effort — leave both files rather than lose data
  }
}

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
  /**
   * Fired with the session's AI-generated title whenever an `ai-title` record
   * passes through the tail (Claude writes one after the first turn and on
   * topic shifts). Not fired for `older` pages — back-scrolling must never
   * regress the name to an earlier title. Used to auto-name agent panes/tabs.
   */
  onTitle?: (title: string) => void;
  /** Override the projects dir (tests). */
  dir?: string;
  /**
   * How to find the session's transcript file. Default: Claude's
   * `findTranscript` (scan ~/.claude/projects for `<sid>.jsonl`). Non-Claude
   * backends pass {@link muxpadLocate} to read the runner-written normalized log.
   */
  locate?: (sid: string) => string | null;
  /**
   * How to turn one raw JSONL line-object into ChatEvents. Default: Claude's
   * `normalizeTranscriptLine`. Non-Claude backends pass {@link identityNormalize}
   * (their log lines already ARE ChatEvents).
   */
  normalize?: (obj: unknown) => ChatEvent[];
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
  /**
   * Grow the initial tail window (up to 8× tailBytes) until it holds at
   * least this many complete lines — a fixed byte window starves on
   * image-heavy transcripts whose single lines run to hundreds of KB.
   * Default 30; tests pin it lower to exercise pure byte-window paging.
   */
  minHistoryLines?: number;
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
      const locate = this.opts.locate ?? ((sid) => findTranscript(sid, this.opts.dir ?? projectsDir()));
      this.path = locate(this.sid);
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
    const tb = this.opts.tailBytes ?? 65536;
    // The page must start on a COMPLETE line boundary before `to` or
    // historyStart can't move. A single giant line (base64 image pastes run
    // to hundreds of KB) can swallow a whole window two ways: no newline at
    // all, or its terminating newline as the window's very last byte
    // (`to - 1`) — the partial-line snap then lands exactly back on `to`,
    // emitting nothing and spinning hasMore=true forever (the "chat shows
    // one message and can't scroll" bug). Scan BACKWARD one window at a
    // time, each iteration reading only the newly extended chunk — a line
    // spanning k windows costs one pass over its bytes, not O(k²) re-reads
    // of an ever-growing range.
    let from = Math.max(0, to - tb);
    let chunkEnd = to;
    let lineStart = -1;
    for (;;) {
      if (from === 0) {
        // Reached the file start — no partial leading line to snap past.
        lineStart = 0;
        break;
      }
      const chunk = this.readBytes(from, chunkEnd);
      if (!chunk) return false;
      // First newline in this chunk, ignoring the boundary newline at
      // `to - 1` itself (it yields lineStart === to: zero progress).
      let nl = chunk.indexOf(NL);
      if (chunkEnd === to && nl === chunk.length - 1) nl = -1;
      if (nl !== -1) {
        lineStart = from + nl + 1;
        break;
      }
      chunkEnd = from;
      from = Math.max(0, from - tb);
    }
    this.historyStart = lineStart;
    const out = this.readBytes(lineStart, to);
    if (!out) return false;
    // The range ends at `to` (a line boundary), so the last split part is ''
    // — no carry to manage here; emit() skips blank lines.
    this.emit(out.toString('utf8').split('\n'), 'older');
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
    // Tail only — but RECORD-count-aware, not a blind byte window: on
    // image-heavy transcripts (single lines run to hundreds of KB) a fixed
    // byte tail can hold under one screenful of records, forcing the client
    // into a burst of older-pages on every open. Grow the window until it
    // holds a reasonable number of complete lines, within a hard byte cap.
    const MIN_HISTORY_LINES = this.opts.minHistoryLines ?? 30;
    const maxWin = Math.min(size, tb * 8);
    let win = tb;
    let buf: Buffer | null = null;
    let nl = -1;
    for (;;) {
      buf = this.readBytes(size - win, size);
      if (!buf) {
        this.initialized = false;
        return;
      }
      nl = buf.indexOf(NL);
      if (win >= maxWin) break;
      if (nl !== -1) {
        let lines = 0;
        for (let i = nl; i !== -1 && lines < MIN_HISTORY_LINES; i = buf.indexOf(NL, i + 1)) {
          lines++;
        }
        if (lines >= MIN_HISTORY_LINES) break;
      }
      win = Math.min(win * 2, maxWin);
    }
    const from = size - win;
    if (nl === -1 || win >= size) {
      // Window reaches the file start (or is one unterminated line) →
      // treat as a full read from 0.
      const full = win >= size ? buf : this.readBytes(0, size);
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
      if (
        phase !== 'older' &&
        this.opts.onTitle &&
        typeof obj === 'object' &&
        obj !== null &&
        (obj as { type?: unknown }).type === 'ai-title' &&
        typeof (obj as { aiTitle?: unknown }).aiTitle === 'string'
      ) {
        this.opts.onTitle((obj as { aiTitle: string }).aiTitle);
      }
      events.push(...(this.opts.normalize ?? normalizeTranscriptLine)(obj));
    }
    if (events.length) this.opts.onEvents(events, phase);
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
  }
}
