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

export type TailPhase = 'history' | 'live';

export interface TranscriptTailOpts {
  onEvents: (events: ChatEvent[], phase: TailPhase) => void;
  /** Override the projects dir (tests). */
  dir?: string;
  /** Poll interval for `start()`. Tests drive `tick()` directly instead. */
  pollMs?: number;
}

/**
 * Tails a Claude transcript file for one session id: emits everything already
 * on disk as `history`, then streams appended lines as `live`. Byte-offset
 * based with a carry buffer, so a half-written trailing line is never parsed
 * until its newline lands. If the file shrinks (a `/compact` rewrite), it
 * resets and re-emits from the top as `history` — the client dedupes by event
 * id.
 *
 * S1 (docs/plans/2026-07-01-...) confirmed this is safe against a live writer:
 * lines land newline-delimited and atomically.
 */
export class TranscriptTail {
  private offset = 0;
  private carry = '';
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
    if (size < this.offset) {
      // File shrank → rewrite/compaction. Reset and re-emit from the top.
      this.offset = 0;
      this.carry = '';
      this.readRange(size, 'history');
    } else if (size > this.offset) {
      this.readRange(size, this.offset === 0 ? 'history' : 'live');
    }
  }

  private readRange(to: number, phase: TailPhase): void {
    const from = this.offset;
    const len = to - from;
    if (len <= 0) return;
    const fd = openSync(this.path as string, 'r');
    const buf = Buffer.allocUnsafe(len);
    try {
      readSync(fd, buf, 0, len, from);
    } finally {
      closeSync(fd);
    }
    this.offset = to;
    const text = this.carry + buf.toString('utf8');
    const parts = text.split('\n');
    this.carry = parts.pop() ?? ''; // trailing (possibly partial) line
    const events: ChatEvent[] = [];
    for (const line of parts) {
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
