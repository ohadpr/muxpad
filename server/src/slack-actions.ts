import type { ChatActionState } from '@muxpad/shared';
import type Database from 'better-sqlite3';
import { ChatActionStore } from './store/ChatActionStore.js';

/**
 * SLACK, AS A CHAT ACTION — the first producer of the generic card.
 *
 * Everything Slack-shaped lives here and nothing Slack-shaped lives in the
 * store, the route or the card: this file turns a broker action into the five
 * fields every outbound act has (see shared/src/chat-actions.ts), and the next
 * integration writes one of these rather than touching any of them.
 *
 * ── WHY IT IS BEST-EFFORT ────────────────────────────────────────────────
 * A card is a record of a send, not a precondition for one. If writing it
 * fails — a locked database, a table an older build has not migrated yet —
 * the message must still go. So every function here swallows its own errors:
 * the alternative is a Slack integration that breaks when a cosmetic table
 * does.
 */

/** The verbs worth a card, and what each one's line says. */
const TITLES: Record<string, (p: Payload) => string> = {
  'slack.post': (p) => `Posted to ${channel(p)}`,
  'slack.dm': (p) => `Sent a DM to ${channel(p)}`,
  'slack.edit': (p) => `Edited a message in ${channel(p)}`,
  'slack.upload': (p) => `Uploaded a file to ${channel(p)}`,
  'slack.react': (p) => `Reacted in ${channel(p)}`,
  'slack.unpost': (p) => `Deleted a message in ${channel(p)}`,
  // ── SAY WHAT IT IS, NOT WHAT WE CALL IT ───────────────────────────────
  //
  // These read "Searched the archive", "Read archived message 150889", "Read
  // archive totals". `archive` is muxpad's own word for the component — it is
  // what the store is called in this codebase — and it tells a reader nothing
  // about what was touched. Asked directly: "what does the word archive mean
  // here? we need something more fitting."
  //
  // What was touched is MAIL. The vault holds other sources too, which is
  // exactly why `stats` names all three rather than claiming to have read
  // messages: it counts, across everything.
  //
  // Each still says WHAT WAS READ — a card that says "search" is a card that
  // tells you nothing about what left the machine.
  'msgvault.search': (p) => `Searched your mail for ${JSON.stringify(p.query ?? '')}`,
  'msgvault.show-message': (p) => `Read one email (${String(p.id ?? '')})`,
  'msgvault.show-thread': (p) => `Read an email thread (${String(p.id ?? '')})`,
  'msgvault.export-attachment': (p) =>
    `Downloaded an email attachment (${String(p.hash ?? '').slice(0, 12)})`,
  'msgvault.stats': () => 'Counted your mail, calendar and contacts',
  // The WRITE says what it is about: a card reading "drafted a reply" is a
  // card you would have to open your mailbox to understand.
  'msgvault.draft-reply': (p) => `Drafted a reply to message ${String(p.id ?? '')}`,
  'msgvault.draft-compose': (p) =>
    `Drafted a new email to ${(Array.isArray(p.to) ? p.to : [p.to]).map(String).join(', ')} — ${JSON.stringify(String(p.subject ?? ''))}`,
  'msgvault.run': (p) =>
    `Ran msgvault ${(Array.isArray(p.args) ? p.args : []).map(String).join(' ')}`,
  'msgvault.calendar-freebusy': (p) =>
    `Checked the calendar for free time (${String(p.start ?? '')})`,
  'msgvault.calendar-conflicts': (p) => `Looked for calendar conflicts (${String(p.start ?? '')})`,
  'msgvault.calendar-update': (p) => `Changed calendar event ${String(p.event ?? '')}`,
  'msgvault.calendar-delete': (p) => `Deleted calendar event ${String(p.event ?? '')}`,
  'msgvault.calendar-create': (p) =>
    `Added ${JSON.stringify(String(p.summary ?? ''))} to the calendar (${String(p.start ?? '')})`,
  'msgvault.draft-get': (p) => `Read draft ${String(p.id ?? '')}`,
  'msgvault.draft-edit': (p) => `Rewrote draft ${String(p.id ?? '')}`,
  'msgvault.draft-delete': (p) => `Deleted draft ${String(p.id ?? '')}`,
};

interface Payload {
  ref?: unknown;
  channel?: unknown;
  text?: unknown;
  emoji?: unknown;
  filename?: unknown;
  /** msgvault reads: the message id, or the query that was run. */
  id?: unknown;
  query?: unknown;
  /** msgvault attachment: the content hash that was fetched. */
  hash?: unknown;
  /** msgvault compose: who a NEW email was drafted to, and its subject. */
  to?: unknown;
  subject?: unknown;
  /** msgvault calendar: the event's title and when it starts. */
  summary?: unknown;
  start?: unknown;
  /** msgvault calendar: which event an update or delete acts on. */
  event?: unknown;
  /** msgvault run: the argv the agent asked for, reviewed by the broker. */
  args?: unknown;
}

/**
 * A channel as a person says it.
 *
 * The broker takes a `ref` that may be a channel name, a channel id or a user
 * — `#general`, `C01234`, `@ohad`. A raw id is unreadable in a card, so an id
 * is named as a channel and anything else is shown as given; this is a LABEL,
 * and resolving ids would mean a Slack call per card.
 */
