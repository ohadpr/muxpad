/**
 * THE TWO THINGS A PERSON WANTS TO DO TO A PINNED CARD, and neither is "read it".
 *
 * A card is written by an agent and pinned where it cannot be scrolled past,
 * so the reader has no way to act on it: a card that is wrong, or finished, or
 * about work that ended, just sits there. The chat below it is the only lever,
 * and using it means retyping which card you mean.
 *
 * So: two buttons, and both of them go THROUGH the conversation rather than
 * around it.
 *
 * ─── WHY REMOVAL IS NOT JUST A DELETE ──────────────────────────────────────
 *
 * A card usually has a writer — `muxpad cron new --card=<name>` names the card
 * a schedule keeps fresh. Deleting the card alone leaves that cron running, and
 * the card reappears on its next fire, which reads as the button not working.
 * So the delete answers with its WRITERS, and when there are any the removal
 * also says so in the chat, naming them, as work for the agent to finish.
 *
 * When nothing writes the card, nothing is said. A card somebody set by hand
 * and then cleared is not worth a turn, and a message per dismissal would make
 * tidying up cost money.
 */

/** What the composer is filled with when somebody asks for a change. NOT sent:
 *  the person finishes the sentence, because only they know the change. */
export function changeRequestDraft(cardName: string): string {
  return `Change the \`${cardName}\` card: `;
}

/**
 * What to say in the chat after a card was removed — or null when it is nobody's
 * business.
 *
 * Names the writers rather than asking the agent to go looking: the server
 * already knows which schedules carry this card's name, and an agent that has
 * to search for them will sometimes search wrong.
 */
export function removalFollowUp(cardName: string, writers: readonly string[]): string | null {
  if (writers.length === 0) return null;
  const list = writers.map((w) => `\`${w}\``).join(', ');
  const plural = writers.length > 1 ? 'schedules' : 'schedule';
  return [
    `I removed the \`${cardName}\` card from this chat.`,
    `The ${plural} ${list} still writes it, so it will come back on the next fire.`,
    'Retire or repoint whatever keeps it fresh, then tell me in one line what you changed.',
  ].join(' ');
}
