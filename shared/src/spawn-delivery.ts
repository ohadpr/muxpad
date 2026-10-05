/**
 * THE JOIN — a finished sub-chat's result, delivered into its parent's chat.
 *
 * A child finishing has never resumed its parent. The report landed on the
 * child's row, the parent's row went bold, and the parent's AGENT learned
 * nothing: to find out, it had to be holding a background `muxpad agent wait`
 * per child, with the right pane id and the exit code checked. Measured on the
 * live database: 114 of 192 tabs are sub-chats, 104 of them belong to three
 * orchestrators (fan-outs of 16, 23 and 65) — and 20 of 105 children that
 * retired `delivered` delivered no report at all.
 *
 * So the server delivers it, as a real message into the parent's conversation.
 * The server is the right author for exactly the reason the hands-off design
 * worried about: a worker that CRASHED never reaches a reporting step, and that
 * is precisely when the parent most needs telling. `agent wait` cannot cover
 * that case; a retirement hook can.
 *
 * ── WHY A MARKER AND NOT PLAIN TEXT ────────────────────────────────────────
 * The same two jobs `renderCronMarker` does, and this follows its shape so the
 * two cannot drift:
 *
 *   TO THE AGENT   the block is a real instruction. It says the message came
 *                  from muxpad rather than from a person, which an orchestrator
 *                  needs in order to know it is reading a result rather than
 *                  being asked a question.
 *   TO THE CLIENT  it is the render hook. A delivery is drawn as a report card,
 *                  not as a user bubble — a human never typed it.
 *
 * And to the SERVER it is the third thing, which is why `isMachineMessage`
 * lives here: `lastHumanSendAt` gates push suppression and a cron's
 * `quiet_mins`, both of which ask "is a person typing right now". A batch of
 * reports landing is not a person, and counting it as one would suppress the
 * notification for the very turn the user is waiting on.
 */

import { parseCronMarker } from './cron.js';

/** One child's result, as it goes into the parent's message. */
export interface SpawnDeliveryEntry {
  /** The child's TAB id — the durable handle, stable across pane respawns. */
  tabId: string;
  /** The child's name, for the human reading the card. */
  name: string;
  /** `ok` | `crashed` | `awaiting` | `none` | `failed`, or null if never set. */
  state: string | null;
  /** The report text. Null for a child that stopped without producing one. */
  report: string | null;
  /** Published urls the child produced. */
  artifacts?: string[];
}

export interface SpawnDeliveryMarker {
  /** How many children this message reports on. */
  count: number;
  /** Their tab ids, in the order the body lists them. */
  from: string[];
}

const REPORT_OPEN = /^\s*<muxpad-report\b([^>]*)>([\s\S]*?)<\/muxpad-report>\s*/;

function attr(attrs: string, name: string): string | null {
  const m = attrs.match(new RegExp(`\\b${name}="([^"]*)"`));
  return m ? (m[1] as string) : null;
}

/**
 * TOTAL BODY BUDGET for the reports in one message, in characters.
 *
 * A 65-child fan-out is a real shape in this install, and 65 unabridged
 * reports is not a message — it is a context window. The budget is split
 * between the children rather than applied per child, so the message has a
 * ceiling no fan-out size can breach.
 */
export const DELIVERY_BODY_BUDGET = 24_000;
/** No child's report is cut below this, however many siblings there are. */
export const DELIVERY_MIN_PER_CHILD = 240;
/** …and none gets more than this even when it is the only one. */
export const DELIVERY_MAX_PER_CHILD = 1_200;

/** Per-child character budget for `n` children. */
export function perChildBudget(n: number): number {
  if (n <= 0) return DELIVERY_MAX_PER_CHILD;
  const share = Math.floor(DELIVERY_BODY_BUDGET / n);
  return Math.min(DELIVERY_MAX_PER_CHILD, Math.max(DELIVERY_MIN_PER_CHILD, share));
}

