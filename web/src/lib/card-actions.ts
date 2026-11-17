/**
 * THE TWO THINGS A PERSON WANTS TO DO TO A PINNED CARD, and neither is "read it".
 *
 * A card is written by an agent and pinned where it cannot be scrolled past,
 * so the reader has no way to act on it: a card that is wrong, or finished, or
 * about work that ended just sits there. The chat below it is the only lever,
 * and using it means retyping which card you mean.
 *
 * So: two buttons, and both of them go THROUGH the conversation rather than
 * around it.
 *
 * ─── WHY REMOVAL IS NOT A DELETE, AND WHY THE LIST IS ONLY A HINT ──────────
 *
 * A card has a WRITER, and clearing the card without dealing with it means the
 * card returns on the next fire — which reads as the button not working.
 *
 * muxpad can see some writers and not others. Measured on this machine, of the
 * crons that keep a card fresh: THREE name the card with `--card=`, one writes
 * it from a `card set` in its prompt, and the rest — `nw-open`, `nw-close` —
 * run a shell script (`scripts/market_card.sh`) that writes it, so the card's
 * name appears nowhere in the database at all. The same shape as the
 * `~/.msgvault/card.sh` behind the gmail-sync card.
 *
 * So the server's answer is a HINT, never an inventory, and the message says
 * so. The real work — find whatever writes this, retire or repoint it, delete
 * the script that rendered it — is work for the agent, and it is exactly what
 * a person asking "remove the msgvault card" gets done by hand today.
 *
 * And it is said on EVERY removal, not only when the database knew something.
 * Staying quiet on an empty list would be staying quiet in precisely the case
 * where the writer is invisible, which is most of them.
 */

/** A schedule muxpad can see that names this card. */
export interface CardWriter {
  name: string;
  enabled: boolean;
}

/** What the composer is filled with when somebody asks for a change. NOT sent:
 *  the person finishes the sentence, because only they know the change. */
export function changeRequestDraft(cardName: string): string {
  return `Change the \`${cardName}\` card: `;
}

/**
 * What to say in the chat after a card was removed.
 *
 * Names what the database knew — including PAUSED schedules, which are litter
 * even when they cannot fire, and which somebody will one day resume into a
 * card that no longer exists. Then says plainly that the list may be short.
 */
export function removalFollowUp(cardName: string, writers: readonly CardWriter[]): string {
  const live = writers.filter((w) => w.enabled).map((w) => `\`${w.name}\``);
  const paused = writers.filter((w) => !w.enabled).map((w) => `\`${w.name}\``);
  const known: string[] = [];
  if (live.length) known.push(`${live.join(', ')} still write${live.length > 1 ? '' : 's'} it`);
  if (paused.length)
    known.push(
      `${paused.join(', ')} ${paused.length > 1 ? 'are' : 'is'} paused but still named for it`,
    );
  return [
    `I removed the \`${cardName}\` card from this chat.`,
    known.length
      ? `Schedules muxpad can see: ${known.join('; ')}.`
      : 'muxpad knows of no schedule naming it.',
    'That list is a hint, not an inventory — a card is often written by a script a cron runs, and then its name is nowhere in the database.',
    `Find what actually keeps it fresh (\`muxpad cron list\`, this chat's history, any helper script), retire or repoint it, delete what rendered it, and tell me in one line what you removed.`,
  ].join(' ');
}