function channel(p: Payload): string {
  const raw = typeof p.ref === 'string' ? p.ref : typeof p.channel === 'string' ? p.channel : '';
  if (!raw) return 'Slack';
  if (/^[CDG][A-Z0-9]{6,}$/.test(raw)) return `a channel (${raw})`;
  return raw.startsWith('#') || raw.startsWith('@') ? raw : `#${raw}`;
}

/** What a broker result's `state` means for a card. Unknown → still open:
 *  asserting an outcome muxpad has not been told is the one wrong answer. */
export function stateFromBroker(state: unknown): ChatActionState {
  switch (String(state)) {
    case 'complete':
      return 'sent';
    case 'rejected':
      return 'declined';
    case 'failed':
    case 'expired':
      return 'failed';
    default:
      // pending / verifying / executing — all of them "not finished".
      return 'pending';
  }
}

/**
 * The line under the title, for a state that needs explaining.
 *
 * The fallback used to say "Slack refused it" whatever had been asked, so a
 * mail draft that failed without an error string told you Slack had refused
 * it. This file stopped being Slack-only when the archive arrived; the card
 * is a permanent record, and a record that names the wrong system is worse
 * than one that names none.
 */
function detailFor(
  state: ChatActionState,
  result: Record<string, unknown>,
  action?: string,
): string | null {
  if (state === 'declined') return 'You declined it';
  if (state === 'failed') {
    const why = typeof result.error === 'string' ? result.error : null;
    if (why) return why;
    if (String(result.state) === 'expired') return 'The request expired';
    return refusedBy(action ?? (typeof result.action === 'string' ? result.action : undefined));
  }
  return null;
}

/** Who refused, named only when the action says so. */
function refusedBy(action: string | undefined): string {
  const connector = String(action ?? '').split('.')[0];
  if (connector === 'slack') return 'Slack refused it';
  if (connector === 'msgvault') return 'The mail archive refused it';
  return 'It was refused';
}

/**
 * Record one Slack act as a card in the chat that made it.
 *
 * Silent when the verb is not one we draw (a read is not an act) or when the
 * broker gave back no request id — without one the act cannot be resolved
 * later, and a card stuck on "waiting" forever is worse than no card.
 */
/**
 * A SEND MUXPAD ITSELF REFUSED — recorded as a declined card, like one the
 * human declined.
 *
 * The broker never saw it, so there is no request id to key on and
 * {@link recordSlackAction} would drop it. But a refusal is exactly the thing
 * you want a record of: "I asked and nothing happened" is the state this whole
 * mechanism exists to make visible, and an agent's own account of being
 * refused is not a record. `declined` rather than `failed` for the usual
 * reason — a rule said no, nothing broke.
 */
export function recordSlackRefusal(
  db: Database.Database,
  input: { action: string; payload: unknown; pane: string; why: string },
): void {
  try {
    const title = TITLES[input.action];
    new ChatActionStore(db).record({
      pane_id: input.pane,
      kind: input.action,
      title: title ? title((input.payload ?? {}) as Payload) : input.action,
      state: 'declined',
      body: bodyOf(input.action, (input.payload ?? {}) as Payload),
      detail: input.why,
      ref: null,
    });
  } catch {
    /* a card is a record of a refusal, never a precondition for one */
  }
}

export function recordSlackAction(
  db: Database.Database,
  input: { action: string; payload: unknown; pane: string; result: Record<string, unknown> },
): void {
  try {
    const title = TITLES[input.action];
    if (!title) return;
    const ref = typeof input.result.id === 'string' ? input.result.id : null;
    if (!ref) return;
    const p = (input.payload ?? {}) as Payload;
    const state = stateFromBroker(input.result.state);
    new ChatActionStore(db).record({
      pane_id: input.pane,
      kind: input.action,
      title: title(p),
      state,
      body: bodyOf(input.action, p),
      detail: detailFor(state, input.result, input.action),
      url: typeof input.result.permalink === 'string' ? input.result.permalink : null,
      ref,
    });
  } catch {
    /* a card is a record of a send, never a precondition for one */
  }
}

/** What was actually sent, for the card's folded body. */
function bodyOf(action: string, p: Payload): string | null {
  if (action === 'slack.react') return typeof p.emoji === 'string' ? `:${p.emoji}:` : null;
  if (action === 'slack.upload') return typeof p.filename === 'string' ? p.filename : null;
  return typeof p.text === 'string' ? p.text : null;
}

/**
 * Teach a card how its act ended, from any broker status.
 *
 * Called on every result muxpad sees — the action's own reply, the approvals
 * poll, a passkey ceremony — so a card resolves whichever path reported first
 * and `resolveByRef` makes a second report a no-op.
 */
export function resolveSlackAction(db: Database.Database, result: Record<string, unknown>): void {
  try {
    const ref = typeof result.id === 'string' ? result.id : null;
    if (!ref) return;
    const state = stateFromBroker(result.state);
    // Nothing to say yet. Writing `pending` over `pending` would churn the
    // row (and its event) on every poll of every outstanding approval.
    if (state === 'pending') return;
    new ChatActionStore(db).resolveByRef(ref, {
      state,
      url: typeof result.permalink === 'string' ? result.permalink : null,
      detail: detailFor(state, result),
    });
  } catch {
    /* see recordSlackAction */
  }
}
