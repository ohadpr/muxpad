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
 * msgvault, matching the permission vocabulary `agent-token issue` accepts.
 *
 * There is no send permission and no send verb, which is half of "never
 * sends"; the other half is that the mediator exposes no endpoint for one.
 *
 * `calendar.write` and `calendar.invite` are the two that leave the machine.
 * Invite is REFUSED here rather than merely prompted: it emails the attendees,
 * so under a requirement of "drafts, never send email" it is a send with a
 * different name. If the owner wants it later it is one line and a prompt that
 * says who gets the mail.
 */
const MSGVAULT: Record<string, VerbRule> = {
  'msgvault.search.read': { kind: 'read', timed: true },
  'msgvault.message.read': { kind: 'read', timed: true },
  'msgvault.attachment.read': { kind: 'read', timed: true },
  'msgvault.stats.read': { kind: 'read', timed: true },
  'msgvault.calendar.read': { kind: 'read', timed: true },
  'msgvault.calendar.event.read': { kind: 'read', timed: true },
  'msgvault.draft.create': { kind: 'write', timed: false },
  'msgvault.draft.edit': { kind: 'write', timed: false },
  'msgvault.draft.delete': { kind: 'write', timed: false },
  'msgvault.calendar.write': { kind: 'write', timed: false, notifiesOthers: true },
  'msgvault.calendar.invite': {
    kind: 'write',
    timed: false,
    notifiesOthers: true,
    refuse: 'a calendar invite emails the attendees, which is sending mail under another name',
  },
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
    ...(rule.notifiesOthers ? { notifiesOthers: true } : {}),
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
 * GLOBAL FLAGS THE PASS-THROUGH MUST NOT FORWARD.
 *
 * `muxpad msgvault <args>` hands the agent's argv to the real binary, which is
 * the point — the CLI is rich and documented and muxpad should not re-model
 * it. These are the flags that would escape the mediator rather than use it:
 * two of them re-point the tool at a different daemon or credential, and two
 * re-point it at a different archive entirely.
 *
 * Enforced in the broker as well. A filter that lives only in muxpad's process
 * is a filter inside the thing it is filtering.
 */
export const FORBIDDEN_FLAGS = [
  '--home',
  '--config',
  '--agent-url',
  '--agent-token-file',
  '--agent-allow-insecure',
  '--local',
];

/**
 * SUBCOMMANDS THE PASS-THROUGH REFUSES.
 *
 * Each one reads or moves more than any grant describes:
 *   query              arbitrary SQL over the whole archive, under search.read
 *   export-*           bulk extraction to disk, where no grant follows it
 *   create-subset      a second copy of the archive, unmediated
 *   export-token       hands out the provider credential itself
 *   backup, gc         move or destroy the archive
 *   remove-account     destroys an account's data
 *   tui, mcp, serve    long-lived surfaces that outlive the request
 *   credentials        provider credentials on the daemon host
 */
export const REFUSED_COMMANDS = [
  'query',
  'create-subset',
  'export-token',
  'export-messages',
  'export-eml',
  'export-attachment',
  'export-attachments',
  'export-discord',
  'backup',
  'gc',
  'remove-account',
  'credentials',
  'tui',
  'mcp',
  'serve',
  'daemon',
  'setup',
  'update',
  'skills',
  'openapi',
];
