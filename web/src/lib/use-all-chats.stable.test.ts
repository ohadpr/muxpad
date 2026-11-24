import { describe, expect, it } from 'vitest';
import { stableGroupsForTest as stableGroups } from './use-all-chats';

/**
 * THE CORPUS MEMO HAD NOTHING STABLE TO HOLD.
 *
 * `useAllChats` built a fresh array every render and `useChatCorpus` memoises
 * on it, so the memo never hit: `toSearchableTabs` re-ran over every chat on
 * the install for every consumer, on every render. Found by the performance
 * review.
 *
 * The obvious fix — `useMemo([workspaces, corpus])` — is WRONG, and that is
 * what these pin. The `cachedTabsFor` fallback is read non-reactively for
 * workspaces the corpus does not hold, so keying on the corpus would freeze
 * precisely the rows with no other way to update. Identity comparison keeps
 * them fresh: a changed cache is a changed array.
 */
const ws = (id: string) => ({ id }) as never;
const tabs = (...names: string[]) => names.map((n) => ({ id: n })) as never;

describe('stableGroups', () => {
  it('hands back the SAME array when nothing moved', () => {
    const ref = { current: null } as { current: never };
    const w = ws('w1');
    const t = tabs('a', 'b');
    const first = stableGroups(ref, [{ workspace: w, tabs: t }]);
    const second = stableGroups(ref, [{ workspace: w, tabs: t }]);
    expect(second).toBe(first);
  });

  it('hands back a NEW array when a tabs array is replaced', () => {
    // This is the fallback case: a workspace poll landed and swapped the
    // cached array. Nothing else changed, and it still has to be seen.
    const ref = { current: null } as { current: never };
    const w = ws('w1');
    const first = stableGroups(ref, [{ workspace: w, tabs: tabs('a') }]);
    const second = stableGroups(ref, [{ workspace: w, tabs: tabs('a', 'b') }]);
    expect(second).not.toBe(first);
    expect(second[0]?.tabs).toHaveLength(2);
  });

  it('hands back a NEW array when a workspace object is replaced', () => {
    // A rename republishes the workspace; the rows carry its name.
    const ref = { current: null } as { current: never };
    const t = tabs('a');
    const first = stableGroups(ref, [{ workspace: ws('w1'), tabs: t }]);
    const second = stableGroups(ref, [{ workspace: ws('w1'), tabs: t }]);
    expect(second).not.toBe(first);
  });

  it('notices a workspace appearing or disappearing', () => {
    const ref = { current: null } as { current: never };
    const w1 = ws('w1');
    const t = tabs('a');
    const first = stableGroups(ref, [{ workspace: w1, tabs: t }]);
    const second = stableGroups(ref, [
      { workspace: w1, tabs: t },
      { workspace: ws('w2'), tabs: tabs('c') },
    ]);
    expect(second).not.toBe(first);
    expect(stableGroups(ref, [{ workspace: w1, tabs: t }])).not.toBe(second);
  });

  it('holds the new array for the NEXT comparison, not the old one', () => {
    // A cache that never advances would return the first array forever.
    const ref = { current: null } as { current: never };
    const w = ws('w1');
    stableGroups(ref, [{ workspace: w, tabs: tabs('a') }]);
    const t2 = tabs('b');
    const second = stableGroups(ref, [{ workspace: w, tabs: t2 }]);
    expect(stableGroups(ref, [{ workspace: w, tabs: t2 }])).toBe(second);
  });
});
