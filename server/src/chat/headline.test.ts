import { describe, expect, it } from 'vitest';
import {
  HEADLINE_MAX_CHARS,
  HEADLINE_MIN_INTERVAL_MS,
  HEADLINE_MIN_TURNS,
  HEADLINE_TARGET_CHARS,
  buildHeadlinePrompt,
  headlineRejectReason,
  isMaterialChange,
  isPlausibleHeadline,
  parseHeadlineReply,
  shouldConsiderHeadline,
} from './headline.js';

/**
 * The verbatim line that shipped to a real sidebar row (tab "Main"). The model
 * answered the conversation instead of labelling it, the length clamp
 * truncated the answer, and the truncated answer was stored. It is quoted
 * exactly here because paraphrasing it would test a different string than the
 * one that got through.
 */
const THE_BUG =
  'I\'m not familiar with "muxpad" — is that an internal tool, a product name, or did you mea…';

const NOW = 1_800_000_000_000;

describe('shouldConsiderHeadline — the rate limit, before any spend', () => {
  const base = {
    existing: null as string | null,
    lastAt: null as number | null,
    turns: 8,
    now: NOW,
  };

  it('a chat with nothing in it costs nothing', () => {
    expect(shouldConsiderHeadline({ ...base, turns: 0 })).toBe(false);
    expect(shouldConsiderHeadline({ ...base, turns: HEADLINE_MIN_TURNS - 1 })).toBe(false);
  });

  it('tries the FIRST time immediately — no interval to wait out', () => {
    // The rail is least useful exactly when you have the most chats open; a
    // new chat must not wait 20 minutes for its first ATTEMPT. Note what this
    // no longer promises: if that attempt is rejected, the row does sit blank
    // until the interval is up. That is the deliberate price of not letting a
    // chat whose every reply is malformed re-ask on every finished turn.
    expect(shouldConsiderHeadline({ ...base, turns: HEADLINE_MIN_TURNS })).toBe(true);
  });

  it('a chat with NO headline is still rate-limited once it has been asked', () => {
    // The hole that let a persistently-failing chat spin: `existing` used to
    // short-circuit the interval, and a rejected reply leaves it null forever.
    expect(shouldConsiderHeadline({ ...base, existing: null, lastAt: NOW - 60_000 })).toBe(false);
    expect(
      shouldConsiderHeadline({
        ...base,
        existing: null,
        lastAt: NOW - HEADLINE_MIN_INTERVAL_MS,
      }),
    ).toBe(true);
  });

  it('a QUIET chat with a line already costs nothing', () => {
    expect(
      shouldConsiderHeadline({
        ...base,
        existing: 'wiring the cron scheduler into boot',
        lastAt: NOW - 60_000,
      }),
    ).toBe(false);
  });

  it('a BUSY chat costs at most one call per interval', () => {
    const withLine = { ...base, existing: 'wiring the cron scheduler into boot' };
    // Simulate 200 finished turns inside one interval — the thing that would
    // make this feature expensive if the gate were per-turn.
    let calls = 0;
    for (let i = 0; i < 200; i++) {
      const now = NOW + i * 5_000;
      if (shouldConsiderHeadline({ ...withLine, lastAt: NOW, now })) calls += 1;
    }
    // 200 turns × 5s = ~16 minutes, still inside the 20-minute floor.
    expect(calls).toBe(0);
  });

  it('re-asks once the interval has elapsed', () => {
    const withLine = { ...base, existing: 'a line', lastAt: NOW };
    expect(shouldConsiderHeadline({ ...withLine, now: NOW + HEADLINE_MIN_INTERVAL_MS - 1 })).toBe(
      false,
    );
    expect(shouldConsiderHeadline({ ...withLine, now: NOW + HEADLINE_MIN_INTERVAL_MS })).toBe(true);
  });

  it('a headline with no clock is re-asked rather than frozen forever', () => {
    // Defends the migration: rows that predate headline_at must not be stuck.
    expect(shouldConsiderHeadline({ ...base, existing: 'a line', lastAt: null })).toBe(true);
  });
});

