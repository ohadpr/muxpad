// "Has anything actually been said in this pane's chat?"
//
// The conversion routes (`/agent-backend`, `/as-terminal`, `/as-web`) turn a
// pane into a different harness or a plain surface, which means killing its
// runner and respawning. That is fine for a chat nobody has used and
// destructive for one that holds a conversation — so ZERO MESSAGES is the
// precondition, and it is enforced HERE, on the server.
//
// It deliberately does NOT trust the client. The UI only offers conversion
// while a chat looks empty, but "looks empty" is a rendering state: history
// replays asynchronously, so an existing conversation reads as empty for a
// beat on every reconnect. A click landing in that window must not be able to
// destroy a live session, and only the server can guarantee that.
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import { type ChatEvent, normalizeTranscriptLine } from '@muxpad/shared';
import type Database from 'better-sqlite3';
import { AgentQueueStore } from '../store/AgentQueueStore.js';
import { AgentSessionStore } from '../store/AgentSessionStore.js';
import { findTranscript, identityNormalize, muxpadLocate } from './TranscriptReader.js';

/** Bound on the transcript read. We only need to know whether ONE message
 *  exists, and the first ones are at the head — but a transcript can be
 *  gigabytes, so read a window from the START rather than the whole file. */
const PROBE_BYTES = 256 * 1024;

/** Complete lines from the last `maxBytes` of a file (partial first line
 *  dropped). Shared with the /transcript route so both read tails the same way. */
export function readTailLines(path: string, maxBytes: number): string[] {
  const size = statSync(path).size;
  const from = Math.max(0, size - maxBytes);
  const len = size - from;
  if (len <= 0) return [];
  const fd = openSync(path, 'r');
  const buf = Buffer.allocUnsafe(len);
  try {
    readSync(fd, buf, 0, len, from);
  } finally {
    closeSync(fd);
  }
  let text = buf.toString('utf8');
  if (from > 0) {
    // Snap past the (possibly partial) first line so we never parse a torn one.
    const nl = text.indexOf('\n');
    text = nl === -1 ? '' : text.slice(nl + 1);
  }
  return text.split('\n');
}

/**
 * The first `maxBytes` of a file, as complete lines (trailing partial dropped).
 * `complete` says whether the window covered the WHOLE file — the caller needs
 * that to tell "nothing here" from "nothing here YET", which for this probe is
 * the difference between a safe conversion and a destroyed conversation.
 */
function readHeadLines(path: string, maxBytes: number): { lines: string[]; complete: boolean } {
  const size = statSync(path).size;
  const len = Math.min(size, maxBytes);
  if (len <= 0) return { lines: [], complete: true };
  const fd = openSync(path, 'r');
  const buf = Buffer.allocUnsafe(len);
  try {
    readSync(fd, buf, 0, len, 0);
  } finally {
    closeSync(fd);
  }
  const text = buf.toString('utf8');
  const lines = text.split('\n');
  // A truncated read almost certainly cut the last line in half.
  if (len < size) lines.pop();
  return { lines, complete: len >= size };
}

/**
 * True when this pane's chat holds at least one real message (a user turn or
 * an assistant reply), or has one waiting in the send queue.
 *
 * Tool calls, notices and session metadata do NOT count: a session that
 * merely STARTED has none of the user's words in it and is still safe to
 * convert. Anything unreadable is treated as "has messages" — the safe
 * direction, since the cost of a false positive is a refused conversion and
 * the cost of a false negative is a destroyed conversation.
 */
export function agentPaneHasMessages(db: Database.Database, paneId: string): boolean {
  // A queued send is the user's words too, even though no turn has run yet.
  if (new AgentQueueStore(db).count(paneId) > 0) return true;

  const session = new AgentSessionStore(db).getByPane(paneId);
  const sid = session?.current_sid;
  if (!sid) return false; // no session ever recorded → nothing was said

  // Claude writes ~/.claude/projects/**/<sid>.jsonl; codex/cursor write the
  // muxpad-normalized log. Same locator cascade as the transcript route.
  const path = (session.assistant === 'claude' ? findTranscript(sid) : null) ?? muxpadLocate(sid);
  if (!path || !existsSync(path)) return false; // session started, never spoke

  const normalize = session.assistant === 'claude' ? normalizeTranscriptLine : identityNormalize;
  let head: { lines: string[]; complete: boolean };
  try {
    head = readHeadLines(path, PROBE_BYTES);
  } catch {
    return true; // unreadable → refuse to convert rather than risk the history
  }
  for (const line of head.lines) {
    if (!line.trim()) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue; // torn/garbage line — skip
    }
    let events: ChatEvent[];
    try {
      events = normalize(obj);
    } catch {
      continue;
    }
    for (const e of events) {
      if (e.kind === 'user' || e.kind === 'assistant') return true;
    }
  }
  // We saw no message — but if the window did not cover the whole transcript,
  // "no message" is only true of the part we read. A single JSONL record can
  // exceed 256 KiB (a pasted file, a large tool result), and a head full of
  // session metadata can push the first user turn past the boundary; the
  // partial last line is dropped, so that turn is invisible to us. Uncertain
  // must resolve the same way unreadable does: HAS messages. The cost of being
  // wrong here is a refused conversion; the cost the other way is a destroyed
  // conversation.
  return !head.complete;
}
