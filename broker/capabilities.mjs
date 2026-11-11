/**
 * WHAT THE BROKER GUARDS, AS A LIST RATHER THAN AS SLACK.
 *
 * ── THE RULE THIS FILE EXISTS TO MAKE SINGULAR ───────────────────────────
 * The owner, after being handed a read-only msgvault grant with no dialog in
 * front of it:
 *
 *   "I WANT ALL APPROVAL MECHANISM TO BE SINGULAR. If we define something as
 *    needing approval it means: that thing has to run in a separate zone
 *    inaccessible to the agent no matter how hard the agent tries; any attempt
 *    to use it has to go through some muxpad tool, and that tool handles
 *    showing the user the permission dialog, and only when given permission
 *    does muxpad facilitate the secure access. Agents never receive the key or
 *    direct access. Once the approval window times out the agent can no longer
 *    make calls."
 *
 * That is one mechanism with three properties — a zone, a dialog, an expiry —
 * and the broker already had all three for Slack. What it did not have was a
 * SECOND thing to apply them to: `slack.` was written into the action names,
 * the scope strings, the executor and the dialog. So a capability is now a
 * value, and Slack is the first of them rather than the shape of the whole.
 *
 * ── WHY THE BROKER BUILDS ARGV AND NEVER FORWARDS IT ─────────────────────
 * An earlier design filtered an agent's own argv (see server connectors/
 * passthrough.ts). Filtering is the weaker move: it has to enumerate what is
 * dangerous, and it was broken in one line during review —
 * `--log-file search query 'SELECT …'` ran arbitrary SQL approved as a search,
 * because a value-taking flag swallowed the subcommand.
 *
 * Here the agent sends an ACTION and a validated PAYLOAD, and the broker
 * composes the command line itself from a fixed template. There is no argv to
 * smuggle a flag through, so the class of attack is absent rather than
 * defended against — and the string the human approves is the string that
 * runs.
 */

/** Slack: eleven verbs, five of which are reads. Unchanged — this is the
 *  behaviour that shipped, lifted out of core.mjs as data. */
export const SLACK = Object.freeze({
  id: 'slack',
  label: 'Slack',
  readScope: 'slack-team-read-v1',
  fullScope: 'slack-team-all-v2',
  readActions: Object.freeze([
    'slack.read',
    'slack.search',
    'slack.channels',
    'slack.users',
    'slack.thread',
  ]),
  actions: Object.freeze([
    'slack.post',
    'slack.unpost',
    'slack.read',
    'slack.search',
    'slack.channels',
    'slack.users',
    'slack.dm',
    'slack.thread',
    'slack.react',
    'slack.edit',
    'slack.upload',
  ]),
});

/**
 * msgvault: the owner's mail.
 *
 * ── IT IS NOT ALL READS ANY MORE ─────────────────────────────────────────
 * It used to be, and this note used to say so: no write set to hold back, so
 * `readScope` and `fullScope` were one list and a timed grant covered exactly
 * what a single approval would have.
 *
 * Drafting breaks that, and the split is the point. A draft puts text written
 * by an agent into the owner's mailbox under their name. It cannot send — the
 * tool has no send verb at this grant and muxpad asks for none — but "it will
 * be sitting there next to things you wrote" is a different promise from "it
 * read your mail", and the two must not be approvable by one gesture.
 *
 * The write set is one verb, not two: replying is all a Gmail source permits
 * (see msgvault.mjs for the measurement). A single-element list is still a
 * set that must not ride a duration.
 *
 * So `readScope` keeps the four reads and `fullScope` names everything. The
 * rule in core.mjs does the rest: a duration is offered only when the scope
 * being asked for is the READ scope, so a draft is always approve-once, with
 * its text in front of the person approving it.
 */
export const MSGVAULT = Object.freeze({
  id: 'msgvault',
  label: 'your mail',
  readScope: 'msgvault-read-v1',
  fullScope: 'msgvault-all-v1',
  // FOUR READS. `list-senders`, `meetings` and `person` cannot work against
  // agent-delegated msgvault — `person get` answers "not available in
  // agent-delegated mode", and the agent-token permission list has no
  // contacts scope at all (search.read, message.read, attachment.read,
  // stats.read, draft.*, calendar.*). An action name the broker accepts and
  // the tool refuses is a dialog that asks for something that cannot happen.
  readActions: Object.freeze([
    'msgvault.search',
    'msgvault.show-message',
    'msgvault.show-thread',
    'msgvault.stats',
  ]),
  /** ONE WRITE. `draft.create` is a real agent-token permission and
   *  `draft-reply` reaches the tool in delegated mode — verified against a
   *  live Gmail draft. There is no compose verb: a Gmail source answers
   *  `draft-compose` with `draft_disabled` no matter who asks, so offering it
   *  would only ever raise a dialog for an action the archive then refuses. */
  writeActions: Object.freeze(['msgvault.draft-reply']),
  /**
   * A DURATION NEVER COVERS THE WRITES, whatever the owner's `timedGrants`
   * switch says. "Full Slack access for an hour" is a bargain somebody may
   * reasonably want; "anything may put mail in your mailbox for an hour" is
   * the thing this whole mechanism exists to prevent, and without this it
   * would be bought with one click on a search. See Broker#timedScope.
   */
  timedReadOnly: true,
  get actions() {
    return Object.freeze([...this.readActions, ...this.writeActions]);
  },
});

export const CAPABILITIES = Object.freeze({ slack: SLACK, msgvault: MSGVAULT });

/** The capability an action belongs to, or undefined. The prefix IS the
 *  capability — `slack.post` is Slack's, `msgvault.search` is msgvault's — so
 *  no action can be claimed by two of them and none can be orphaned. */
export function capabilityOf(action) {
  if (typeof action !== 'string') return undefined;
  const dot = action.indexOf('.');
  if (dot <= 0) return undefined;
  return Object.hasOwn(CAPABILITIES, action.slice(0, dot))
    ? CAPABILITIES[action.slice(0, dot)]
    : undefined;
}
