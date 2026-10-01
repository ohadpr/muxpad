// The local echo behind a directed card. Tested because the two things it must
// never do are silent: lose the card that says where your sentence went, and
// keep a spinner running after the answer has already arrived.
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type DirectedWork,
  addDirected,
  loadDirected,
  removeDirected,
  syncReported,
} from './chat-directed';

const PANE = 'pane-1';
/** Cards are pruned against the REAL clock on every append, so the fixtures
 *  have to live in the present — a card stamped at t=1000 is eight weeks stale
 *  by construction and was the first thing these tests caught. */
const NOW = Date.now();

function work(over: Partial<DirectedWork> & { id: string }): DirectedWork {
  return {
    at: NOW,
    tabId: 't-inv',
    tabSlug: 'inv',
    workspaceSlug: 'personal',
    body: "what's the cash position?",
    chip: { name: 'Investing' },
    ...over,
  };
}

beforeEach(() => {
  localStorage.clear();
});

describe('loadDirected', () => {
  it('is empty for a pane that has never directed anything', () => {
    expect(loadDirected(PANE)).toEqual([]);
  });

  it('survives junk in storage rather than throwing at the renderer', () => {
    localStorage.setItem('muxpad.directed.pane-1', 'not json');
    expect(loadDirected(PANE)).toEqual([]);
    localStorage.setItem('muxpad.directed.pane-1', '{"not":"an array"}');
    expect(loadDirected(PANE)).toEqual([]);
    localStorage.setItem(
      'muxpad.directed.pane-1',
      `[{"nope":1},{"id":"a","at":${NOW},"tabId":"t"}]`,
    );
    expect(loadDirected(PANE).map((d) => d.id)).toEqual(['a']);
  });

  it('drops cards older than a week', () => {
    addDirected(PANE, work({ id: 'week-old', at: NOW - 6 * 86_400_000 }));
    addDirected(PANE, work({ id: 'fresh', at: NOW }));
    expect(loadDirected(PANE, NOW + 2 * 86_400_000).map((d) => d.id)).toEqual(['fresh']);
  });

  it('keeps the newest cards when a chat is used as a dispatcher', () => {
    for (let i = 0; i < 20; i++) addDirected(PANE, work({ id: `d${i}`, at: NOW + i }));
    const ids = loadDirected(PANE).map((d) => d.id);
    expect(ids).toHaveLength(12);
    expect(ids.at(-1)).toBe('d19');
  });

  it('keeps panes apart', () => {
    addDirected(PANE, work({ id: 'a' }));
    expect(loadDirected('pane-2')).toEqual([]);
  });
});

describe('syncReported', () => {
  it('stamps the cards whose reports are in the transcript', () => {
    addDirected(PANE, work({ id: 'a' }));
    addDirected(PANE, work({ id: 'b' }));
    const next = syncReported(PANE, new Set(['a']), NOW + 5_000);
    expect(next.map((d) => [d.id, d.reportedAt ?? null])).toEqual([
      ['a', NOW + 5_000],
      ['b', null],
    ]);
    // Persisted, because the transcript is re-read on every mount and the
    // stamp must not depend on having been watching when it landed.
    expect(loadDirected(PANE)[0]?.reportedAt).toBe(NOW + 5_000);
  });

  it('does not re-stamp — the first answer is when it came back', () => {
    addDirected(PANE, work({ id: 'a' }));
    syncReported(PANE, new Set(['a']), NOW + 5_000);
    syncReported(PANE, new Set(['a']), NOW + 9_000);
    expect(loadDirected(PANE)[0]?.reportedAt).toBe(NOW + 5_000);
  });

  it('returns the SAME list when nothing changed, so a render can skip', () => {
    addDirected(PANE, work({ id: 'a' }));
    const before = loadDirected(PANE);
    expect(syncReported(PANE, new Set<string>())).toEqual(before);
  });
});

describe('removeDirected', () => {
  it('takes back a card whose request never left', () => {
    addDirected(PANE, work({ id: 'a' }));
    addDirected(PANE, work({ id: 'b' }));
    expect(removeDirected(PANE, 'a').map((d) => d.id)).toEqual(['b']);
    expect(loadDirected(PANE).map((d) => d.id)).toEqual(['b']);
  });
});
