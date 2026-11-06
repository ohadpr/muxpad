import { FORBIDDEN_FLAGS, REFUSED_COMMANDS } from './registry.js';

/**
 * `muxpad msgvault <any msgvault args>` — the argument filter.
 *
 * ── WHY A PASS-THROUGH AND NOT AN API ────────────────────────────────────
 * The owner's instruction: "Ideally agent uses msgvault CLI because it's
 * likely rich and well documented… I'd rather not invent a wrapper API around
 * it." So the agent writes msgvault's own verbs, query syntax and `--json`,
 * and muxpad forwards argv to the real binary with a credential injected. The
 * agent learns the tool, not a muxpad dialect of it.
 *
 * ── WHAT THIS FILTER IS FOR ──────────────────────────────────────────────
 * Two classes of argument would escape the mediator rather than use it:
 *
 *   · flags that RE-POINT the tool — at a different daemon, a different
 *     credential file, a different archive, or at its own local database
 *     instead of the delegated API;
 *   · subcommands that read or move MORE than any grant describes — `query`
 *     runs arbitrary SQL over the whole archive under a `search.read` grant,
 *     the `export-*` family writes bulk copies to disk where no grant follows
 *     them, `export-token` hands out the provider credential itself.
 *
 * ── AND WHY IT IS NOT THE BOUNDARY ───────────────────────────────────────
 * This code runs in muxpad's process, which the agents it filters can edit, so
 * the broker applies the same list before it mints a grant. A reviewer put it
 * exactly right: a filter that lives only here is a filter inside the thing it
 * is filtering. What this buys is a refusal that happens immediately, in the
 * agent's own terminal, with a reason it can act on.
 *
 * ── WHY IT CANNOT COUNT ON POSITION, AND WHAT IT DOES INSTEAD ────────────
 * The first version of this read "the first bare token" as the subcommand.
 * That is wrong, and a reviewer broke it in one line:
 *
 *     muxpad msgvault --log-file search query 'SELECT * FROM messages'
 *
 * `--log-file` TAKES A VALUE, so msgvault consumes `search` as that value and
 * runs `query` — while the filter, counting bare tokens, saw `search` and
 * asked for a timed `search.read`. Arbitrary SQL over the whole archive,
 * approved as a search. `--config`, `--home`, `--log-level`, `--agent-url`
 * and `--log-sql-slow-ms` all take values too.
 *
 * Enumerating every flag's arity is not possible: the per-command flags belong
 * to another project and change with its releases. So the ambiguity is removed
 * instead of guessed at — a flag is accepted only when its value cannot be
 * mistaken for a token:
 *
 *   · `--flag=value` is always unambiguous and always allowed (subject to the
 *     forbidden list);
 *   · a bare `--flag` is allowed only when muxpad KNOWS it takes no value;
 *   · anything else is refused, with the `=` form suggested.
 *
 * NESTED SUBCOMMANDS, for the same reason. `msgvault calendar` is a parent:
 * `calendar create`, `calendar delete`, `calendar move` are writes that send
 * invitations, and classifying the parent made them a timed READ. For a known
 * parent the verb is looked up on the PAIR, and an unmapped pair is refused.
 *
 * A lone `--` is refused outright. It conventionally ends option parsing,
 * msgvault's parser does not treat it that way for global flags, and no
 * legitimate call here needs it.
 */

export interface PassthroughVerdict {
  ok: boolean;
  /** The subcommand, when one was found — for the audit record. */
  command?: string;
  reason?: string;
}

/** `--home=/x` → `--home`; `-v` → `-v`. Case is preserved: msgvault's flags
 *  are lower-case and a differently-cased spelling is not a flag it accepts. */
function flagName(token: string): string {
  const eq = token.indexOf('=');
  return eq === -1 ? token : token.slice(0, eq);
}

/**
 * Flags that take NO value, so a bare one cannot swallow the next token.
 *
 * Short and conservative on purpose: everything else must arrive as
 * `--flag=value`. Being wrong here is the bug this list exists to prevent, so
 * it holds only flags read straight off `msgvault --help`'s global section
 * plus the two output flags every call uses.
 */
const VALUELESS_FLAGS = new Set([
  '--json',
  '--verbose',
  '-v',
  '--help',
  '-h',
  '--no-log-file',
  '--log-sql',
]);

/**
 * Commands whose real verb is the PAIR. Each of these has its own subcommand
 * list, including writes, so the parent says nothing about what will happen.
 */
const NESTED = new Set([
  'calendar',
  'person',
  'identity',
  'message-tags',
  'collection',
  'organization',
  'employment',
  'relationship-type',
  'attribute-definition',
  'carddav',
  'documents',
  'embeddings',
  'multimodal',
  'docbank',
  'agent-token',
  'claude-account',
]);

/**
 * Judge an argv.
 *
 * Refusals name the offending token, because the agent's useful next move is
 * to reach for a different verb rather than to retry the same one.
 */
