/**
 * msgvault, from the broker's side of the wall.
 *
 * The agent never holds the grant, never names the binary and never writes a
 * flag. It sends an action and a payload; this module validates the payload,
 * composes the whole command line itself, and runs it as the broker's own
 * account with the grant file the agent cannot open.
 *
 * ── EVERY ARGUMENT IS COMPOSED, NEVER FORWARDED ──────────────────────────
 * See capabilities.mjs for why. The short version: a filter must enumerate
 * what is dangerous and one was broken in a single line during review, while
 * a template has no slot for a flag at all. `spec` below is that template —
 * the verb is a constant, and every value that varies is checked against a
 * shape before it is placed.
 *
 * ── AND THE DAEMON STILL REFUSES INDEPENDENTLY ───────────────────────────
 * Measured through this grant: `query` (arbitrary SQL), `export-messages`,
 * `export-token`, `list-accounts` and `draft-compose` are refused by
 * msgvault's own delegated mode. So the list below is not the only thing
 * standing between an agent and the archive — it is the part that decides
 * what the human is asked to approve.
 */

/**
 * NO LEADING `-`, ANYWHERE A VALUE IS FREE TEXT.
 *
 * A review disproved this file's own claim. msgvault is cobra/pflag, so a
 * positional beginning with `-` IS parsed as a flag at the binary, whatever
 * the argv array looks like from here: `search '--local'` came back with
 * "provide a search query", i.e. the query had been eaten. The argv-array
 * assertion in the tests was true and irrelevant.
 *
 * Two defences, both applied, because they fail differently:
 *   · reject a leading `-` here, so the DIALOG and the command agree — a
 *     query the human reads as text must not run as a flag;
 *   · pass `--` before the positional (see the templates), so even a value
 *     that gets past this cannot be read as one.
 *
 * Verified against msgvault 0.22.0 offline: `search --json -- '--account=x'`
 * reaches the daemon with the string intact, while `search '--account=x'`
 * does not.
 */
const str = (v, max) =>
  typeof v === 'string' && v.length > 0 && v.length <= max && !v.startsWith('-');
/** An id as msgvault prints it. Deliberately narrow: ids come back from a
 *  previous approved read, so anything outside this is not an id the agent
 *  could have learned legitimately — and it may not begin with `-`. */
const ID = /^(?!-)[A-Za-z0-9_.:@+-]{1,128}$/;

const fail = (m) => {
  throw new Error(m);
};

/**
 * Each action: how to validate the payload, and the exact argv to run.
 * `describe` is the one line the human reads in the dialog — it must name the
 * thing being asked for, because approving "search" without its query is
 * approving nothing.
 */
/**
 * ── WHAT IS NOT HERE, AND WHY ────────────────────────────────────────────
 * `list-senders`, `meetings` and `person` were advertised and CANNOT WORK
 * against msgvault 0.22.0. Verified offline against the real binary with a
 * dummy token and a dead agent-url, so the refusal comes from msgvault's own
 * argument handling rather than from any daemon:
 *
 *   list-senders  → "list-senders is not available in agent-delegated mode"
 *   meetings      → a parent command (actions|context|metrics); `meetings
 *                   --json` is "unknown flag", `meetings foo` is "unknown
 *                   command", and every subcommand is refused in delegated
 *                   mode too
 *   person        → a parent command tree (get|list|identities|…); `person
 *                   'Alice' --json` is "unknown flag" and takes the name as a
 *                   subcommand. The documented read-only lookup is a SQL
 *                   `query`, which delegated mode refuses by design.
 *
 * A review found two of these; the third turned up when every verb was run.
 * They are removed rather than repaired because repairing them means either
 * a verb that needs an id the agent has no way to get, or re-enabling a path
 * the archive deliberately closes. Four verbs that work beat seven that are
 * three-sevenths fiction.
 */
/** An email address, as a value this module will place on a command line.
 *  Deliberately plainer than RFC 5322: muxpad is not a mail client, and a
 *  shape this file can state in one line is a shape it can defend. */
