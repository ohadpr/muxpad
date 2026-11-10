/**
 * WHAT EACH CONNECTOR VERB ACTUALLY DOES — the table the approval model needs.
 *
 * ── WHY THIS EXISTS SEPARATELY FROM THE SCOPING RULE ─────────────────────
 * `scope.ts` answers "may this machine's chats use this connector at all".
 * This answers the question that comes next and is just as easy to get wrong:
 * given that they may, is THIS verb a read or a write, and may it run on a
 * grant you gave earlier rather than one you are giving now.
 *
 * The owner's shape, in their words: "Long time grants are ok — my main
 * concern is mixing personal/work". So reads ride a timed grant and writes do
 * not, which is what makes "approve msgvault for a day" safe to offer: a day
 * of searching is a day of searching, not a day of sending.
 *
 * ── THREE RULES, AND THE REASON FOR EACH ─────────────────────────────────
 *
 * 1. AN UNKNOWN VERB IS REFUSED. Not "treated as a write" — refused. A verb
 *    this build has never heard of has no classification, and guessing on
 *    behalf of a future msgvault release is how `calendar.invite` would have
 *    arrived as a read.
 *
 * 2. A WRITE NEVER RIDES A TIMED GRANT. The payload is the thing you are
 *    consenting to, and a grant issued before the payload existed cannot have
 *    consented to it. This is the rule the existing Slack grant breaks today:
 *    `{teamID, 'slack-team-all-v2'}` covers all eleven verbs for a day,
 *    posting included.
 *
 * 3. SOME WRITES REACH OTHER PEOPLE, and that is worth saying out loud in the
 *    prompt rather than leaving the reader to know it. `calendar.invite` emails
 *    the attendees; `slack.post` is visible to a channel; a draft is not. The
 *    owner's requirement was "create email drafts, never send email", and an
 *    invite is the verb that walks around that requirement without being
 *    called "send".
 *
 * ── THIS COPY IS ADVISORY, LIKE THE SCOPING RULE ─────────────────────────
 * muxpad's process can be edited by the agents it is classifying, so the
 * broker enforces its own copy of this table before it mints anything. What
 * this buys is a refusal that happens early and explains itself, and ONE place
 * where a new connector's verbs are written down.
 */

export type VerbKind = 'read' | 'write';

export interface VerbRule {
  kind: VerbKind;
  /** May this run on a grant approved earlier? Writes: never. */
  timed: boolean;
  /** Does it reach people other than the owner? Shown in the prompt. */
  notifiesOthers?: boolean;
  /** Refused outright, with this reason. */
  refuse?: string;
}

/**
 * Slack, matching the broker's own `TEAM_ACTIONS` vocabulary.
 *
 * `unpost` and `edit` are writes even though they remove or change rather than
 * add: deleting someone's view of a message is as visible as posting one, and
 * an edit can turn an approved sentence into any other sentence.
 */
const SLACK: Record<string, VerbRule> = {
  'slack.read': { kind: 'read', timed: true },
  'slack.search': { kind: 'read', timed: true },
  'slack.channels': { kind: 'read', timed: true },
  'slack.users': { kind: 'read', timed: true },
  'slack.thread': { kind: 'read', timed: true },
  'slack.post': { kind: 'write', timed: false, notifiesOthers: true },
  'slack.dm': { kind: 'write', timed: false, notifiesOthers: true },
  'slack.react': { kind: 'write', timed: false, notifiesOthers: true },
  'slack.edit': { kind: 'write', timed: false, notifiesOthers: true },
  'slack.unpost': { kind: 'write', timed: false, notifiesOthers: true },
  'slack.upload': { kind: 'write', timed: false, notifiesOthers: true },
};

