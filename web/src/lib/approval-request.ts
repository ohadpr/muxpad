/**
 * WHAT AN APPROVAL IS ACTUALLY ABOUT.
 *
 * The dialog used to lead with "muxpad wants to access your archive" over a
 * duration picker, and put the only thing you were really deciding — the
 * query, the message text — in the smallest type in the box, behind a
 * disclosure triangle. The capability got named three times on the way there
 * (brand line, headline, action label) and the verb twice.
 *
 * So the card is inverted: the mark says which system and which of your data,
 * the headline is the verb with its object, and the argument you are
 * approving is the largest thing on screen. This module is the part of that
 * with no React in it.
 */

/** A source of YOUR data, not a product. The mark exists to answer "what does
 *  this read", which is a question about mail/calendar/contacts, not about
 *  which vendor stores them. */
export type SourceMark = 'slack' | 'gmail' | 'calendar' | 'contacts';

/**
 * THE MARK COMES FROM THE VERB, NEVER FROM THE PAYLOAD.
 *
 * It is tempting to show a calendar when the query says "standup" — and that
 * mark would then be wrong whenever somebody emails about a standup. A mark
 * that lies about what is being read is worse than no mark at all, so this is
 * a fixed table keyed on the action and nothing else.
 *
 * An unlisted verb gets NO mark rather than a guessed one.
 */
const MARKS: Record<string, readonly SourceMark[]> = {
  'msgvault.search': ['gmail'],
  'msgvault.show-message': ['gmail'],
  'msgvault.show-thread': ['gmail'],
  // The only verb that genuinely spans the archive — and the only one allowed
  // to light three marks. It reads counts, which is why the card says so.
  'msgvault.stats': ['gmail', 'calendar', 'contacts'],
  // A draft lands in mail, like the reads — the mark says WHICH of your data
  // is involved, not whether the verb reads or writes. The heading and the
  // qualifier carry that, and the duration menu's absence proves it.
  'msgvault.draft-reply': ['gmail'],
};

export const marksFor = (action: string): readonly SourceMark[] =>
  MARKS[action] ?? (action.startsWith('slack.') ? ['slack'] : []);

export type Described = {
  /** The verb with its object. This is the dialog's heading. */
  title: string;
  /** One quiet line under it: the limits of what was asked for. */
  qualifier?: string | undefined;
  /** The single payload field the decision actually turns on, shown large. */
  primary?: { key: string; value: string } | undefined;
  /** Everything else that will be sent. Shown — never hidden behind a
   *  disclosure, because a security prompt that conceals part of the request
   *  is asking you to approve something you were not shown. */
  rest: Array<[string, string]>;
};

/**
 * CHARACTERS THAT MAKE A DIALOG LIE.
 *
 * This dialog's whole premise is that you approve what you see. A bidi
 * override (U+202E and friends) reorders the glyphs around it without
 * changing a byte of what gets sent, so a Slack message or a draft reply can
 * READ as one thing here and ARRIVE as another — Trojan Source, pointed at a
 * consent dialog instead of at a code review. Zero-width and C0 control
 * characters are the same trick with a simpler mechanism: text that is
 * present, approved, and invisible.
 *
 * They are made VISIBLE rather than refused. Refusing would be wrong for
 * ordinary text — Hebrew and Arabic carry LRM/RLM legitimately, and a person
 * writing in them should not have their drafts rejected by an approval
 * dialog. An escape says exactly what is there and costs a reader nothing
 * when the text is honest.
 *
 * `\t`, `\n` and `\r` are deliberately NOT in here: they are what a message
 * body is made of, and the payload box renders them as the whitespace they
 * are.
 */
const DECEPTIVE =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: that is the point
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

export const visible = (raw: string): string =>
  raw.replace(
    DECEPTIVE,
    (c) => `\\u${(c.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`,
  );

const text = (value: unknown): string =>
  visible(typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value));

/** Slack channel names get a `#`; ids (C123, D123…) and anything already
 *  prefixed are left exactly as they are, so the card never invents a name. */
const channel = (value: unknown): string => {
  const raw = text(value);
  if (!raw) return 'Slack';
  return /^[a-z0-9][a-z0-9._-]*$/.test(raw) ? `#${raw}` : raw;
};

const count = (value: unknown): string | undefined => {
  const n = typeof value === 'number' ? value : Number(text(value));
  return Number.isFinite(n) && n > 0 ? String(n) : undefined;
};

type Rule = {
  title: (p: Record<string, unknown>) => string;
  qualifier?: (p: Record<string, unknown>) => string | undefined;
  /** Which payload key is the thing being decided on. */
  primary?: string;
};