const ADDRESS = /^(?!-)[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

/** Recipients: one or more addresses, repeatable at the binary as --to a --to b. */
const addresses = (v, what, max) => {
  const list = Array.isArray(v) ? v : v === undefined ? [] : [v];
  if (list.length === 0) return [];
  if (list.length > max) fail(`Too many ${what} addresses`);
  for (const a of list)
    if (typeof a !== 'string' || !ADDRESS.test(a)) fail(`Invalid ${what} address`);
  return list;
};

/** `--to a --to b`, the repeatable-flag shape msgvault takes. */
const repeat = (flag, list) => list.flatMap((v) => [flag, v]);

const SPEC = {
  'msgvault.search': {
    validate: (p) => {
      if (!str(p.query, 512)) fail('Give a msgvault search query');
      const limit = p.limit === undefined ? 50 : p.limit;
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) fail('limit must be 1..200');
      return { query: p.query, limit };
    },
    argv: (p) => ['search', '--limit', String(p.limit), '--json', '--', p.query],
    describe: (p) => `search the archive for ${JSON.stringify(p.query)}`,
  },
  'msgvault.show-message': {
    validate: (p) => (ID.test(String(p.id ?? '')) ? { id: p.id } : fail('Give a message id')),
    argv: (p) => ['show-message', '--json', '--', p.id],
    describe: (p) => `read message ${p.id}`,
  },
  'msgvault.show-thread': {
    validate: (p) => (ID.test(String(p.id ?? '')) ? { id: p.id } : fail('Give a message id')),
    argv: (p) => ['show-thread', '--json', '--', p.id],
    describe: (p) => `read the thread around message ${p.id}`,
  },
  'msgvault.stats': {
    validate: () => ({}),
    argv: () => ['stats'],
    describe: () => 'count your mail, calendar and contacts (no message content)',
  },
  /**
   * ── THE TWO WRITES ────────────────────────────────────────────────────
   *
   * A draft puts text an agent wrote into the owner's mailbox, under their
   * name, where it sits next to things they wrote themselves. That is worth
   * a dialog of its own every time, and it gets one: `writeActions` is not in
   * `readScope`, and core.mjs offers a duration only for the read scope.
   *
   * NEITHER CAN SEND. muxpad asks for no send verb and the grant carries no
   * send permission — the agent-token permissions are search.read,
   * message.read, attachment.read, stats.read, draft.create/edit/delete and
   * the calendar set. "It can never send" is a property of the grant, not a
   * promise this file makes.
   *
   * `--json` on both, so the result is a draft id the owner can open rather
   * than prose about having done it.
   */
  'msgvault.draft': {
    validate: (p) => {
      const to = addresses(p.to, 'to', 20);
      if (to.length === 0) fail('Give at least one recipient');
      const cc = addresses(p.cc, 'cc', 20);
      const bcc = addresses(p.bcc, 'bcc', 20);
      if (!str(p.subject, 300)) fail('Give a subject');
      if (!str(p.body, 20000)) fail('Give a body');
      return { to, cc, bcc, subject: p.subject, body: p.body };
    },
    argv: (p) => [
      'draft-compose',
      '--json',
      ...repeat('--to', p.to),
      ...repeat('--cc', p.cc),
      ...repeat('--bcc', p.bcc),
      '--subject',
      p.subject,
      '--body',
      p.body,
    ],
    describe: (p) => `draft an email to ${p.to.join(', ')} — "${p.subject}"`,
  },
  'msgvault.draft-reply': {
    validate: (p) => {
      if (!ID.test(String(p.id ?? ''))) fail('Give the message id to reply to');
      if (!str(p.body, 20000)) fail('Give a body');
      // `--all` is reply-to-everyone. Opt IN, because the difference between
      // answering one person and answering a thread of nine is exactly the
      // kind of thing a person must approve knowingly — and the dialog says
      // which it is.
      return { id: p.id, body: p.body, all: p.all === true };
    },
    argv: (p) => [
      'draft-reply',
      '--json',
      '--body',
      p.body,
      ...(p.all ? ['--all'] : []),
      '--',
      p.id,
    ],
    describe: (p) =>
      `draft a reply ${p.all ? 'to everyone on' : 'to the sender of'} message ${p.id}`,
  },
};

export function validateMsgvault(action, raw) {
  const spec = SPEC[action];
  if (!spec) fail('Unsupported action');
  return spec.validate(raw && typeof raw === 'object' ? raw : {});
}

export function describeMsgvault(action, payload) {
  const spec = SPEC[action];
  return spec ? spec.describe(payload) : action;
}

/**
 * The full command line, including the three flags that say who is asking.
 *
 * `--agent-allow-insecure` is honest only because `agentUrl` is pinned to
 * loopback by the declaration's own parser: the transport never leaves this
 * machine. The grant is passed as a PATH — the broker hands msgvault the file
 * and does not read it, so there is no step at which it could be logged.
 */
export function msgvaultArgv(action, payload, install) {
  const spec = SPEC[action];
  if (!spec) fail('Unsupported action');
  if (!install || !install.binary || !install.agentUrl || !install.tokenFile)
    fail('msgvault is not declared on this machine');
  return {
    binary: install.binary,
    args: [
      '--agent-url',
      install.agentUrl,
      '--agent-token-file',
      install.tokenFile,
      '--agent-allow-insecure',
      '--no-log-file',
      ...spec.argv(payload),
    ],
  };
}
