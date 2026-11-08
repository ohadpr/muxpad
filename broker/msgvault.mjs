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

const str = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;
/** An id as msgvault prints it. Deliberately narrow: ids come back from a
 *  previous approved read, so anything outside this is not an id the agent
 *  could have learned legitimately. */
const ID = /^[A-Za-z0-9_.:@+-]{1,128}$/;

const fail = (m) => {
  throw new Error(m);
};

/**
 * Each action: how to validate the payload, and the exact argv to run.
 * `describe` is the one line the human reads in the dialog — it must name the
 * thing being asked for, because approving "search" without its query is
 * approving nothing.
 */
const SPEC = {
  'msgvault.search': {
    validate: (p) => {
      if (!str(p.query, 512)) fail('Give a msgvault search query');
      const limit = p.limit === undefined ? 50 : p.limit;
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) fail('limit must be 1..200');
      return { query: p.query, limit };
    },
    argv: (p) => ['search', p.query, '--limit', String(p.limit), '--json'],
    describe: (p) => `search the archive for ${JSON.stringify(p.query)}`,
  },
  'msgvault.show-message': {
    validate: (p) => (ID.test(String(p.id ?? '')) ? { id: p.id } : fail('Give a message id')),
    argv: (p) => ['show-message', p.id, '--json'],
    describe: (p) => `read message ${p.id}`,
  },
  'msgvault.show-thread': {
    validate: (p) => (ID.test(String(p.id ?? '')) ? { id: p.id } : fail('Give a message id')),
    argv: (p) => ['show-thread', p.id, '--json'],
    describe: (p) => `read the thread around message ${p.id}`,
  },
  'msgvault.list-senders': {
    validate: (p) => {
      const limit = p.limit === undefined ? 20 : p.limit;
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) fail('limit must be 1..200');
      return { limit };
    },
    argv: (p) => ['list-senders', '-n', String(p.limit), '--json'],
    describe: (p) => `list the top ${p.limit} senders`,
  },
  'msgvault.stats': {
    validate: () => ({}),
    argv: () => ['stats'],
    describe: () => 'read archive totals (no message content)',
  },
  'msgvault.meetings': {
    validate: (p) => (p.query === undefined ? {} : str(p.query, 512)
      ? { query: p.query }
      : fail('meetings query must be a short string')),
    argv: (p) => (p.query === undefined ? ['meetings', '--json'] : ['meetings', p.query, '--json']),
    describe: (p) => (p.query === undefined ? 'read meeting context' : `read meetings matching ${JSON.stringify(p.query)}`),
  },
  'msgvault.person': {
    validate: (p) => (str(p.query, 200) ? { query: p.query } : fail('Give a name or address')),
    argv: (p) => ['person', p.query, '--json'],
    describe: (p) => `look up the contact ${JSON.stringify(p.query)}`,
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
