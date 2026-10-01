import { describe, expect, it } from 'vitest';
import { tabUrlIsDead } from './stale-tab-url';

const tabs = (...slugs: string[]) => slugs.map((slug) => ({ slug }));

describe('deciding a tab URL is dead', () => {
  it('bounces a slug the server confirms is gone', () => {
    expect(tabUrlIsDead({ urlTabSlug: 'gone', cached: tabs('a'), confirmed: tabs('a') })).toBe(
      true,
    );
  });

  it('does NOT bounce a tab we already hold', () => {
    expect(tabUrlIsDead({ urlTabSlug: 'a', cached: tabs('a'), confirmed: null })).toBe(false);
  });

  it('does NOT bounce a tab missing from a STALE list but present on the server', () => {
    // The reported bug, in one line. The cached list lags a create; the slug is
    // real. Deciding from the cache alone put the user back on the chat they
    // had just left, every time they made a new one.
    expect(
      tabUrlIsDead({ urlTabSlug: 'new', cached: tabs('a', 'b'), confirmed: tabs('a', 'b', 'new') }),
    ).toBe(false);
  });

  it('does NOT bounce when the server could not be asked', () => {
    // A failed read is not evidence. The old code had no equivalent of this
    // branch at all — it inferred freshness from a count and acted on it.
    expect(tabUrlIsDead({ urlTabSlug: 'maybe', cached: tabs('a'), confirmed: null })).toBe(false);
  });

  it('does nothing when the URL names no tab', () => {
    expect(tabUrlIsDead({ urlTabSlug: null, cached: [], confirmed: [] })).toBe(false);
  });
});