describe('parseHeadlineReply — every ambiguity resolves to KEEP', () => {
  const existing = 'wiring the cron scheduler into boot';

  it('accepts a clean new line', () => {
    expect(parseHeadlineReply('mid-drive vs hub motors', existing)).toBe('mid-drive vs hub motors');
  });

  it('honours the KEEP sentinel', () => {
    expect(parseHeadlineReply('KEEP', existing)).toBeNull();
    expect(parseHeadlineReply('  keep  ', existing)).toBeNull();
  });

  it('honours a HEDGED keep — the model explaining itself is still a keep', () => {
    expect(parseHeadlineReply('KEEP — still about the cron scheduler', existing)).toBeNull();
  });

  it('refuses to churn on a pure REWORDING', () => {
    // The commonest drift: the model agrees nothing changed, then helpfully
    // rewrites the line with different punctuation and capitalisation.
    expect(parseHeadlineReply('Wiring the cron scheduler into boot.', existing)).toBeNull();
    expect(parseHeadlineReply('  wiring the cron scheduler into boot  ', existing)).toBeNull();
  });

  it('unwraps the shapes a cheap model actually returns', () => {
    expect(parseHeadlineReply('```\nmid-drive vs hub motors\n```', existing)).toBe(
      'mid-drive vs hub motors',
    );
    expect(parseHeadlineReply('"mid-drive vs hub motors"', existing)).toBe(
      'mid-drive vs hub motors',
    );
    expect(parseHeadlineReply('Headline: mid-drive vs hub motors', existing)).toBe(
      'mid-drive vs hub motors',
    );
  });

  it('takes only the first line when the model explains itself', () => {
    expect(parseHeadlineReply('mid-drive vs hub motors\n\nI chose this because…', existing)).toBe(
      'mid-drive vs hub motors',
    );
  });

  it('treats empty and whitespace as a keep, never as a blank headline', () => {
    expect(parseHeadlineReply('', existing)).toBeNull();
    expect(parseHeadlineReply('   \n  ', existing)).toBeNull();
    expect(parseHeadlineReply('```\n```', existing)).toBeNull();
  });

  it('REJECTS a model that ignored the length ask instead of truncating it', () => {
    // This is the behaviour change the bug forced. Truncating an over-long
    // reply is how an answer-to-the-conversation became a headline: the reply
    // was wrong, and its first 90 characters were wrong too.
    expect(parseHeadlineReply('a'.repeat(300), null)).toBeNull();
    expect(headlineRejectReason('a'.repeat(300))).toBe(`over ${HEADLINE_MAX_CHARS} chars`);
  });

  it('strips trailing sentence punctuation rather than rejecting on it', () => {
    // A trailing full stop is a style miss, not a wrong answer.
    expect(parseHeadlineReply('mid-drive vs hub motors.', null)).toBe('mid-drive vs hub motors');
    expect(parseHeadlineReply('mid-drive vs hub motors!', null)).toBe('mid-drive vs hub motors');
  });

  it('does not strip a trailing ellipsis into a plausible line', () => {
    // "…" is the fingerprint of prose cut short; eating it would smuggle the
    // remains past the shape check.
    expect(parseHeadlineReply('the plan is to first look at the...', null)).toBeNull();
    expect(parseHeadlineReply('the plan is to first look at the…', null)).toBeNull();
  });

  it('drops a leading list bullet', () => {
    expect(parseHeadlineReply('- mid-drive vs hub motors', null)).toBe('mid-drive vs hub motors');
  });

  it('refuses a reply that is a question put to the reader', () => {
    expect(parseHeadlineReply('Is that an internal tool?', null)).toBeNull();
  });

  it('writes the first line for a row that has none', () => {
    expect(parseHeadlineReply('mid-drive vs hub motors', null)).toBe('mid-drive vs hub motors');
  });
});

describe('isMaterialChange', () => {
  it('anything beats nothing', () => {
    expect(isMaterialChange(null, 'x')).toBe(true);
  });

  it('ignores case and punctuation', () => {
    expect(isMaterialChange('cohort B at 2.1x reply rate', 'Cohort B at 2.1x reply rate.')).toBe(
      false,
    );
  });

  it('a real topic shift is material', () => {
    expect(isMaterialChange('cohort B at 2.1x reply rate', 'picking a CDP vendor')).toBe(true);
  });
});

