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
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { reviewArgv } from './msgvault-argv.mjs';

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

/** RFC3339, or a local `YYYY-MM-DDTHH:MM` paired with a zone. */
const CAL_WHEN = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?([.+-][\d:.]+|Z)?)?$/;
/** The account + calendar every calendar verb needs, validated once. */
function calendarAccount(p) {
  if (!str(p.account, 256) || !/^[^\s@]+@[^\s@]+$/.test(String(p.account)))
    fail('Give the calendar account (an email address)');
  return { account: p.account, calendar: str(p.calendar, 256) ? p.calendar : 'primary' };
}
/** …plus a time window, for the two reads. */
function calendarWindow(p) {
  const base = calendarAccount(p);
  if (!CAL_WHEN.test(String(p.start ?? ''))) fail('Give a start time (YYYY-MM-DDTHH:MM)');
  if (!CAL_WHEN.test(String(p.end ?? ''))) fail('Give an end time (YYYY-MM-DDTHH:MM)');
  if (!str(p.tz, 64)) fail('Give an IANA time zone, e.g. America/Los_Angeles');
  return { ...base, start: p.start, end: p.end, tz: p.tz };
}
function calendarRangeArgv(sub, p) {
  return [
    'calendar',
    sub,
    p.calendar,
    '--json',
    '--read-only',
    '--account',
    p.account,
    '--from',
    p.start,
    '--to',
    p.end,
    '--tz',
    p.tz,
  ];
}
/** Guests are the line between "your calendar changed" and "people were
 *  emailed". An agent never crosses it — refused, never dropped. */
