import { type ChatEvent, expandChatEvent, normalizeTranscriptLine } from '@muxpad/shared';
import type Database from 'better-sqlite3';
import { AgentSessionStore } from '../store/AgentSessionStore.js';
import { PaneStore } from '../store/PaneStore.js';
import { TabStore } from '../store/TabStore.js';
import { identityNormalize } from './TranscriptReader.js';
import { readTailLines } from './has-messages.js';
import { transcriptForPane } from './transcript-access.js';

/**
 * THE LAST MESSAGE A CHAT HAD — the second line of a row in the phone's
 * Activity list, the way Slack's DM list shows each conversation's latest
 * message under its name.
 *
 * ─── Why this is not a field on the tab row ──────────────────────────────
 * The tab row rides `GET /api/tabs` and `/api/tabs/all`, which every device
 * polls every five seconds, across 1,100+ chats. A 160-character preview on
 * every row is ~180 KB more per `/all` poll for a line that ONE surface reads,
 * about twenty chats at a time. So it is served by its own request
 * (`GET /api/tabs/previews?ids=…`), asked for only by the Activity list, only
 * for the rows it is showing.
 *
 * ─── Why it is not stored either ─────────────────────────────────────────
 * It is a pure function of the transcript tail, and the transcript is the
 * record. Memoised in memory on `(tab id, last_activity_at)`: a chat that has
 * not moved is answered without touching the disk, and one that has is read
 * once — a bounded tail read, no model call. No migration, no writer to keep
 * in step with every road a message can arrive by, and a restart costs one
 * re-read per chat the list actually shows.
 */

/** Long enough for two lines on a phone, short enough to never be a wall. */
export const PREVIEW_MAX_CHARS = 160;
/** The same tail the headline reads: enough for the last few turns, bounded. */
const TAIL_BYTES = 64 * 1024;

export interface LastMessage {
  /** One line, whitespace collapsed, truncated with an ellipsis. */
  text: string;
  /** Who said it — the list prefixes the user's own lines with "You:". */
  by: 'user' | 'assistant';
}

/**
 * What a row gets back: the message, or WHY there is none when the reason is
 * one the row should say. A chat on ANOTHER MACHINE has its transcript there,
 * and this server deliberately cannot read it (transcript-access) — that is a
 * design decision, not a failure, and the row says so instead of looking
 * broken. Every other absence (a terminal, a chat with nothing said yet) is
 * plain `null`.
 */
export type Preview = LastMessage | { elsewhere: true };

/**
 * The last message a PERSON would see in the chat, out of normalized events.
 *
 * Pure. Three things are not messages, and each would make the line lie:
 *   · folded user events — a cron's injected prompt, a batch of sub-chat
 *     reports. Plumbing nobody typed.
 *   · in Chat mode, the assistant's plain text, which is its PRIVATE
 *     scratchpad; only `voice: 'reply'` reached the user. A tail that holds
 *     any reply is treated as Chat mode, so the scratchpad never leaks here.
 *   · empty text (a tool-only turn).
 */
export function lastMessageOf(events: readonly ChatEvent[]): LastMessage | null {
  const chatMode = events.some((e) => e.kind === 'assistant' && e.voice === 'reply');
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (!e) continue;
    if (e.kind === 'user') {
      if (e.folded) continue;
      const text = oneLine(e.text);
      if (text) return { text, by: 'user' };
      continue;
    }
    if (e.kind === 'assistant') {
      if (chatMode && e.voice !== 'reply') continue;
      const text = oneLine(e.text);
      if (text) return { text, by: 'assistant' };
    }
  }
  return null;
}

export function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > PREVIEW_MAX_CHARS ? `${flat.slice(0, PREVIEW_MAX_CHARS - 1)}…` : flat;
}

/** Read one pane's transcript tail and answer {@link lastMessageOf}. */
function lastMessageForPane(db: Database.Database, paneId: string): Preview | null {
  const sess = new AgentSessionStore(db).getByPane(paneId);
  // Through the chokepoint, like every other transcript read: a pane on
  // another machine must not cause a search of this disk. Asked BEFORE the
  // session is required — the machine is decided by the pane alone, and a
  // remote chat whose session this server never saw is still a remote chat.
  const access = transcriptForPane(db, paneId, sess?.current_sid ?? null, sess?.assistant);
  if (access.kind === 'elsewhere') return { elsewhere: true };
  if (access.kind !== 'local' || !sess) return null;
  let lines: string[];
  try {
    lines = readTailLines(access.path, TAIL_BYTES);
  } catch {
    return null;
  }
  const claude = sess.assistant === 'claude';
  const events: ChatEvent[] = [];
  for (const line of lines) {
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    for (const ev of (claude
      ? normalizeTranscriptLine(obj)
      : identityNormalize(obj)) as ChatEvent[]) {
      // The other road: codex/cursor logs are already normalized, so the
      // cron/report/mention lifts that Claude's normalizer applies have to be
      // applied here (see expandChatEvent).
      if (claude) events.push(ev);
      else events.push(...expandChatEvent(ev));
    }
  }
  return lastMessageOf(events);
}

const memo = new Map<string, { at: number | null; value: Preview | null }>();

/**
 * Previews for a set of tabs, memoised on each tab's `last_activity_at`.
 * An id that is not a tab is simply absent from the answer.
 */
export function lastMessagesForTabs(
  db: Database.Database,
  tabIds: readonly string[],
): Record<string, Preview | null> {
  const tabs = new TabStore(db);
  const panes = new PaneStore(db);
  const out: Record<string, Preview | null> = {};
  for (const id of tabIds) {
    const tab = tabs.getById(id);
    if (!tab) continue;
    const at = tab.last_activity_at ?? null;
    const hit = memo.get(id);
    if (hit && hit.at === at) {
      out[id] = hit.value;
      continue;
    }
    // A tab holds one thing; an old row may still hold a stray second pane.
    // The first pane that has anything to say answers.
    let value: Preview | null = null;
    for (const p of panes.listByTab(id)) {
      value = lastMessageForPane(db, p.id);
      if (value) break;
    }
    memo.set(id, { at, value });
    out[id] = value;
  }
  return out;
}

/** Test seam. */
export function resetLastMessageMemo(): void {
  memo.clear();
}
