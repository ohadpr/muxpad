import { describe, expect, it } from 'vitest';
import { callerPane } from './caller-pane.js';

/**
 * A PROCESS CANNOT CHOOSE ITS PARENT, WHICH IS THE WHOLE POINT.
 *
 * The guard this replaces took the pane id from $MUXPAD_PANE_ID and so could
 * be told anything. These tests are mostly about the REFUSALS: every way of
 * not knowing who is calling has to end in null, because a capability check
 * that does not know who is asking has nothing to check.
 */
const tree = (edges: Record<number, number>) => async (pid: number) => edges[pid] ?? null;

const PANES = [
  { id: 'pane-trayo', pid: 100 },
  { id: 'pane-personal', pid: 200 },
];

describe('callerPane', () => {
  it('finds the pane a few hops up', async () => {
    // shell 100 → agent 101 → tool 102 → the muxpad script 103
    const got = await callerPane(103, {
      panePids: async () => PANES,
      parentOf: tree({ 103: 102, 102: 101, 101: 100, 100: 1 }),
    });
    expect(got).toBe('pane-trayo');
  });

  it('answers for the pane shell itself', async () => {
    expect(await callerPane(200, { panePids: async () => PANES, parentOf: tree({}) })).toBe(
      'pane-personal',
    );
  });

  it('stops at the FIRST pane in the chain', async () => {
    // A pane whose shell was somehow started under another pane must be
    // attributed to itself, not to its host — otherwise a chat opened from a
    // work chat would inherit the work chat's capabilities.
    const got = await callerPane(201, {
      panePids: async () => PANES,
      parentOf: tree({ 201: 200, 200: 100, 100: 1 }),
    });
    expect(got).toBe('pane-personal');
  });

  it('refuses a chain that reaches init without passing a pane', async () => {
    const got = await callerPane(900, {
      panePids: async () => PANES,
      parentOf: tree({ 900: 901, 901: 1 }),
    });
    expect(got).toBeNull();
  });

  it('refuses when ptyd reports no panes — an older daemon has no such RPC', async () => {
    // `panePids` answers [] on an `unknown method`. That is "cannot identify
    // callers", and it must fail closed rather than fall back to trusting a
    // claim.
    expect(
      await callerPane(103, { panePids: async () => [], parentOf: tree({ 103: 100 }) }),
    ).toBeNull();
  });

  it('refuses pid 1 and nonsense', async () => {
    for (const pid of [0, 1, -5, Number.NaN, 1.5]) {
      expect(await callerPane(pid, { panePids: async () => PANES, parentOf: tree({}) })).toBeNull();
    }
  });

  it('gives up rather than looping on a cycle', async () => {
    const got = await callerPane(500, {
      panePids: async () => PANES,
      parentOf: tree({ 500: 501, 501: 500 }),
    });
    expect(got).toBeNull();
  });

  it('gives up past a sane depth', async () => {
    const deep: Record<number, number> = {};
    for (let i = 1000; i < 1100; i++) deep[i] = i + 1;
    deep[1100] = 100; // a pane, but far further up than any real tool chain
    expect(
      await callerPane(1000, { panePids: async () => PANES, parentOf: tree(deep) }),
    ).toBeNull();
  });
});

/**
 * THE REAL PROCESS TABLE, once, so the walk is not only ever exercised against
 * a hand-built map. The parent of this test process is a real pid; claiming it
 * as a pane must resolve to that pane.
 */
describe('against the real process table', () => {
  it('walks up to a pane that is genuinely an ancestor', async () => {
    const self = process.pid;
    const parent = process.ppid;
    const got = await callerPane(self, { panePids: async () => [{ id: 'p', pid: parent }] });
    expect(got).toBe('p');
  });

  it('does not attribute us to a pane we are not under', async () => {
    const got = await callerPane(process.pid, {
      panePids: async () => [{ id: 'p', pid: 999_999 }],
    });
    expect(got).toBeNull();
  });
});
