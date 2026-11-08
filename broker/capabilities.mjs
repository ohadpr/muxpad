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
 * msgvault: the user's mail, calendar and contacts archive.
 *
 * EVERY VERB IS A READ, and that is not a reason to skip the dialog — the
 * dialog is what stops an agent reading years of someone's life unattended.
 * It is the reason there is no `fullScope` separate from `readScope`: there is
 * no write set to hold back, so the two are the same list and a timed grant
 * covers exactly what a single approval would have.
 */
export const MSGVAULT = Object.freeze({
  id: 'msgvault',
  label: 'your mail archive',
  readScope: 'msgvault-read-v1',
  fullScope: 'msgvault-read-v1',
  readActions: Object.freeze([
    'msgvault.search',
    'msgvault.show-message',
    'msgvault.show-thread',
    'msgvault.list-senders',
    'msgvault.stats',
    'msgvault.meetings',
    'msgvault.person',
  ]),
  get actions() {
    return this.readActions;
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
