import { z } from 'zod';

/**
 * WHAT THE AGENT DID OUTSIDE THIS CHAT.
 *
 * ── THE GAP THIS FILLS ───────────────────────────────────────────────────
 * A Slack message leaves no trace in the conversation that sent it. The
 * transcript holds the agent SAYING it posted — which is the agent's account
 * of its own effect, not the effect — and the only durable record was a
 * transient approval alert that vanishes the moment it is answered. "Did that
 * actually go?" was unanswerable a minute later, from the one surface where
 * anybody asks it.
 *
 * A sub-chat solved the same problem years earlier: it is a card at the point
 * in the log where the work was handed off, and it carries its own outcome.
 * This is that, for an act on an outside system.
 *
 * ── GENERIC BY CONSTRUCTION ──────────────────────────────────────────────
 * Slack is the first producer, not the shape. `kind` is
 * `<integration>.<verb>` and everything else is what every such act has: when
 * it happened, a line naming it, the content, somewhere to go, and how it
 * ended. Email and WhatsApp are a producer and an icon each — not a table, not
 * a card component, and not a third copy of the log injector.
 */

/**
 * HOW IT ENDED — and `pending` is a real state, not a loading spinner.
 *
 * Every outbound integration muxpad has goes through a human approval, so
 * "waiting for you" is the state an act spends most of its life in and the one
 * the card most needs to show. `declined` is kept apart from `failed` for the
 * same reason `unauthorized` is kept apart from `down` in the machines list:
 * one is a decision and the other is a fault, and rendering a decision as a
 * failure invites someone to retry it.
 */
export const ChatActionStateSchema = z.enum(['pending', 'sent', 'failed', 'declined']);
export type ChatActionState = z.infer<typeof ChatActionStateSchema>;

export const ChatActionSchema = z.object({
  id: z.string(),
  pane_id: z.string(),
  at: z.number(),
  /** `<integration>.<verb>`: `slack.post`, later `email.send`. Free-form on
   *  the wire on purpose — a client that has not heard of an integration
   *  renders a generic card rather than dropping the row. */
  kind: z.string(),
  /** One line naming the act, written by the producer: "Posted to #general". */
  title: z.string(),
  /** What was sent. Shown folded — a long message must not push the
   *  conversation off the screen. */
  body: z.string().nullable().optional(),
  /** Somewhere to go: a Slack permalink, a published url. */
  url: z.string().nullable().optional(),
  state: ChatActionStateSchema,
  /** Why it failed, or what it is waiting for. */
  detail: z.string().nullable().optional(),
});
export type ChatAction = z.infer<typeof ChatActionSchema>;

/** The integration an action belongs to — the part before the dot. Drives the
 *  icon, and nothing else. */
export function actionIntegration(kind: string): string {
  return kind.split('.')[0] ?? kind;
}

/**
 * Is this act still waiting on a person?
 *
 * One predicate rather than `state === 'pending'` at each call site: the set
 * of waiting states is a property of the approval model, and it has already
 * grown once (a broker request is `pending`, then `verifying`, then
 * `executing`, all of which are "not your turn yet").
 */
export function actionIsOpen(a: ChatAction): boolean {
  return a.state === 'pending';
}

/**
 * Did this act only LOOK at something?
 *
 * The card exists because an outbound effect needs a durable record: the
 * transcript holds the agent saying it posted to Slack, written before the
 * approval was answered, so "did that actually go?" had no surface. That
 * argument is entirely about WRITES.
 *
 * A read has no effect to record. Fifteen of them — one question to the mail
 * vault became fifteen full-width cards — is a wall that buries the answer
 * underneath it, and the reader was right to call it overwhelming. Reads fold
 * into one row; writes never do.
 *
 * Listed rather than derived from the verb's name: `slack.search` and
 * `slack.post` differ by nothing a pattern can see, and guessing wrong in the
 * direction of "this is a read" would quietly hide a message that was sent.
 */
