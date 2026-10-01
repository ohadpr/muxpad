// "This session has actually TALKED to someone" — a one-byte durable fact,
// kept because it is the difference between a harmless respawn and a silent
// data loss, and nothing else on disk can tell us which one is happening.
//
// THE PROBLEM. A pane respawns with `--resume <sid>`. The Claude CLI writes a
// session's transcript lazily — the file appears at the FIRST PROMPT, not at
// launch — and `resume` on a sid with no transcript kills the session outright
// ("no conversation found"). So claude.ts drops the resume and starts fresh
// UNDER the same id, which keeps the pane's identity and is exactly right for
// the overwhelmingly common case: a pane that was created and never used.
//
// It is exactly WRONG for the other case. If the session had real turns and its
// transcript is missing anyway — pruned, moved, an unreachable CLAUDE_CONFIG_DIR
// — then "start fresh" silently throws a conversation away, and the log line it
// prints ("no transcript yet") actively misleads, because there is no "yet"
// about it.
//
// Two cases, one observable, and the runner cannot tell them apart from the
// filesystem: an unused session and a lost one both look like "no `<sid>.jsonl`
// anywhere". Hence this mark, written the first time a session takes a turn.
//
// WHY NOT FORCE AN EARLY TRANSCRIPT WRITE INSTEAD. That was the other option on
// the table. It means sending the CLI a synthetic prompt at boot purely to make
// it create the file — a fabricated user message in every new session's
// transcript, a billable turn per pane per respawn, and a race with the real
// first message. A 20-byte marker buys the same knowledge with none of it.
//
// WHY NOT REFUSE TO BOOT. Refusing turns a recoverable pane into a dead one,
// and would fire on every never-used pane. The history is already gone by the
// time we find out; the useful act is to SAY SO, loudly, where a human sees it.

import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** `<dataDir>/agent-sessions` — one empty file per session that has had a turn. */
export function sessionMarkDir(): string {
  return join(process.env.MUXPAD_DATA_DIR ?? join(homedir(), '.muxpad'), 'agent-sessions');
}

function markPath(sid: string): string | null {
  // A sid reaches this from an argv-supplied `--resume`, and it is about to be
  // a path component. Session ids are UUIDs; anything else is not one, and is
  // refused rather than sanitised.
  if (!/^[0-9a-fA-F-]{8,64}$/.test(sid)) return null;
  return join(sessionMarkDir(), sid);
}

/**
 * Record that `sid` has taken at least one turn. Best-effort and idempotent —
 * a failure here must never break a session, it only costs the warning below.
 */
export function markSessionTurned(sid: string): void {
  const p = markPath(sid);
  if (!p) return;
  try {
    mkdirSync(sessionMarkDir(), { recursive: true });
    if (existsSync(p)) {
      // Keep the mtime fresh so a future reaper can age these out by disuse.
      const now = new Date();
      utimesSync(p, now, now);
      return;
    }
    writeFileSync(p, '');
  } catch {
    // Disk gone or unwritable. The mark is diagnostic, never load-bearing.
  }
}

/** Has `sid` ever taken a turn, as far as this machine remembers? */
export function sessionHadTurn(sid: string): boolean {
  const p = markPath(sid);
  if (!p) return false;
  try {
    return existsSync(p);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// THE SECOND MARK: "this session is empty ON PURPOSE."
//
// `/clear` rotates the session id, and the pane ends up pointing at a brand-new
// session with no transcript — which is byte-for-byte the shape the resume
// repair exists to undo (a pointer that DRIFTED onto an empty session while the
// real conversation sits on disk under an older id). Left alone, a restart
// before the next message walks the pane's history, finds the conversation the
// user just cleared, and writes it back: the chat returns, with its context and
// its cost, announced as a recovery.
//
// The two cases differ only by INTENT, and intent exists for one instant — the
// moment the clear is asked for. So it is recorded then, on the sid the clear
// produced, in the same directory and with the same best-effort rules as the
// turn mark above. `<sid>.cleared` can never collide with a sid: markPath's
// charset has no dot in it.
// ---------------------------------------------------------------------------

/** Record that `sid` is the empty session a deliberate `/clear` produced. */
export function markSessionCleared(sid: string): void {
  const p = markPath(sid);
  if (!p) return;
  try {
    mkdirSync(sessionMarkDir(), { recursive: true });
    writeFileSync(`${p}.cleared`, '');
  } catch {
    // Same contract as the turn mark: diagnostic, never load-bearing.
  }
}

/** Was `sid` started by a deliberate `/clear` rather than by a drift? */
export function sessionWasCleared(sid: string): boolean {
  const p = markPath(sid);
  if (!p) return false;
  try {
    return existsSync(`${p}.cleared`);
  } catch {
    return false;
  }
}
