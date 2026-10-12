/**
 * `@mention` AS CONTEXT — a resolved handle to another chat, attached to a
 * message you are sending to THIS one.
 *
 * ── What it replaced, and why ───────────────────────────────────────────────
 * A leading `@Name` used to ROUTE: the text after it was delivered to that
 * chat's agent instead of this one's, and the sender saw a card waiting for an
 * answer. Reported by the user who hit it: "I wrote you a message and mentioned
 * another tab, and what you did was take what I wrote and send it to that tab."
 *
 * That rule can only ever do one thing with a mention, and it picked the rarest
 * one. The common intent is the opposite — here is a chat, it is relevant,
 * decide what to do about it — and the agent reading the message can decide:
 * read its tail, summarise it, search it, ask it something, or notice that the
 * sentence only needed the NAME and do nothing at all. A hardcoded router does
 * none of that, and its failure is expensive: your words go somewhere you are
 * not looking and you learn about it when something else answers.
 *
 * So a mention is now always a reference, and the message carries this block so
 * the agent gets IDS rather than the characters `@Investing`. Without it the
 * only handle is a name, which is guesswork the moment two chats are called
 * "Main".
 *
 * ── Why a visible block and not metadata ────────────────────────────────────
 * muxpad does not write the agent's transcript — it tails the file the harness
 * owns — so anything the agent must SEE has to be in the message text. Same
 * constraint, and the same shape, as the cron fire marker: a real instruction
 * and a render hook in one string, so the two cannot drift.
 */

/** One chat referenced by a message. */
export interface MentionedChat {
  /** The name as it appeared in the draft — what the user actually typed. */
  name: string;
  tabId: string;
  /** Its panes, in layout order. The agent one is usually the first. */
  paneIds: string[];
}

const CONTEXT_OPEN = /\n*<muxpad-context\b[^>]*>[\s\S]*?<\/muxpad-context>\s*$/;

/**
 * Append the handles for every chat this message mentions.
 *
 * AFTER the user's words, deliberately: their sentence is the message, and this
 * is an annotation on it. A block at the top would read as the instruction and
 * push what they actually said into second place.
 *
 * Returns `text` unchanged when nothing was mentioned, so the overwhelmingly
 * common message is byte-for-byte what it always was.
 */
export function withMentionContext(text: string, chats: readonly MentionedChat[]): string {
  if (chats.length === 0) return text;
  const lines = chats.map((c) => {
    const panes = c.paneIds.length > 0 ? c.paneIds.join(' ') : '(no panes)';
    return `- @${c.name} — tab ${c.tabId}, pane(s) ${panes}`;
  });
  return `${text}

<muxpad-context count="${chats.length}">
The message above mentions ${chats.length === 1 ? 'another muxpad chat' : 'other muxpad chats'}. This is a REFERENCE, not an instruction to forward anything:
${lines.join('\n')}

Decide what the message needs — often nothing beyond knowing which chat is meant:
  muxpad pane summarize <paneId>            a short summary, cheapest first look
  muxpad agent transcript <paneId> --tail=40  what was actually said, recently
  muxpad search "<query>"                   across every session ever run here
  muxpad agent send <paneId> "<question>"   ask it, if the message wants that
Do NOT forward the user's message anywhere unless they asked you to.
</muxpad-context>`;
}

/** Strip the block — what the user typed, without muxpad's annotation. */
export function stripMentionContext(text: string): string {
  return text.replace(CONTEXT_OPEN, '').trimEnd();
}

/** Does this message carry one? */
export function hasMentionContext(text: string): boolean {
  return CONTEXT_OPEN.test(text);
}
