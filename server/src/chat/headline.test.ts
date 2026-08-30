import { describe, expect, it } from 'vitest';
import {
  HEADLINE_MAX_CHARS,
  HEADLINE_MIN_INTERVAL_MS,
  HEADLINE_MIN_TURNS,
  buildHeadlinePrompt,
  isMaterialChange,
  parseHeadlineReply,
  shouldConsiderHeadline,
} from './headline.js';

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

  it('writes the FIRST line immediately — no interval to wait out', () => {
    // The rail is least useful exactly when you have the most chats open; a
    // new chat must not sit blank for 20 minutes.
    expect(shouldConsiderHeadline({ ...base, turns: HEADLINE_MIN_TURNS })).toBe(true);
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

  it('hard-clamps a model that ignored the length ask', () => {
    const long = 'a'.repeat(300);
    const out = parseHeadlineReply(long, null);
    expect(out).not.toBeNull();
    expect((out as string).length).toBeLessThanOrEqual(HEADLINE_MAX_CHARS);
    expect(out).toMatch(/…$/);
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

describe('buildHeadlinePrompt', () => {
  it('leads with KEEP when a line already exists', () => {
    const p = buildHeadlinePrompt('user: hi\nassistant: hello', 'an existing line');
    expect(p).toContain('an existing line');
    expect(p).toContain('KEEP');
    // The KEEP instruction must come BEFORE the conversation, so the cheapest
    // path through the prompt is the one that changes nothing.
    expect(p.indexOf('KEEP')).toBeLessThan(p.indexOf('Conversation:'));
  });

  it('asks plainly for a first line when there is none', () => {
    const p = buildHeadlinePrompt('user: hi', null);
    expect(p).toContain('no line yet');
    expect(p).not.toContain('reply with exactly KEEP');
  });

  it('states the length budget it will later enforce', () => {
    expect(buildHeadlinePrompt('x', null)).toContain(String(HEADLINE_MAX_CHARS));
  });
});