const RULES: Record<string, Rule> = {
  'slack.post': {
    title: (p) => `Post to ${channel(p.channel)}`,
    qualifier: (p) =>
      // Not a detail: the message goes out under HIS name, and the only thing
      // marking it as an agent's is a prefix the broker adds.
      p.thread_ts ? 'reply in thread · as you, prefixed 🤖' : 'as you, prefixed 🤖',
    primary: 'text',
  },
  'slack.edit': {
    title: (p) => `Edit your message in ${channel(p.channel)}`,
    qualifier: () => 'replaces what is there now',
    primary: 'text',
  },
  'slack.unpost': {
    title: (p) => `Delete a message in ${channel(p.channel)}`,
    qualifier: () => 'cannot be undone',
    primary: 'ts',
  },
  'slack.read': {
    title: (p) => `Read ${channel(p.channel)}`,
    qualifier: (p) => {
      const n = count(p.limit);
      return n ? `read-only · last ${n} messages` : 'read-only';
    },
  },
  'slack.thread': {
    title: (p) => `Read a thread in ${channel(p.channel)}`,
    qualifier: () => 'read-only',
    primary: 'ts',
  },
  'slack.search': {
    title: () => 'Search Slack',
    qualifier: (p) => {
      const n = count(p.count ?? p.limit);
      return n ? `read-only · up to ${n} results` : 'read-only';
    },
    primary: 'query',
  },
  'slack.channels': { title: () => 'List Slack channels', qualifier: () => 'read-only' },
  'slack.users': { title: () => 'Look up a Slack user', qualifier: () => 'read-only' },
  'slack.dm': {
    title: (p) => `Open a direct message with ${text(p.user) || 'a user'}`,
    qualifier: () => 'opens a conversation; sends nothing',
  },
  'slack.react': {
    title: (p) => `React in ${channel(p.channel)}`,
    qualifier: () => 'as you',
    primary: 'name',
  },
  'slack.upload': {
    title: (p) => `Upload a file to ${channel(p.channel)}`,
    qualifier: () => 'as you, prefixed 🤖',
    primary: 'filename',
  },
  'msgvault.search': {
    title: () => 'Search your mail',
    qualifier: (p) => {
      const n = count(p.limit);
      return n ? `read-only · up to ${n} results` : 'read-only';
    },
    primary: 'query',
  },
  'msgvault.show-message': {
    title: () => 'Read one email',
    qualifier: () => 'read-only · one message',
    primary: 'id',
  },
  'msgvault.show-thread': {
    title: () => 'Read an email thread',
    qualifier: () => 'read-only · one thread',
    primary: 'id',
  },
  /**
   * THE ONE WRITE. The body is the primary field — it is the thing going into
   * the mailbox, and a dialog that showed the recipient but not the text
   * would be asking for consent to something it had not shown.
   *
   * There is no compose entry because there is no compose verb: a Gmail
   * source refuses `draft-compose`, so the dialog for it could only ever
   * precede a failure.
   */
  'msgvault.draft-reply': {
    title: (p) => (p.all ? 'Draft a reply to everyone on the thread' : 'Draft a reply'),
    qualifier: () => 'saved as a draft — it cannot be sent',
    primary: 'body',
  },
  'msgvault.stats': {
    title: () => 'Count your mail, calendar and contacts',
    // Three lit marks say "this touches everything you have", and without
    // this line that reads worse than the truth: it is counts, not content.
    qualifier: () => 'counts only — no message content',
  },
};

/** The verb for an action with no rule — "slack.pin" → "Slack · pin". Said
 *  plainly rather than dressed up, because an unknown verb is exactly when
 *  the card must not sound more confident than it is. */
const fallbackTitle = (action: string): string => {
  const [system, ...verb] = action.split('.');
  const rest = verb.join('.');
  if (!rest) return action;
  return `${system === 'msgvault' ? 'Your archive' : system === 'slack' ? 'Slack' : system} · ${rest}`;
};

export function describeRequest(action: string, payload: Record<string, unknown>): Described {
  const rule = RULES[action];
  const entries = Object.entries(payload ?? {});
  const primaryKey = rule?.primary;
  const primaryEntry = primaryKey ? entries.find(([k]) => k === primaryKey) : undefined;
  return {
    title: rule ? rule.title(payload ?? {}) : fallbackTitle(action),
    qualifier: rule?.qualifier?.(payload ?? {}) || undefined,
    primary:
      primaryEntry && text(primaryEntry[1])
        ? { key: primaryEntry[0], value: text(primaryEntry[1]) }
        : undefined,
    rest: entries
      .filter(([k, v]) => k !== primaryEntry?.[0] && text(v) !== '')
      .map(([k, v]) => [k, text(v)] as [string, string]),
  };
}