/**
 * ─── The shape check ──────────────────────────────────────────────────────
 *
 * Two tables, and the second one matters more than the first. Rejecting bad
 * output is easy; the way this feature actually breaks a second time is by
 * getting so suspicious that it throws away lines that were fine, leaving the
 * rail blank and the reader with nothing.
 */
describe('headline shape check — the good lines must survive', () => {
  const good = [
    // Both of these are LIVE headlines from the user's own sidebar. They are
    // what "working correctly" looks like, and no future rule may reject them.
    'agent-files migration deployment and verification',
    'Bambu Lab printer slicing and settings for test plate',
    // A label ABOUT a question is a perfectly good label. This is the exact
    // distinction the check has to hold: a phrase that names a decision, vs a
    // phrase that asks the reader something.
    'whether to sell the SMH position',
    'sell the SMH overweight or hold?',
    'mid-drive vs hub motors',
    'wiring the cron scheduler into boot',
    'cohort B at 2.1x reply rate',
    'picking a CDP vendor',
    // Hyphens and slashes must not read as word ends: "no-", "my-", "keep-"
    // and "I/" are not the words "no", "my", "keep" and "I".
    'no-code vendor comparison',
    'my-app deploy script rewrite',
    'keep-alive tuning for the launchd socket',
    'Keep-Alive vs Connection: close',
    'disk I/O latency on the NAS',
    'async I/O in the ptyd bridge',
    'ME/CFS treatment literature',
    'ptyd socket ownership after a restart',
    'Tailscale Funnel for the publish port',
    // A comparison is the commonest label shape there is, and it must not
    // hinge on whether the model typed "vs" or "vs.".
    'mid-drive vs. hub motors',
    'Postgres vs. SQLite for the archive',
    'PETG vs. PLA warping on the bed',
    'heat pump vs. gas furnace running costs',
    'CPI vs. PCE as the Fed target',
    // Abbreviations and initials are not sentence boundaries either.
    'U.S. Treasury yields vs TIPS',
    'St. Louis Fed CPI series',
    'Alphabet Inc. earnings call',
    'Ph.D. thesis latex build',
    'Rev. B board bring-up',
    // A standalone capital I is usually a numeral or an initial.
    'Phase I rollout of the new router',
    'Type I vs Type II errors in the A/B test',
    'Series I savings bonds',
    // Version numbers and package names contain dots; that is not a sentence
    // boundary.
    'Node.js 22 upgrade for the runner',
    // "the user"/"the chat"/"the transcript" are ordinary subjects here — two
    // of these three are things in this codebase.
    'the user table migration',
    'the transcript reader rewrite',
    'the chat sidebar redesign',
    'the assistant pane restart loop',
    'the thread pool sizing',
    // Proper nouns that collide with a greeting or a pronoun.
    'great room lighting plan',
    'Hello World bootloader for the RP2040',
    'HERE Maps API for the trip planner',
    'Sure Cuts A Lot for the vinyl cutter',
    'your.org DNS migration',
    'i.e. the replication crisis',
    // Deliberation labels in the first person plural are still labels.
    'should we drop the resident pane',
    'do we need a server-side queue',
    // The worked example's own subject. This user has coffee chats, and the
    // echo check must not delete a correct line about one.
    'sour espresso and grind adjustment',
    // Unfamiliar vocabulary is not a defect — most of this user's headlines
    // are made of words a general model has never seen.
    'nimbus worktree cleanup',
  ];

  for (const line of good) {
    it(`keeps: ${line}`, () => {
      expect(headlineRejectReason(line)).toBeNull();
    });
  }
});