export function judgeArgv(argv: readonly string[]): PassthroughVerdict {
  if (argv.length === 0)
    return { ok: false, reason: 'say what to run, e.g. muxpad msgvault search "from:x"' };

  const bare: string[] = [];
  for (const raw of argv) {
    if (typeof raw !== 'string') return { ok: false, reason: 'arguments must be strings' };
    if (raw === '')
      return { ok: false, reason: 'an empty argument is not something muxpad can judge' };
    if (raw === '--')
      return {
        ok: false,
        reason: 'muxpad does not pass a bare `--`: msgvault still reads global flags after it',
      };
    if (raw.startsWith('-')) {
      const name = flagName(raw);
      if (FORBIDDEN_FLAGS.includes(name))
        return {
          ok: false,
          reason: `${name} would point msgvault somewhere other than the approved daemon, so muxpad will not pass it`,
        };
      // An `=` makes the value part of the token, so nothing can be swallowed.
      if (raw.includes('=')) continue;
      if (VALUELESS_FLAGS.has(raw)) continue;
      // THE BYPASS THIS PREVENTS: `--log-file search query …` runs `query`,
      // while a filter counting bare tokens sees `search`.
      return {
        ok: false,
        reason: `pass ${name} as ${name}=value — muxpad cannot tell whether a bare flag takes the next word, and msgvault's value-taking flags would otherwise hide the real subcommand`,
      };
    }
    bare.push(raw);
  }

  const head = bare[0];
  if (head === undefined) return { ok: false, reason: 'no subcommand — flags alone do nothing' };
  if (REFUSED_COMMANDS.includes(head))
    return {
      ok: false,
      command: head,
      reason: `muxpad will not run "${head}" — it reads or moves more of the archive than an approval can describe`,
    };
  // A parent command says nothing about what will happen; the pair does.
  if (NESTED.has(head)) {
    const sub = bare[1];
    if (!sub) return { ok: false, command: head, reason: `"${head}" needs a subcommand` };
    return { ok: true, command: `${head} ${sub}` };
  }
  return { ok: true, command: head };
}

/**
 * The verb an approval is asked for, from a judged argv.
 *
 * Deliberately coarse: a `search` is `msgvault.search.read` whatever its
 * query, so one approval covers the shape of the request rather than its
 * text. An unmapped command returns null and the caller must refuse — that is
 * the fail-closed half of {@link judgeArgv}, which only knows what is BANNED.
 *
 * Mapped onto msgvault's own permission vocabulary, so the grant the broker
 * mints and the command that runs name the same thing.
 */
const COMMAND_VERBS: Record<string, string> = {
  search: 'msgvault.search.read',
  'show-message': 'msgvault.message.read',
  'show-thread': 'msgvault.message.read',
  'list-accounts': 'msgvault.stats.read',
  'list-senders': 'msgvault.stats.read',
  'list-domains': 'msgvault.stats.read',
  'list-labels': 'msgvault.stats.read',
  stats: 'msgvault.stats.read',
  meetings: 'msgvault.message.read',
  media: 'msgvault.message.read',
  // Only the READ pairs are mapped. `calendar create|update|delete|move|respond`
  // are writes that can notify guests, so they are absent and therefore
  // refused — a parent classified as a read is how they slipped through.
  'calendar list': 'msgvault.calendar.read',
  'calendar show': 'msgvault.calendar.event.read',
  'calendar freebusy': 'msgvault.calendar.read',
  'calendar conflicts': 'msgvault.calendar.read',
  'person find': 'msgvault.message.read',
  'person show': 'msgvault.message.read',
  'person list': 'msgvault.message.read',
  'draft-compose': 'msgvault.draft.create',
  'draft-reply': 'msgvault.draft.create',
  'draft-forward': 'msgvault.draft.create',
  'draft-edit': 'msgvault.draft.edit',
  'draft-delete': 'msgvault.draft.delete',
  'draft-get': 'msgvault.message.read',
};

export function verbForCommand(command: string): string | null {
  return Object.hasOwn(COMMAND_VERBS, command) ? (COMMAND_VERBS[command] ?? null) : null;
}

/** Every command the pass-through can currently ask an approval for. */
export function passthroughCommands(): string[] {
  return Object.keys(COMMAND_VERBS).sort();
}

/**
 * IS THERE ANYTHING TO MEDIATE YET?
 *
 * A reviewer's first finding, and it is the one that makes the rest of this
 * file academic until it is fixed: `~/.msgvault/msgvault.db` is mode 0644 and
 * owned by the account every agent runs as, so an agent that does not feel like
 * asking can read the whole archive with `sqlite3`. Filtering its CLI arguments
 * while that is true is theatre, and worse than nothing — it tells the owner a
 * boundary exists where none does.
 *
 * So `muxpad msgvault` REFUSES while the archive is readable by its own
 * account, naming the reason. The feature arrives when the root-owned install
 * does, and not a day earlier. "Fails closed" here means "fails loud": the
 * agent is told the install is incomplete rather than quietly handed the data
 * it was going to get anyway.
 *
 * Pure given a stat, like the policy checks, so every branch is testable
 * without being root.
 */
export interface Readable {
  uid: number;
  mode: number;
}

export function mediationReady(
  db: Readable | null,
  selfUid: number,
): { ready: boolean; problem?: string } {
  if (!db) return { ready: false, problem: 'no msgvault archive was found to mediate' };
  if (db.uid === selfUid)
    return {
      ready: false,
      problem:
        'the msgvault archive is owned by the account agents run as, so it can be read without asking — muxpad will not pretend to mediate it',
    };
  if (db.mode & 0o044)
    return {
      ready: false,
      problem:
        'the msgvault archive is group- or world-readable, so it can be read without asking — muxpad will not pretend to mediate it',
    };
  return { ready: true };
}
