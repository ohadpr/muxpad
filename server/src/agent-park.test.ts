import { describe, expect, it } from 'vitest';
import {
  PARK_AFTER_MS,
  PARK_RETIRED_AFTER_MS,
  type ParkInput,
  shouldParkPane,
} from './agent-park.js';

/**
 * Parking a chat's process. The asymmetry is the whole design: parking one that
 * was busy destroys work in flight, while failing to park one costs some memory
 * until the next sweep. So the tests are mostly about what it REFUSES to do.
 */
const input = (over: Partial<ParkInput> = {}): ParkInput => ({
  status: 'idle',
  watched: false,
  queued: 0,
  openRounds: 0,
  isSubChat: false,
  retired: false,
  blocked: false,
  parked: false,
  idleMs: PARK_AFTER_MS + 1,
  idleThresholdMs: PARK_AFTER_MS,
  retiredThresholdMs: PARK_RETIRED_AFTER_MS,
  ...over,
});

describe('shouldParkPane', () => {
  it('parks a chat nobody has touched in days', () => {
    expect(shouldParkPane(input())).toBe(true);
  });

  it('leaves a chat somebody is LOOKING at', () => {
    // Closing a browser must not be the only thing between a reader and their
    // chat going away under them.
    expect(shouldParkPane(input({ watched: true }))).toBe(false);
  });

  it('leaves one that is working', () => {
    expect(shouldParkPane(input({ status: 'running' }))).toBe(false);
  });

  it('leaves one whose status it does not recognise', () => {
    // A newer runner reporting something unknown is not evidence of idleness.
    expect(shouldParkPane(input({ status: 'thinking' }))).toBe(false);
    expect(shouldParkPane(input({ status: null }))).toBe(false);
    expect(shouldParkPane(input({ status: undefined }))).toBe(false);
  });

  it('leaves one BLOCKED on a question', () => {
    // The answer is coming to a process that has to be there to receive it.
    expect(shouldParkPane(input({ blocked: true }))).toBe(false);
  });

  it('leaves one with queued work', () => {
    // Queued work is the condition `listAgentPanes` uses to START a pane;
    // parking here would fight the next sweep.
    expect(shouldParkPane(input({ queued: 1 }))).toBe(false);
  });

  it('leaves one mid-job', () => {
    // A worker between turns of ONE job has an open round.
    expect(shouldParkPane(input({ openRounds: 1 }))).toBe(false);
  });

  it('never parks a LIVE sub-chat', () => {
    // It is supposed to be running without proving it each time — that is what
    // spawning one means, and its parent is waiting.
    expect(shouldParkPane(input({ isSubChat: true }))).toBe(false);
  });

  it('leaves one that has never been active', () => {
    expect(shouldParkPane(input({ idleMs: null }))).toBe(false);
  });

  it('leaves one idle for less than the threshold', () => {
    expect(shouldParkPane(input({ idleMs: PARK_AFTER_MS - 1 }))).toBe(false);
    expect(shouldParkPane(input({ idleMs: 0 }))).toBe(false);
  });

  it('does not park what is already parked', () => {
    expect(shouldParkPane(input({ parked: true }))).toBe(false);
  });

  it('waits long enough to be past a session you are still in', () => {
    expect(PARK_AFTER_MS).toBeGreaterThanOrEqual(86_400_000);
  });

  it('one blocker is enough, whatever else is true', () => {
    // Belt and braces: the guards are independent, and a chat that is idle for
    // a month but mid-job stays up.
    expect(shouldParkPane(input({ idleMs: 365 * 86_400_000, openRounds: 1 }))).toBe(false);
    expect(shouldParkPane(input({ idleMs: 365 * 86_400_000, watched: true }))).toBe(false);
  });
});

describe('a chat that has already finished', () => {
  const retired = (over: Partial<ParkInput> = {}) =>
    ({ ...base, retired: true, ...over }) as ParkInput;
  const base: ParkInput = {
    status: 'idle',
    watched: false,
    queued: 0,
    openRounds: 0,
    isSubChat: false,
    retired: true,
    blocked: false,
    parked: false,
    idleMs: PARK_RETIRED_AFTER_MS + 1,
    idleThresholdMs: PARK_AFTER_MS,
    retiredThresholdMs: PARK_RETIRED_AFTER_MS,
  };

  it('parks on the SHORT fuse — it has left the live list', () => {
    // 84 of 123 runners on the measured machine were retired tabs: finished
    // chats nothing would ever auto-start again, holding a process each.
    expect(shouldParkPane(retired())).toBe(true);
    // …and a LIVE chat at the same age is left alone.
    expect(shouldParkPane(retired({ retired: false }))).toBe(false);
  });

  it('still waits out the hour, so nothing is killed mid-settle', () => {
    // A worker that delivered seconds ago has a spawn report being written and
    // a parent's card to update.
    expect(shouldParkPane(retired({ idleMs: PARK_RETIRED_AFTER_MS - 1 }))).toBe(false);
  });

  it('DOES park a finished sub-chat — the big one', () => {
    // A delivered worker is finished, and `listAgentPanes` will never
    // auto-start it again. Excluding every sub-chat made that rule the thing
    // holding most of the memory: 139 of 206 agent panes, nearly all finished.
    expect(shouldParkPane(retired({ isSubChat: true }))).toBe(true);
    // …while a LIVE one is still untouchable, parent waiting.
    expect(shouldParkPane(retired({ isSubChat: true, retired: false }))).toBe(false);
  });

  it('obeys every other guard exactly as a live chat does', () => {
    expect(shouldParkPane(retired({ watched: true }))).toBe(false);
    expect(shouldParkPane(retired({ openRounds: 1 }))).toBe(false);
    expect(shouldParkPane(retired({ status: 'running' }))).toBe(false);
    expect(shouldParkPane(retired({ blocked: true }))).toBe(false);
  });
});
