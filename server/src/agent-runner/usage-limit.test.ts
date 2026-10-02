// The classifier's whole job is to be believed, so the tests are mostly about
// what it must NOT believe. This repository's agents write about quotas and
// rate limits constantly; a classifier that fires on prose would mark real
// turns failed and push the user about a subscription that is fine.
import { describe, expect, it } from 'vitest';
import { isUsageLimitText, usageLimitNotice } from './usage-limit.js';

describe('isUsageLimitText — the refusals it must catch', () => {
  it.each([
    'You have reached your usage limit. It resets at 4:00 PM.',
    "You've hit your usage limit for this plan — resets at 9pm.",
    'Usage limit reached · your plan resets in 3 hours',
    'Your quota for this billing period is exhausted. Upgrade or wait until the reset.',
    'Out of credits — add billing or use an API key to continue.',
    'Insufficient quota: your credit balance is too low. Please upgrade your plan.',
    'Rate limit exceeded for your subscription; try again at 18:00.',
    'Exceeded the usage limit on this plan. Resumes after the window resets.',
    // THE ONE THAT MATTERS. The likeliest real wording leads with the product,
    // and an earlier draft of the openings started at the noun and missed it —
    // which would have made this whole module dead on arrival.
    'Claude usage limit reached. Your limit will reset at 3pm (America/Los_Angeles).',
    'Claude usage limit reached · resets at 3pm',
  ])('catches %j', (text) => {
    expect(isUsageLimitText(text)).toBe(true);
  });
});

describe('…and the prose it must not', () => {
  it.each([
    // The exact failure mode auth-heal was bitten by: a short, single-line,
    // confident note, written by an agent debugging this very subsystem.
    'Usage limit — that is the bug.',
    'Quota handling is missing entirely.',
    'You have reached the end of the file.',
    'Your usage of the glossary cache looks right to me.',
    'Rate limiting the push is already handled in ws.ts.',
    // Names the mechanism but does not START like a refusal: it is a sentence
    // ABOUT limits, which is most of what gets written in this repo.
    'The cron recorded ok:true even though the plan quota was spent.',
    // A refusal shape with no refusal content.
    'You have reached step three.',
    // A WARNING is not a refusal: the turn ran. Treating it as a failure would
    // mark a working cron failed every time it got close to the ceiling.
    'Approaching usage limit — 10% of your quota remains.',
    // The vendor prefix must not rescue prose either.
    'Claude usage limit — that is the bug.',
  ])('rejects %j', (text) => {
    expect(isUsageLimitText(text)).toBe(false);
  });

  it('rejects anything multi-line — an explanation is not a refusal', () => {
    expect(
      isUsageLimitText('You have reached your usage limit.\nHere is what that means for muxpad:'),
    ).toBe(false);
  });

  it('rejects anything past the length ceiling', () => {
    const long = `You have reached your usage limit. ${'and it resets later. '.repeat(40)}`;
    expect(long.length).toBeGreaterThan(320);
    expect(isUsageLimitText(long)).toBe(false);
  });

  it('rejects empty and whitespace', () => {
    expect(isUsageLimitText('')).toBe(false);
    expect(isUsageLimitText('   \t ')).toBe(false);
  });

  it('does not let an opening satisfy its own tail', () => {
    // `usage limit` matches an opening AND contains a tail word. If the tail
    // were searched across the whole string rather than after the opening, this
    // bare fragment would classify — which is the bug this file avoids by
    // slicing. A bare restatement names no mechanism and no resolution.
    expect(isUsageLimitText('Usage limit')).toBe(false);
    expect(isUsageLimitText('You have reached')).toBe(false);
  });
});

describe('usageLimitNotice', () => {
  it('names where and what it said — the reset time is the useful part', () => {
    const n = usageLimitNotice('muxpad', 'Usage limit reached · resets at 4:00 PM');
    expect(n).toContain('muxpad');
    expect(n).toContain('4:00 PM');
    expect(n.toLowerCase()).toContain('out of usage');
  });

  it('truncates a long message rather than shipping a wall to a lock screen', () => {
    const n = usageLimitNotice('muxpad', 'x'.repeat(400));
    expect(n.length).toBeLessThan(200);
    expect(n).toContain('…');
  });
});