const READ_ACTIONS = new Set([
  'msgvault.search',
  'msgvault.show-message',
  'msgvault.show-thread',
  'msgvault.export-attachment',
  'msgvault.stats',
  'slack.read',
  'slack.search',
  'slack.channels',
  'slack.users',
  'slack.thread',
]);

export function actionIsRead(a: ChatAction): boolean {
  return READ_ACTIONS.has(a.kind);
}

/**
 * WHAT A FINISHED ACT IS CALLED, per verb.
 *
 * The stored state for every act that finished is `sent`, and the card used
 * to print that word for all of them — so the log read "Searched your mail ·
 * sent" and "Drafted a reply · sent". For someone scanning it for what LEFT
 * the machine that is false twice over: a read sends nothing, and a draft is
 * created in the owner's own mailbox, not sent to anyone. (`complete` from the
 * broker only means the tool exited 0, so the word must not claim more.)
 *
 * The state stays `sent` — it is the stored, validated "finished" value and
 * changing it would rewrite old rows — and only the WORD follows the verb.
 * Anything not listed is an outbound send and keeps "sent".
 */
const DONE_WORDS: Record<string, string> = {
  'msgvault.draft-reply': 'drafted',
  'msgvault.draft-compose': 'drafted',
  'msgvault.draft-get': 'done',
  'msgvault.draft-edit': 'updated',
  'msgvault.draft-delete': 'deleted',
  'msgvault.calendar-create': 'added',
  'msgvault.calendar-update': 'changed',
  'msgvault.calendar-delete': 'deleted',
  'msgvault.calendar-freebusy': 'done',
  'msgvault.calendar-conflicts': 'done',
  'msgvault.run': 'done',
  'slack.edit': 'edited',
  'slack.react': 'reacted',
  'slack.unpost': 'deleted',
};

export function finishedWord(kind: string): string {
  if (READ_ACTIONS.has(kind)) return 'done';
  return DONE_WORDS[kind] ?? 'sent';
}

/**
 * ── A CARD MUST NOT SAY A THING HAPPENED WHEN IT DID NOT ──────────────────
 *
 * Every title is written in the past tense, because the common case is an act
 * that worked: "Posted to #eng", "Downloaded an email attachment". The state
 * word beside it carries the outcome.
 *
 * On a FAILED card that pairing reads as a contradiction, and the bold half
 * wins. A real one, screenshotted and sent back with "improve these cards":
 *
 *     Downloaded an email attachment (3f9c1d7e5b20)   FAILED
 *
 * Nothing was downloaded. The assertion is in 15px bold and the correction is
 * in 10px grey beside it, so the card's loudest element is the false one.
 *
 * So the VERB follows the state, exactly as `finishedWord` makes the state
 * word follow the verb. The transform is deliberately narrow — a lookup of
 * the first word, nothing clever — and an unlisted verb leaves the title
 * untouched, because a mangled sentence is worse than a tense that is merely
 * optimistic.
 */
const BASE_VERB: Record<string, string> = {
  Posted: 'post',
  Sent: 'send',
  Edited: 'edit',
  Uploaded: 'upload',
  Reacted: 'react',
  Deleted: 'delete',
  Searched: 'search',
  Read: 'read',
  Downloaded: 'download',
  Counted: 'count',
  Drafted: 'draft',
  Ran: 'run',
  Checked: 'check',
  Looked: 'look',
  Changed: 'change',
  Added: 'add',
  Rewrote: 'rewrite',
  Published: 'publish',
  Hosted: 'host',
};

/**
 * The title as it should read for a given state.
 *
 * `failed` → "Tried to download an email attachment": something was attempted
 * and did not work. `declined` → "Did not download an email attachment": a
 * person said no, so nothing was even tried, and "tried to" would be its own
 * small lie. Every other state keeps the title as written.
 */
export function titleForState(title: string, state: ChatActionState): string {
  if (state !== 'failed' && state !== 'declined') return title;
  const [first, ...rest] = title.split(' ');
  const base = BASE_VERB[first ?? ''];
  if (!base) return title;
  return `${state === 'failed' ? 'Tried to' : 'Did not'} ${[base, ...rest].join(' ')}`;
}
