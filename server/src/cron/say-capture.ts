import { type ChatEvent, normalizeTranscriptLine } from '@muxpad/shared';
import type Database from 'better-sqlite3';
import { identityNormalize } from '../chat/TranscriptReader.js';
import { readTailLines } from '../chat/has-messages.js';
import { transcriptForPane } from '../chat/transcript-access.js';
import { AgentSessionStore } from '../store/AgentSessionStore.js';

/**
 * WHAT THIS FIRE ASKED TO HAVE DELIVERED.
 *
 * A cron result is whatever the worker spoke with `muxpad say`, and nothing
 * else. That choice is the design, so it is worth stating:
 *
 *   · `say` ALREADY MEANS "the person needs to hear this". The manual has told
 *     agents for a long time that inside a cron fire it is the only thing that
 *     renders and everything else is folded away. Routing it makes that
 *     promise true ACROSS chats rather than teaching every agent a second verb
 *     that the old one would keep silently losing to.
 *
 *   · THE ALTERNATIVE IS NOISE. Forwarding a fire's final prose would turn
 *     every "no change" watcher into a daily message. Intentional silence is a
 *     feature of this scheduler, and nothing here can take it away: a fire
 *     that said nothing captures nothing and delivers nothing.
 *
 * ── IT IS A TRANSCRIPT READ, NOT A HOOK ─────────────────────────────────────
 * `muxpad say` posts nothing to the server. It prints a keyed marker to
 * stdout, and the NORMALIZER lifts that into a message — so the only durable
 * record of a spoken block is the transcript. Reading it at turn-end is the
 * capture, and it is cheap: the tail of one file, one pass, no model call.
 *
 * ── THE `:said` SUFFIX IS THE SEAM ──────────────────────────────────────────
 * Both normalizers mint a lifted block's id as `…:saidN` (shared/chat-events,
 * in `expandChatEvent` for codex/cursor and in `normalizeTranscriptLine` for
 * Claude). So after normalization a spoken block is an ordinary `assistant`
 * event that can still be told apart from ordinary prose — which matters,
 * because ordinary prose is exactly what must NOT be delivered.
 *
 * Going through the normalizer rather than matching the marker on the raw line
 * also means the key check, the closing-tag pairing and the "text that merely
 * QUOTES the marker" rule are all the ones `splitSaid` already enforces, in
 * one place, instead of a second copy here that could disagree.
 *
 * ── AND IT READS ONLY THIS FIRE ─────────────────────────────────────────────
 * `since` is the run's `fired_at`. A `--pane` cron fires into a chat with
 * history, and that history can hold spoken blocks from yesterday's fire or
 * from a person's own session; delivering those would be this feature
 * inventing a result nobody produced. A fresh `--new-tab` worker has nothing
 * but this fire, so the cutoff costs it nothing and covers the other case.
 */

/** Tail read, matching `readRecentTurns`. A result worth delivering is a
 *  paragraph, not a megabyte. */
const TAIL_BYTES = 64 * 1024;

/**
 * How much spoken text one fire may deliver.
 *
 * Bounded because it lands in ANOTHER conversation's context window: an agent
 * that pipes a 200 KB log into `muxpad say` would otherwise push all of it
 * through a chat somebody is using for something else. Clipped rather than
 * refused — a result that arrives shortened is worth more than one that does
 * not arrive — and the text says where the rest is.
 */
export const RESULT_MAX_CHARS = 4_000;
const CLIP = '\n\n[…clipped — the rest is in the run’s own chat]';

/** A lifted `muxpad say` block, as both normalizers mint it. Narrowed to the
 *  assistant shape so the text is reachable without a cast. */
function saidText(ev: ChatEvent): string | null {
  if (ev.kind !== 'assistant' || !/:said\d+$/.test(ev.id)) return null;
  const text = ev.text?.trim();
  return text ? text : null;
}

/**
 * Everything this pane SPOKE at or after `since`, joined.
 *
 * Returns null — not '' — when there is nothing, because "said nothing" is the
 * common and correct case, and an empty string stored as a result would look
 * like a result that failed to deliver.
 */
export function capturedResult(
  db: Database.Database,
  paneId: string,
  since: number,
): string | null {
  const sess = new AgentSessionStore(db).getByPane(paneId);
  const sid = sess?.current_sid;
  if (!sid) return null;
  // THROUGH THE CHOKEPOINT. This text is about to be injected into another
  // chat, so reading it for a pane that lives on another machine would be the
  // trust hole transcript-access.ts exists to close, with a delivery on the
  // end of it.
  const access = transcriptForPane(db, paneId, sid, sess.assistant);
  if (access.kind !== 'local') return null;
  let lines: string[];
  try {
    lines = readTailLines(access.path, TAIL_BYTES);
  } catch {
    return null;
  }
  const normalize = sess.assistant === 'claude' ? normalizeTranscriptLine : identityNormalize;
  const spoken: string[] = [];
  for (const line of lines) {
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    for (const ev of normalize(obj) as ChatEvent[]) {
      const text = saidText(ev);
      if (!text) continue;
      // A block with no timestamp is KEPT. For a fresh worker that can be
      // every line, and dropping those would deliver nothing from the one
      // target this feature exists for.
      if (typeof ev.ts === 'number' && ev.ts < since) continue;
      spoken.push(text);
    }
  }
  if (spoken.length === 0) return null;
  const joined = spoken.join('\n\n').trim();
  if (!joined) return null;
  return joined.length > RESULT_MAX_CHARS
    ? `${joined.slice(0, RESULT_MAX_CHARS - CLIP.length)}${CLIP}`
    : joined;
}