function clip(text: string, budget: number): string {
  const t = text.trim();
  if (t.length <= budget) return t;
  // Cut on a word so the tail is not half a token, and SAY it was cut — a
  // silently truncated report reads as a worker that stopped mid-sentence.
  const head = t.slice(0, budget);
  const sp = head.lastIndexOf(' ');
  return `${(sp > budget * 0.6 ? head.slice(0, sp) : head).trimEnd()}… [report truncated]`;
}

/** `ok` is the uninteresting case and says nothing a reader needs. */
function stateNote(state: string | null): string {
  if (!state || state === 'ok') return '';
  if (state === 'crashed') return ' — CRASHED, this is muxpad reporting, not the worker';
  if (state === 'awaiting') return ' — stopped to ask a question';
  if (state === 'failed') return ' — muxpad could not summarise this one';
  if (state === 'none') return ' — produced no report';
  return ` — ${state}`;
}

/**
 * Render a batch of finished children as one message for the parent.
 *
 * ONE message for a batch, never one per child: a 23-way fan-out landing as 23
 * separate sends is 23 turns, and the orchestrator wanted the join, not a
 * drip. The batch barrier that decides WHEN this is called lives server-side
 * (chat/report-delivery.ts); this only knows how to say it.
 */
export function renderSpawnDelivery(entries: readonly SpawnDeliveryEntry[]): string {
  const n = entries.length;
  const budget = perChildBudget(n);
  const ids = entries.map((e) => e.tabId).join(',');
  const subject = n === 1 ? 'sub-chat' : 'sub-chats';
  const note = [
    `Delivered by muxpad: ${n} ${subject} you spawned ${n === 1 ? 'has' : 'have'} finished.`,
    'This is muxpad reporting a result, not a human asking a question.',
    'You do not need to poll or wait for these — act on them, or carry on if nothing is needed.',
  ].join(' ');
  const body = entries
    .map((e) => {
      const head = `## ${e.name}${stateNote(e.state)}`;
      const text = e.report ? clip(e.report, budget) : '(no report)';
      const links = e.artifacts?.length ? `\n\nArtifacts: ${e.artifacts.join(' ')}` : '';
      return `${head}\n\n${text}${links}`;
    })
    .join('\n\n');
  return `<muxpad-report count="${n}" from="${ids}">\n${note}\n</muxpad-report>\n\n${body}`;
}

/**
 * Split a delivered report message back into its marker and the body.
 *
 * Returns null for ordinary text, including text that merely MENTIONS the tag
 * somewhere in the middle — only a leading block is one we produced. Same rule,
 * and the same reason, as `parseCronMarker`.
 */
export function parseSpawnDelivery(
  text: string,
): { marker: SpawnDeliveryMarker; body: string } | null {
  const m = text.match(REPORT_OPEN);
  if (!m) return null;
  const attrs = m[1] ?? '';
  const countRaw = attr(attrs, 'count');
  if (countRaw === null || !/^\d+$/.test(countRaw)) return null;
  const from = (attr(attrs, 'from') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return { marker: { count: Number(countRaw), from }, body: text.slice(m[0].length) };
}

/**
 * Was this message written by MUXPAD rather than by a person?
 *
 * The predicate behind `lastHumanSendAt`, which asks one question — "is a human
 * typing into this chat right now" — and is read by two gates that both get the
 * wrong answer if a machine send counts:
 *
 *   PUSH SUPPRESSION   a turn answered within the suppress window of your own
 *                      send is a conversation you are watching, so it does not
 *                      buzz your phone. A fan-out landing at 3am is the exact
 *                      opposite, and counting it as your typing would mute the
 *                      one notification you were waiting for.
 *   CRON `quiet_mins`  "don't barge into a live conversation" — a report
 *                      arriving is not a live conversation, and deferring a due
 *                      cron behind one is a fire lost to bookkeeping.
 *
 * Both markers, in one place, because the list is the thing that gets forgotten:
 * `isHumanMessage` was `parseCronMarker(text) === null` and every new injected
 * message type after cron would have silently read as human.
 */
export function isMachineMessage(text: string): boolean {
  return parseCronMarker(text) !== null || parseSpawnDelivery(text) !== null;
}