describe('headline shape check — the bad output must not reach the row', () => {
  // Each row names the rule it is here to exercise, and the rule is ASSERTED.
  // A table that only checked "rejected somehow" would quietly stop testing
  // what its own labels claim the moment an earlier rule started catching the
  // fixture first.
  const bad: Array<[string, string, string]> = [
    // THE bug, verbatim.
    ['the live bug, verbatim', THE_BUG, 'conversational opener'],
    // The same failure caught earlier, before the clamp got to it.
    [
      'answering instead of labelling',
      'I\'m not familiar with "muxpad" — is that an internal tool or a product name?',
      'conversational opener',
    ],
    ['a first-person opener', "I can't summarize this conversation", 'conversational opener'],
    ['first person mid-phrase', 'the cron scheduler as I understand it', 'first person'],
    ['an assistant preamble', "Sure! Here's a headline for this chat", 'conversational opener'],
    ['a bare preamble', "Here's a summary of the chat", 'conversational opener'],
    [
      'a hedging opener',
      'It looks like the user is debugging a cron schedule',
      'conversational opener',
    ],
    ['a hedging opener, variant', 'It seems this is about e-bike motors', 'conversational opener'],
    ['an apology', 'Sorry, I do not have enough context', 'conversational opener'],
    ['an offer of further help', 'Let me know if you need anything else', 'conversational opener'],
    [
      'describing the chat',
      'The conversation is about cron scheduling',
      'describes the conversation',
    ],
    [
      'describing the people in it',
      'The user is researching e-bikes',
      'describes the conversation',
    ],
    ['a meta statement', 'The topic is cron scheduling', 'describes the conversation'],
    ['a question put to the reader', 'What would you like this labelled as?', 'is a question'],
    [
      'addressing the reader mid-phrase',
      'cron scheduling, or did you mean something else',
      'addresses the reader',
    ],
    ['two sentences', 'Cron scheduling. The user wants a catch-up pass', 'more than one sentence'],
    ['trailing off', 'cron scheduling and whether the catch-up pass should…', 'trails off'],
    ['a field prefix', 'Headline: cron scheduling', 'field prefix'],
    ['over the ceiling', 'a'.repeat(HEADLINE_MAX_CHARS + 1), `over ${HEADLINE_MAX_CHARS} chars`],
    ['a newline', 'cron scheduling\nand also e-bikes', 'multiple lines'],
    ['empty', '', 'empty'],
    ['whitespace only', '   \t  ', 'empty'],
    ['the sentinel', 'KEEP', 'sentinel'],
    // The prompt read back at us. A cheap model handed a rule list sometimes
    // answers with one of the rules.
    ['echoing a rule', 'Name the SUBJECT of the conversation', 'echoes the prompt'],
    [
      'echoing a rule, verbatim',
      'Lowercase unless it starts with a proper noun',
      'echoes the prompt',
    ],
    // Models type the typographic apostrophe far more often than the ASCII
    // one — the live bug string's em dash says it came out of exactly that
    // register — so every contraction rule has to see through it.
    [
      'the bug, with a typographic apostrophe',
      'I’m not familiar with muxpad — is that an internal tool?',
      'conversational opener',
    ],
    [
      'a curly contraction preamble',
      'Here’s the label: cron scheduler wiring',
      'conversational opener',
    ],
    ['a curly first person', 'I’ll summarise the cron work for you', 'conversational opener'],
    // Refusals that contain no contraction and no pronoun at all — the class
    // that slips past a check built only from "I'm"-shaped examples.
    ['a hedged description', 'This appears to be about cron scheduling', 'conversational opener'],
    [
      'a hedged description, variant',
      'This is a conversation about cron scheduling',
      'conversational opener',
    ],
    ['a refusal', 'Not enough context to label this', 'conversational opener'],
    ['a refusal, variant', 'Unable to determine the subject', 'conversational opener'],
    ['a refusal, third variant', 'Could not determine a label', 'conversational opener'],
    ['an acknowledgement', 'Got it, the cron scheduler wiring', 'conversational opener'],
    ['an acknowledgement, dashed', 'Understood — cron scheduler wiring', 'conversational opener'],
    // Questions that do not open with an interrogative but are still
    // questions: enough clause structure to have stopped being a phrase.
    ['a trailing question clause', 'muxpad — what is it?', 'is a question'],
    [
      'a list of alternatives',
      'an internal tool, a product name, or something else?',
      'is a question',
    ],
  ];

  for (const [label, line, reason] of bad) {
    it(`rejects ${label}`, () => {
      expect(headlineRejectReason(line)).toBe(reason);
      expect(isPlausibleHeadline(line)).toBe(false);
    });
  }

  it('never stores the bug string, whatever route it arrives by', () => {
    // Through the parser, with and without a line already on the row.
    expect(parseHeadlineReply(THE_BUG, null)).toBeNull();
    expect(parseHeadlineReply(THE_BUG, 'wiring the cron scheduler into boot')).toBeNull();
    expect(parseHeadlineReply(`\`\`\`\n${THE_BUG}\n\`\`\``, null)).toBeNull();
    expect(parseHeadlineReply(`"${THE_BUG}"`, null)).toBeNull();
  });
});

