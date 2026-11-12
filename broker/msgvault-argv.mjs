/**
 * ── THE AGENT HANDS OVER ARGV; THIS DECIDES WHETHER IT MAY RUN ───────────
 *
 * The owner's design, after three capabilities each cost a hand-written verb
 * and a root install: "i'd almost like an arch where the agent produces a
 * list of args that go to msgvault and u just review them to remove any u
 * know shit we don't want. load msgvault --help so that the agent knows what
 * it can do."
 *
 * So there is no verb table here. There are three gates, and only one of
 * them is written by hand:
 *
 *   1 · THE COMMAND must be one msgvault actually has, and must not be
 *       INSTALL ADMINISTRATION. Connecting accounts, minting tokens,
 *       syncing, importing, repairing, the TUI — those are the owner's work
 *       on their own machine, and several would widen the grant if they ran
 *       (`agent-token`, `credentials`, `export-token`). This is the hand
 *       list, and it is a list of SHAPES rather than of verbs.
 *   2 · EVERY FLAG must appear in that subcommand's own `--help`. This is
 *       the gate that needs no maintenance and is tighter than the old verb
 *       table ever was: nothing used to check that the flags muxpad wrote by
 *       hand even existed, which is how `export-attachment` shipped dead.
 *   3 · AND A SHORT LIST OF FLAG SHAPES IS REFUSED whatever help says,
 *       because they do not change what the command does — they change WHO
 *       IT IS or WHO HEARS ABOUT IT: re-pointing the archive (`--home`,
 *       `--config`), overriding the grant (`--agent-*`), or reaching another
 *       person (`--attendees`, `--send-updates`, `--reminder`).
 *
 * msgvault's own delegated-mode gate still sits downstream of all three, and
 * the approval dialog still sits upstream: this decides only what is ALLOWED
 * TO BE ASKED.
 */

/** Commands that administer the install rather than read or write content. */
const ADMIN =
  /^(add|sync|backfill|repair|rebuild|stage|migrate|init|setup|serve|tui|update|upgrade|backup|restore|verify|schema|credentials|agent-token|export-token|oauth|login|logout|pack|unpack|repack|create-subset|archive-remote|deduplicate|merge|eval|skills|daemon|doctor|cache|build-cache|embeddings|index|reindex|vacuum|gc|remove-account|update-account|delete-deduped|delete-staged|import-|mcp|quickstart|logs|openapi|activity)/;

/**
 * Flags refused whatever `--help` says.
 *
 * Each one changes the IDENTITY of the call or sends something to a person,
 * which is the part an approval dialog cannot usefully describe and the
 * owner cannot usefully audit after the fact.
 */
const FORBIDDEN_FLAGS = [
  // Re-point the archive, the config or the grant.
  /^--home$/,
  /^--config$/,
  /^--local$/,
  /^--agent-/,
  // Reach another person.
  /^--attendees$/,
  /^--add-attendee$/,
  /^--send-updates$/,
  /^--reminder$/,
  // Choose whose mail this appears to be.
  /^--from$/,
  /^--account$/,
  /^--source-id$/,
  /^--oauth-app$/,
];
/** …except where the flag IS the subject: a calendar verb cannot work
 *  without `--account`, and `--from` is a time there, not an identity. */
const FLAG_EXCEPTIONS = { calendar: [/^--account$/, /^--from$/] };

/** `--scope all` deletes a whole recurring series; `single` is recoverable. */
const FORBIDDEN_VALUES = [{ flag: '--scope', bad: /^(all|future)$/ }];

export function parseHelpFlags(help) {
  const flags = new Set();
  for (const m of String(help).matchAll(/(^|\s)(--[a-z][a-z0-9-]*)/g)) flags.add(m[2]);
  return flags;
}

/**
 * @param args    the agent's argv, WITHOUT the binary
 * @param helpFor (command) => that subcommand's --help text
 * @returns {{ok: true, command: string}|{ok: false, why: string}}
 */
export function reviewArgv(args, helpFor) {
  if (!Array.isArray(args) || !args.length) return { ok: false, why: 'Give the msgvault arguments' };
  if (args.some((a) => typeof a !== 'string')) return { ok: false, why: 'Arguments must be strings' };
  if (args.length > 60) return { ok: false, why: 'Too many arguments' };
  const words = args.filter((a) => !a.startsWith('-'));
  const command = String(args[0] ?? '');
  if (!/^[a-z][a-z0-9-]*$/.test(command)) return { ok: false, why: 'The first argument must be a command' };
  if (ADMIN.test(command))
    return {
      ok: false,
      why: `${command} administers the archive itself — that is the owner's own work, not an agent's`,
    };
  // A subcommand (`calendar create`) gets its own help, so its own flags.
  const sub = words[1] && /^[a-z][a-z0-9-]*$/.test(words[1]) ? `${command} ${words[1]}` : command;
  const help = helpFor(sub) || helpFor(command);
  if (!help) return { ok: false, why: `msgvault has no command ${command}` };
  const allowed = parseHelpFlags(help);
  const exceptions = FLAG_EXCEPTIONS[command] ?? [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--' || !a.startsWith('--')) continue;
    const [flag, inlineValue] = a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, null];
    if (FORBIDDEN_FLAGS.some((re) => re.test(flag)) && !exceptions.some((re) => re.test(flag)))
      return { ok: false, why: `${flag} is not something an agent sets` };
    if (!allowed.has(flag)) return { ok: false, why: `${sub} has no ${flag}` };
    const rule = FORBIDDEN_VALUES.find((r) => r.flag === flag);
    if (rule && rule.bad.test(String(inlineValue ?? args[i + 1] ?? '')))
      return { ok: false, why: `${flag} ${inlineValue ?? args[i + 1]} is too broad for an agent` };
  }
  return { ok: true, command: sub };
}

/**
 * Is this argv a READ? Only a read may ride a duration.
 *
 * Stated as "every word in it is a query", not as a list of safe verbs: a
 * command that writes says so in its name (`create`, `update`, `delete`,
 * `draft-*`), and anything this does not recognise is treated as a write,
 * which is the direction a mistake should fall.
 */
const READS = /^(search|show-message|show-thread|stats|query|freebusy|conflicts|list|get)$/;
export function argvIsRead(args) {
  const words = args.filter((a) => !a.startsWith('-'));
  const [command, sub] = words;
  if (READS.test(String(command))) return true;
  if (String(command) === 'calendar') return READS.test(String(sub));
  if (/^draft-get$/.test(String(command))) return true;
  return false;
}