function refuseGuests(p) {
  if (p.attendees !== undefined || p.addAttendee !== undefined)
    fail('Guests are not something an agent adds — invite people yourself');
  if (p.reminder !== undefined) fail('Reminders are not something an agent sets');
  if (p.sendUpdates !== undefined) fail('Guest notifications are not an agent’s to send');
}

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
  /**
   * ── ATTACHMENTS, BY CONTENT HASH ──────────────────────────────────────
   *
   * `show-message` lists a message's attachments with a `content_hash`; this
   * fetches one. The hash is the only input, and it is checked as exactly 64
   * hex characters — it is learnable only from an approved read, like an id.
   *
   * `--json`, never `-o`. `-o` writes a file AS THE BROKER'S ACCOUNT, which
   * is a write primitive the agent would be choosing the path of; `--json`
   * puts `data_base64` on stdout and the CLI writes the file as the caller.
   * The sender-chosen filename never reaches a path on this side either.
   *
   * A READ, and in the read scope: it is the body of a message the owner
   * already lets an agent read, delivered as bytes instead of text.
   */
  'msgvault.export-attachment': {
    validate: (p) =>
      /^[a-f0-9]{64}$/.test(String(p.hash ?? ''))
        ? { hash: p.hash }
        : fail('Give an attachment content_hash (64 hex characters, from show-message)'),
    argv: (p) => ['export-attachment', '--json', '--', p.hash],
    describe: (p) => `download one attachment (${p.hash.slice(0, 12)}…)`,
  },
  'msgvault.stats': {
    validate: () => ({}),
    argv: () => ['stats'],
    describe: () => 'count your mail, calendar and contacts (no message content)',
  },
  /**
   * ── THE ONE WRITE ─────────────────────────────────────────────────────
   *
   * A draft puts text an agent wrote into the owner's mailbox, under their
   * name, where it sits next to things they wrote themselves. That is worth
   * a dialog of its own every time, and it gets one: `writeActions` is not in
   * `readScope`, and core.mjs offers a duration only for the read scope.
   *
   * IT CANNOT SEND. muxpad asks for no send verb and the grant carries no
   * send permission — the agent-token permissions are search.read,
   * message.read, attachment.read, stats.read, draft.create/edit/delete and
   * the calendar set. "It can never send" is a property of the grant, not a
   * promise this file makes.
   *
   * THERE IS NO COMPOSE VERB, and that is msgvault's limit rather than a
   * choice made here: a Gmail source refuses `draft-compose` outright with
   * `draft_disabled`, while `draft-reply` creates a real Gmail draft in the
   * thread. Measured 2026-11-10 against msgvault 0.22.0, both run locally as
   * `_msgvault` so the agent layer was not in the way. A compose verb would
   * only ever raise a dialog for an action the archive then refuses, so there
   * is none. `[[imap.drafts]]` grants exist for IMAP sources; this archive has
   * no IMAP source, so nothing here depends on them.
   *
   * `--json`, so the result is a draft id the owner can open rather than
   * prose about having done it.
   */
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
  /**
   * ── AND THE REST OF THE DRAFT LIFECYCLE ───────────────────────────────
   *
   * Read, replace, delete — the three that make a draft something an agent
   * can work ON rather than only produce. Asked for directly: "CRUD for
   * drafts should fall under the blanket msgvault approval, these are just
   * drafts they are not sent automatically."
   *
   * `draft-compose` is still absent and still not an oversight: a Gmail
   * source answers it `draft_disabled` whoever asks, so offering it would
   * raise a dialog for something the archive then refuses. Create is
   * `draft-reply`; there is no other create.
   *
   * `--revision` is deliberately NOT exposed. msgvault uses it for optimistic
   * concurrency, and a wrong guess from an agent would clobber an edit the
   * owner made in their mail client between the read and the write. Without
   * it the tool applies its own rule.
   */
  /**
   * ── A NEW EMAIL, AND WHY IT IS HERE AFTER ALL ─────────────────────────
   *
   * This verb was deliberately absent: measured 2026-11-10 against msgvault
   * 0.22, a Gmail source answered `draft-compose` with `draft_disabled`, and
   * a verb that raises a dialog and then fails is worse than no verb.
   *
   * The owner asked for it anyway, after a chat could not write to someone
   * there was no prior thread with — which is the case reply-only cannot
   * serve at all, and the one people actually hit. So it is offered, and the
   * refusal (if the source still refuses) is passed back verbatim rather
   * than dressed up: msgvault's `draft_disabled` is a better answer than
   * muxpad pretending the capability does not exist.
   *
   * STILL NO SEND. This creates a draft in the mailbox exactly like
   * `draft-reply`; nothing at this grant can put it on the wire.
   *
   * `--account`, `--from` and `--source-id` are NOT exposed. Choosing which
   * identity a mail appears to come from is the owner's, not an agent's, and
   * msgvault picks the source itself when it is not told.
   */
  /**
   * ── A CALENDAR EVENT, AND THE ONE LINE THAT KEEPS IT A DRAFT-SHAPED ACT ─
   *
   * msgvault can write live Google Calendar events; muxpad never offered it,
   * so a chat asked to put a birthday party in the calendar could only hand
   * back an .ics file — and muxpad then refused to display that too.
   *
   * NO GUESTS AND NO REMINDERS FROM AN AGENT. `--attendees` is the flag that
   * turns this from "something appeared in your calendar" into "nine people
   * got an invitation from you", and that is a different act with a
   * different blast radius; `--reminder` likewise reaches your devices
   * later. Neither is accepted here, so an event created this way notifies
   * nobody — which is what lets it ride the same approval as a draft.
   * Inviting people stays a thing the owner does themselves.
   *
   * The ACCOUNT is required by msgvault and is not guessed: it is the source
   * that owns the calendar, and picking one for the owner is the same class
   * of decision as picking which identity a mail comes from.
   */
  'msgvault.calendar-create': {
    validate: (p) => {
      if (!str(p.account, 256) || !/^[^\s@]+@[^\s@]+$/.test(String(p.account)))
        fail('Give the calendar account (an email address)');
      if (!str(p.summary, 500)) fail('Give the event a title');
      // RFC3339, or a local `YYYY-MM-DDTHH:MM` paired with a zone.
      const when = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?([.+-][\d:.]+|Z)?)?$/;
      if (!when.test(String(p.start ?? ''))) fail('Give a start time (YYYY-MM-DDTHH:MM)');
      if (!when.test(String(p.end ?? ''))) fail('Give an end time (YYYY-MM-DDTHH:MM)');
      if (!str(p.tz, 64)) fail('Give an IANA time zone, e.g. America/Los_Angeles');
      refuseGuests(p);
      return {
        account: p.account,
        calendar: str(p.calendar, 256) ? p.calendar : 'primary',
        summary: p.summary,
        start: p.start,
        end: p.end,
        tz: p.tz,
        ...(str(p.location, 500) ? { location: p.location } : {}),
        ...(str(p.description, 5000) ? { description: p.description } : {}),
      };
    },
    argv: (p) => [
      'calendar',
      'create',
      p.calendar,
      '--json',
      '--account',
      p.account,
      '--summary',
      p.summary,
      '--from',
      p.start,
      '--to',
      p.end,
      '--tz',
      p.tz,
      ...(p.location ? ['--location', p.location] : []),
      ...(p.description ? ['--description', p.description] : []),
    ],
    describe: (p) =>
      `put "${p.summary}" in the ${p.calendar} calendar of ${p.account}, ${p.start} to ${p.end} (${p.tz}) — no guests, no reminders`,
  },
  /**
   * ── THE READS THAT MAKE THE CALENDAR USABLE ───────────────────────────
   *
   * Creating an event without being able to ask "is that slot free" is half
   * a capability, and the half that comes back for another admin install.
   * Both are reads of the owner's own calendar; `--read-only` is passed so
   * the tool itself forbids a mutation even if something later changes.
   */
  /**
   * THE ARGV PATH. No flags of our own, no shape to keep in step with
   * msgvault's: what the agent sends is what runs, if the review lets it.
   */
  'msgvault.run': {
    validate: (p) => {
      const args = Array.isArray(p.args) ? p.args.map(String) : [];
      const verdict = reviewArgv(args, msgvaultHelp);
      if (!verdict.ok) fail(verdict.why);
      return { args };
    },
    argv: (p) => p.args,
    describe: (p) => `run msgvault ${p.args.join(' ')}`,
  },
  'msgvault.calendar-freebusy': {
    validate: (p) => calendarWindow(p),
    argv: (p) => calendarRangeArgv('freebusy', p),
    describe: (p) => `check busy times in ${p.calendar} for ${p.account}, ${p.start} to ${p.end}`,
  },
  'msgvault.calendar-conflicts': {
    validate: (p) => calendarWindow(p),
    argv: (p) => calendarRangeArgv('conflicts', p),
    describe: (p) => `find overlapping events in ${p.calendar} for ${p.account}, ${p.start} to ${p.end}`,
  },
  /**
   * ── AND FIXING ONE AFTER THE FACT ─────────────────────────────────────
   *
   * Same guest rule as create, and for the same reason: `--attendees` and
   * `--add-attendee` turn a calendar edit into mail somebody else receives.
   * `--send-updates` defaults to none and is never raised from here.
   */
  'msgvault.calendar-update': {
    validate: (p) => {
      const base = calendarAccount(p);
      if (!str(p.event, 256)) fail('Give the event id to update');
      refuseGuests(p);
      const when = CAL_WHEN;
      if (p.start !== undefined && !when.test(String(p.start))) fail('Bad start time');
      if (p.end !== undefined && !when.test(String(p.end))) fail('Bad end time');
      if (p.start !== undefined && !str(p.tz, 64)) fail('A new time needs its IANA zone');
      return {
        ...base,
        event: p.event,
        ...(p.summary !== undefined ? { summary: p.summary } : {}),
        ...(p.start !== undefined ? { start: p.start } : {}),
        ...(p.end !== undefined ? { end: p.end } : {}),
        ...(p.tz !== undefined ? { tz: p.tz } : {}),
        ...(p.location !== undefined ? { location: p.location } : {}),
      };
    },
    argv: (p) => [
      'calendar',
      'update',
      p.calendar,
      p.event,
      '--json',
      '--account',
      p.account,
      ...(p.summary ? ['--summary', p.summary] : []),
      ...(p.start ? ['--from', p.start] : []),
      ...(p.end ? ['--to', p.end] : []),
      ...(p.tz ? ['--tz', p.tz] : []),
      ...(p.location ? ['--location', p.location] : []),
    ],
    describe: (p) => `change event ${p.event} in ${p.calendar} (${p.account}) — no guest changes`,
  },
  'msgvault.calendar-delete': {
    validate: (p) => {
      const base = calendarAccount(p);
      if (!str(p.event, 256)) fail('Give the event id to delete');
      return { ...base, event: p.event };
    },
    argv: (p) => [
      'calendar',
      'delete',
      p.calendar,
      p.event,
      '--json',
      '--account',
      p.account,
      // A recurring series is never removed wholesale by an agent: one
      // occurrence is recoverable by hand, a year of them is not.
      '--scope',
      'single',
    ],
    describe: (p) => `delete event ${p.event} from ${p.calendar} (${p.account}) — this occurrence only`,
  },
  'msgvault.draft-compose': {
    validate: (p) => {
      const to = Array.isArray(p.to) ? p.to : p.to ? [p.to] : [];
      if (!to.length) fail('Give at least one recipient');
      if (to.length > 20) fail('Too many recipients for one draft');
      for (const a of to)
        if (!/^[^\s@]{1,128}@[^\s@]{1,128}$/.test(String(a))) fail(`Not an address: ${a}`);
      if (!str(p.subject, 500)) fail('Give a subject');
      if (!str(p.body, 20000)) fail('Give a body');
      return { to: to.map(String), subject: p.subject, body: p.body };
    },
    argv: (p) => [
      'draft-compose',
      '--json',
      '--subject',
      p.subject,
      '--body',
      p.body,
      ...p.to.flatMap((a) => ['--to', a]),
    ],
    describe: (p) => `draft a NEW email to ${p.to.join(', ')} — "${p.subject}"`,
  },
  'msgvault.draft-get': {
    validate: (p) =>
      ID.test(String(p.id ?? '')) ? { id: p.id } : fail('Give the draft id to read'),
    argv: (p) => ['draft-get', '--json', '--', p.id],
    describe: (p) => `read draft ${p.id}`,
  },
  'msgvault.draft-edit': {
    validate: (p) => {
      if (!ID.test(String(p.id ?? ''))) fail('Give the draft id to edit');
      if (!str(p.body, 20000)) fail('Give a body');
      return { id: p.id, body: p.body };
    },
    argv: (p) => ['draft-edit', '--json', '--body', p.body, '--', p.id],
    describe: (p) => `replace the body of draft ${p.id}`,
  },
  'msgvault.draft-delete': {
    validate: (p) =>
      ID.test(String(p.id ?? '')) ? { id: p.id } : fail('Give the draft id to delete'),
    argv: (p) => ['draft-delete', '--json', '--', p.id],
    describe: (p) => `delete draft ${p.id}`,
  },
};