describe('buildHeadlinePrompt', () => {
  const convo = 'user: hi\nassistant: hello';

  it('leads with KEEP when a line already exists', () => {
    const p = buildHeadlinePrompt(convo, 'an existing line');
    expect(p).toContain('an existing line');
    expect(p).toContain('KEEP');
    // The KEEP instruction must come BEFORE the transcript, so the cheapest
    // path through the prompt is the one that changes nothing.
    expect(p.indexOf('KEEP')).toBeLessThan(p.lastIndexOf('<transcript>'));
  });

  it('asks plainly for a first line when there is none', () => {
    const p = buildHeadlinePrompt('user: hi', null);
    expect(p).toContain('no label yet');
    expect(p).not.toContain('output KEEP');
  });

  it('states the length budget', () => {
    expect(buildHeadlinePrompt('x', null)).toContain(String(HEADLINE_TARGET_CHARS));
  });

  it('fences the transcript and says it is not addressed to the model', () => {
    // The root cause of the bug: the model read a user turn asking about
    // "muxpad" as a question put to IT, and answered.
    const p = buildHeadlinePrompt(convo, null);
    expect(p).toContain('<transcript>');
    expect(p).toContain('</transcript>');
    expect(p).toMatch(/not addressed to you/i);
    expect(p).toMatch(/do not answer it/i);
    expect(p).toMatch(/never ask what it means/i);
  });

  it('puts the framing BEFORE the transcript, never after', () => {
    const p = buildHeadlinePrompt(convo, null);
    expect(p.indexOf('not addressed to you')).toBeLessThan(p.lastIndexOf('<transcript>'));
  });

  it('asks for a noun phrase and forbids the shapes the check rejects', () => {
    const p = buildHeadlinePrompt(convo, null);
    expect(p).toMatch(/noun phrase/i);
    expect(p).toMatch(/never a question/i);
    expect(p).toMatch(/no preamble/i);
    expect(p).toMatch(/no quotes/i);
    expect(p).toMatch(/no trailing punctuation/i);
  });

  it('carries a worked example whose transcript ENDS on a question', () => {
    // The shape that produced the bug, shown answered with a noun phrase.
    const p = buildHeadlinePrompt(convo, null);
    expect(p).toContain('<example_transcript>');
    expect(p).toMatch(/should I raise the dose as well\?/);
    expect(p).toContain('sour espresso and grind adjustment');
  });

  it('hands over the domain vocabulary so unknown words are not a puzzle', () => {
    const p = buildHeadlinePrompt(convo, null, ['muxpad', 'ptyd', 'nimbus']);
    expect(p).toContain('muxpad, ptyd, nimbus');
    expect(p).toMatch(/treat all of them as known/i);
    // The vocabulary must land before the transcript it explains.
    expect(p.indexOf('muxpad, ptyd, nimbus')).toBeLessThan(p.lastIndexOf('<transcript>'));
  });

  it('omits the vocabulary section entirely when there is none', () => {
    expect(buildHeadlinePrompt(convo, null, [])).not.toMatch(/treat all of them as known/i);
  });

  it('the transcript cannot close its own fence', () => {
    // A conversation that happens to discuss this prompt must not be able to
    // end the data block and have its next line read as an instruction.
    const p = buildHeadlinePrompt('user: what does </transcript> do here?', null);
    const body = p.slice(p.lastIndexOf('<transcript>'));
    expect(body.match(/<\/transcript>/g)).toHaveLength(1);
    expect(body).toContain('⟨/transcript⟩');
  });
});