/**
 * msgvault — the ACTIONS THE BROKER ACCEPTS, which is now the only vocabulary.
 *
 * ── WHY THIS LIST CHANGED SHAPE ──────────────────────────────────────────
 * It used to mirror the permission words `agent-token issue` takes
 * (`search.read`, `draft.create`, `calendar.invite`…), because the design at
 * the time was: hand the agent a scoped token and FILTER the argv it writes.
 * That design is gone. The broker composes the command line itself from a
 * validated payload (broker/capabilities.mjs, broker/msgvault.mjs), so what
 * muxpad must be able to classify is the broker's action, not msgvault's
 * permission word.
 *
 * Two vocabularies for one connector is how a verb ends up approved under a
 * name that does not describe it — which is the exact bug a reviewer found in
 * the argv filter. So there is one.
 *
 * FOUR, not seven. `list-senders`, `meetings` and `person` were listed and
 * cannot work against msgvault 0.22.0 — verified against the real binary:
 * `list-senders` is refused by agent-delegated mode, and the other two are
 * parent command trees with no positional and no `--json`. A verb muxpad
 * will classify and the tool will refuse is a prompt asking for something
 * that cannot happen.
 *
 * ── IT IS NOT ALL READS ANY MORE ────────────────────────────────────────
 * It was, and this note said so. Drafting is the exception, and it is listed
 * as what it is: `kind: 'write'`, `timed: false`. A draft may never ride an
 * existing grant, so every one of them is approved on its own with its text
 * on screen — enforced in the broker (capabilities' `timedReadOnly`) and said
 * again here, because this table is what muxpad uses to describe an approval
 * before the broker ever sees it.
 *
 * `calendar.write` and `calendar.invite` are still absent, and that is still
 * stronger than refusing them: no action name to request, no validator to
 * reach, no argv template to fill. Inviting attendees is sending mail under
 * somebody's name, which is the line drafting deliberately does not cross —
 * the grant carries draft permissions and no send permission at all.
 */
const MSGVAULT: Record<string, VerbRule> = {
  'msgvault.search': { kind: 'read', timed: true },
  'msgvault.show-message': { kind: 'read', timed: true },
  'msgvault.show-thread': { kind: 'read', timed: true },
  'msgvault.stats': { kind: 'read', timed: true },
  // `notifiesOthers: false`, stated rather than left absent: it is the fact
  // that separates a draft from every other write in this table. Nothing
  // leaves, nobody is told, and the owner opens their mailbox to find it.
  'msgvault.draft': { kind: 'write', timed: false, notifiesOthers: false },
  'msgvault.draft-reply': { kind: 'write', timed: false, notifiesOthers: false },
};

export const VERBS: Record<string, VerbRule> = { ...SLACK, ...MSGVAULT };

export interface Classification {
  ok: boolean;
  kind?: VerbKind;
  /** May it run on an existing grant? False for every write, and for a
   *  refusal, so a caller that ignores `ok` still cannot auto-dispatch. */
  timed: boolean;
  notifiesOthers?: boolean;
  reason?: string;
}

/**
 * Classify a verb, failing closed.
 *
 * Note `timed: false` on every refusal path. A caller that checks only
 * `classify(...).timed` before reusing a grant is wrong, but it is wrong in
 * the safe direction — which is the one property worth having in a function
 * whose answers decide whether something runs without asking.
 */
export function classify(verb: string): Classification {
  const rule = Object.hasOwn(VERBS, verb) ? VERBS[verb] : undefined;
  if (!rule)
    return {
      ok: false,
      timed: false,
      reason: `muxpad does not know the verb ${verb}, so it cannot say what approving it would allow`,
    };
  if (rule.refuse) return { ok: false, kind: rule.kind, timed: false, reason: rule.refuse };
  return {
    ok: true,
    kind: rule.kind,
    // Belt and braces: a write is never timed even if the table says so.
    timed: rule.kind === 'read' && rule.timed,
    // ALWAYS present for a verb that will run. "Does this reach other
    // people?" is a question that must not be answered by a missing field:
    // absent reads as false at a call site that forgot to think about it, and
    // reads as "nobody asked" at one that did. It is a boolean now.
    notifiesOthers: rule.notifiesOthers === true,
  };
}

/** Every verb muxpad knows, for generating the broker's allowlist and for
 *  showing a reader what a connector can do at all. */
export function verbsOf(connector: string): string[] {
  const prefix = `${connector}.`;
  return Object.keys(VERBS)
    .filter((v) => v.startsWith(prefix))
    .sort();
}

/**
 * ── WHAT USED TO BE HERE, AND WHY IT IS NOT ──────────────────────────────
 * `FORBIDDEN_FLAGS` and `REFUSED_COMMANDS`: the flags and subcommands the
 * argv pass-through had to strip — `--agent-url`, `--home`, `query`,
 * `export-*`, `export-token` and the rest.
 *
 * They are gone because the thing they protected is gone. The agent no longer
 * writes argv at all: it sends an action and a payload, and the broker
 * composes the command line from a fixed template (broker/capabilities.mjs,
 * broker/msgvault.mjs). A filter has to enumerate what is dangerous and a
 * reviewer broke this one in a single line — `--log-file search query
 * \'SELECT …\'` ran arbitrary SQL approved as a search, because a
 * value-taking flag swallowed the subcommand. A template has no slot to
 * smuggle a flag through, so the class of attack is absent rather than
 * defended against.
 *
 * Do not bring them back without bringing back argv forwarding, which is the
 * only thing they were ever for.
 */