/**
 * ── THE ARGV PATH ────────────────────────────────────────────────────────
 *
 * One action instead of a verb per capability: the agent sends the arguments
 * it wants msgvault to run, and {@link reviewArgv} decides whether they may.
 * See msgvault-argv.mjs for the three gates and why only one of them is
 * written by hand.
 *
 * The help text comes from the binary named in the same declaration the
 * runner validates, and is cached per command: a review that shelled out on
 * every keystroke would be a new cost on a path whose whole point is to be
 * cheap to extend.
 */
const helpCache = new Map();
function declaredBinary() {
  try {
    const d = JSON.parse(readFileSync('/Library/muxpad/integrations.json', 'utf8'))?.msgvault;
    return typeof d?.binary === 'string' ? d.binary : null;
  } catch {
    return null;
  }
}
export function msgvaultHelp(command) {
  if (helpCache.has(command)) return helpCache.get(command);
  const binary = declaredBinary();
  let help = null;
  if (binary) {
    try {
      help = execFileSync(binary, [...command.split(' '), '--help'], {
        encoding: 'utf8',
        timeout: 15_000,
        stdio: 'pipe',
        env: {},
      });
    } catch (e) {
      // A command that does not exist exits non-zero with its usage on
      // stderr; that output is still the answer to "what flags has it".
      const out = String(e.stdout || e.stderr || '');
      help = /unknown command|unknown shorthand/i.test(out) ? null : out || null;
    }
  }
  helpCache.set(command, help);
  return help;
}

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
