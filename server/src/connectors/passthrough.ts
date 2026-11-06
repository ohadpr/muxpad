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
 * ── THE PARSING IS DELIBERATELY DUMB AND STRICT ──────────────────────────
 * It does not model msgvault's grammar — it cannot, since that grammar belongs
 * to another project and will change. It refuses anything it does not
 * positively understand in the two positions that matter: the first
 * non-flag token is the subcommand, and every token starting with `-` is
 * examined as a flag. Both forms of every flag are covered (`--home X` and
 * `--home=X`), and a token after a lone `--` is NOT trusted as an operand,
 * because msgvault's own flag parser does not stop there for global flags.
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
 * Judge an argv.
 *
 * Refusals name the offending token, because the agent's useful next move is
 * to reach for a different verb rather than to retry the same one.
 */
export function judgeArgv(argv: readonly string[]): PassthroughVerdict {
  if (argv.length === 0)
    return { ok: false, reason: 'say what to run, e.g. muxpad msgvault search "from:x"' };

  let command: string | undefined;
  for (const raw of argv) {
    // NO TOKEN IS EXEMPT. A lone `--` conventionally ends option parsing, and
    // trusting that here would hand over `-- --home /elsewhere`, which
    // msgvault's own parser still reads as a global flag.
    if (typeof raw !== 'string') return { ok: false, reason: 'arguments must be strings' };
    if (raw === '--') continue;
    if (raw.startsWith('-')) {
      const name = flagName(raw);
      if (FORBIDDEN_FLAGS.includes(name))
        return {
          ok: false,
          reason: `${name} would point msgvault somewhere other than the approved daemon, so muxpad will not pass it`,
        };
      continue;
    }
    // The first bare token is the subcommand; later ones are its operands and
    // are none of this filter's business.
    if (command === undefined) {
      command = raw;
      if (REFUSED_COMMANDS.includes(raw))
        return {
          ok: false,
          command,
          reason: `muxpad will not run "${raw}" — it reads or moves more of the archive than an approval can describe`,
        };
    }
  }
  if (command === undefined) return { ok: false, reason: 'no subcommand — flags alone do nothing' };
  return { ok: true, command };
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
  person: 'msgvault.message.read',
  meetings: 'msgvault.message.read',
  media: 'msgvault.message.read',
  calendar: 'msgvault.calendar.read',
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
