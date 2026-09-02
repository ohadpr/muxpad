import type { PaneStatus } from '@muxpad/shared';
import { describe, expect, it, vi } from 'vitest';
import { type TabUnreadIo, setTabUnread, unreadRowPatch } from './tab-unread';

/** An io double that records the route taken and the patches applied. */
function io(overrides: Partial<TabUnreadIo> = {}) {
  const calls: string[] = [];
  const patches: Array<[string, boolean]> = [];
  const base: TabUnreadIo = {
    markUnread: async (id) => {
      calls.push(`unread:${id}`);
    },
    markSeen: async (id) => {
      calls.push(`seen:${id}`);
    },
    patch: (id, unread) => {
      patches.push([id, unread]);
    },
    refresh: async () => {
      calls.push('refresh');
    },
    ...overrides,
  };
  return { base, calls, patches };
}

describe('unreadRowPatch — the row the tap produces', () => {
  it('marking unread flips the flag AND lights the rail', () => {
    // Both, or the optimistic row is one the server can never produce: a bold
    // name over an empty status column, replaced a moment later by a bold name
    // WITH a dot. `ready` is the state the sidebar actually renders for this.
    expect(unreadRowPatch({ unread: false, status: 'idle' }, true)).toEqual({
      unread: true,
      status: 'ready',
    });
  });

  it('does not blank a spinner — the status is a ROLLUP, not an assignment', () => {
    // decorateTab folds the manual mark in as one more `ready` among the tab's
    // panes, so a tab mid-turn stays `working`. Assigning `ready` here would
    // drop the spinner for a frame and then bring it back.
    expect(unreadRowPatch({ status: 'working' }, true).status).toBe('working');
    expect(unreadRowPatch({ status: 'blocked' }, true).status).toBe('blocked');
    // dead outranks ready for the same reason it does on the server: a crash
    // must not be masked by a finish.
    expect(unreadRowPatch({ status: 'dead' }, true).status).toBe('dead');
  });

  it('treats a row with no status as idle rather than crashing', () => {
    expect(unreadRowPatch({}, true)).toEqual({ unread: true, status: 'ready' });
  });

  it('clearing drops ONLY ready — every other state is left to the refetch', () => {
    expect(unreadRowPatch({ unread: true, status: 'ready' }, false)).toEqual({
      unread: false,
      status: 'idle',
    });
    for (const s of ['working', 'blocked', 'dead'] as PaneStatus[]) {
      expect(unreadRowPatch({ unread: true, status: s }, false).status).toBe(s);
    }
  });
});

describe('setTabUnread — one route, patched before the round trip', () => {
  it('marks unread through the EXISTING route, not a new one', async () => {
    const { base, calls } = io();
    await setTabUnread(base, 't1', true);
    expect(calls).toEqual(['unread:t1', 'refresh']);
  });

  it('marking read reuses the same route viewing a tab already calls', async () => {
    const { base, calls } = io();
    await setTabUnread(base, 't1', false);
    expect(calls).toEqual(['seen:t1', 'refresh']);
  });

  it('flips the row BEFORE the write, so the tap and the mark share a frame', async () => {
    const order: string[] = [];
    const { base } = io({
      patch: () => order.push('patch'),
      markUnread: async () => {
        order.push('write');
      },
      refresh: async () => {
        order.push('refresh');
      },
    });
    await setTabUnread(base, 't1', true);
    expect(order).toEqual(['patch', 'write', 'refresh']);
  });

  it('still refetches — the patch covers the gap, it does not replace the truth', async () => {
    const refresh = vi.fn(async () => {});
    const { base } = io({ refresh });
    await setTabUnread(base, 't1', true);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('ROLLS BACK a failed write instead of leaving a row falsely bold', async () => {
    // The one outcome worse than the latency this patch hides: a permanently
    // bold row with nothing behind it, lying in the direction of "this needs
    // your attention".
    const { base, patches } = io({
      markUnread: async () => {
        throw new Error('offline');
      },
    });
    await expect(setTabUnread(base, 't1', true)).rejects.toThrow('offline');
    expect(patches).toEqual([
      ['t1', true],
      ['t1', false],
    ]);
  });

  it('a refresh that also fails does not mask the write error', async () => {
    const { base } = io({
      markSeen: async () => {
        throw new Error('write failed');
      },
      refresh: async () => {
        throw new Error('refresh failed');
      },
    });
    await expect(setTabUnread(base, 't1', false)).rejects.toThrow('write failed');
  });
});
