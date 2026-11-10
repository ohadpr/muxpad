import type { MuxpadEvent, Tab } from '@muxpad/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Every live subscriber, so a test can push an event into the store. */
const handlers = new Set<(e: MuxpadEvent) => void>();
vi.mock('./events', () => ({
  subscribe: (h: (e: MuxpadEvent) => void) => {
    handlers.add(h);
    return () => handlers.delete(h);
  },
  subscribeResync: () => () => {},
}));

const slots: Array<{
  at: number;
  tab: Tab;
  workspace: { id: string; slug: string; name: string };
}> = [];
vi.mock('./api', () => ({ req: async () => ({ slots }) }));

const { refreshWorkingSet, cachedWorkingSet } = await import('./working-set');

const tab = (over: Partial<Tab> = {}): Tab =>
  ({
    id: 't1',
    name: 'Alona Demos',
    slug: 'alona',
    workspace_id: 'w1',
    status: 'working',
    ...over,
  }) as Tab;

const push = (t: Tab) => {
  for (const h of handlers) h({ type: 'tab.updated', tab: t } as unknown as MuxpadEvent);
};

/**
 * A SLOT IS A SNAPSHOT, AND IT HAS TO KEEP UP.
 *
 * The server announces only SHAPE changes — a chat entering or leaving the
 * band — so the `Tab` inside a slot froze at whatever it was when the set last
 * moved. A chat that was working when it entered kept a spinner in Recently
 * Active for hours after it finished, beside its own sidebar row reading idle.
 */
describe('the recently-active strip keeps up with a chat that finished', () => {
  beforeEach(async () => {
    slots.length = 0;
    slots.push({ at: 1, tab: tab(), workspace: { id: 'w1', slug: 'w', name: 'W' } });
    await refreshWorkingSet();
  });

  it('drops the busy mark when the chat goes idle', () => {
    expect(cachedWorkingSet()[0]?.tab.status).toBe('working');
    push(tab({ status: 'idle' }));
    expect(cachedWorkingSet()[0]?.tab.status).toBe('idle');
  });

  it('carries the rest of the row too — name, unread, agent count', () => {
    push(tab({ status: 'idle', name: 'Renamed', unread: true, agents: 3 }));
    const row = cachedWorkingSet()[0];
    expect(row?.tab.name).toBe('Renamed');
    expect(row?.tab.unread).toBe(true);
    expect(row?.tab.agents).toBe(3);
  });

  it('never lets a push reorder or extend the band — the SET is the server’s', () => {
    // `at` is the strip's own ordering key and belongs to the set, not to the
    // tab; taking it from an event would let a message reorder the band.
    const before = cachedWorkingSet()[0]?.at;
    push(tab({ status: 'idle' }));
    expect(cachedWorkingSet()[0]?.at).toBe(before);
    expect(cachedWorkingSet()).toHaveLength(1);
    // A tab that is not in the band is ignored entirely.
    push(tab({ id: 'other', status: 'working' }));
    expect(cachedWorkingSet()).toHaveLength(1);
    expect(cachedWorkingSet()[0]?.tab.id).toBe('t1');
  });

  it('does not republish when nothing visible changed', () => {
    // Six rows re-rendering on an event that changed a headline is the churn
    // this band exists to avoid.
    const seen: unknown[] = [];
    for (const h of handlers) void h;
    const before = cachedWorkingSet();
    push(tab({ status: 'working' })); // identical to what is held
    expect(cachedWorkingSet(), 'republished an identical row').toBe(before);
    expect(seen).toHaveLength(0);
  });
});
