import type { AppState } from '@muxpad/shared';
import { describe, expect, it } from 'vitest';
import { AppHealTracker, HEAL_MAX_ATTEMPTS, HEAL_MIN_STRIKES, shouldHealApp } from './AppHeal.js';

/**
 * The self-heal, and the asymmetry it is built around: failing to restart a
 * broken app costs a slower recovery, and restarting the wrong one costs a
 * working server, a fight with the user, or an endless loop. So the tests below
 * are mostly about what it REFUSES to do.
 */
const input = (over: Partial<Parameters<typeof shouldHealApp>[0]> = {}) => ({
  state: 'unreachable' as AppState,
  strikes: HEAL_MIN_STRIKES,
  attempts: 0,
  minStrikes: HEAL_MIN_STRIKES,
  maxAttempts: HEAL_MAX_ATTEMPTS,
  ...over,
});

describe('shouldHealApp', () => {
  it('restarts an app that has been unreachable for long enough', () => {
    expect(shouldHealApp(input())).toBe(true);
  });

  it('will not act on a single blip', () => {
    // One failed probe is a GC pause, a busy box, a proxy reloading.
    expect(shouldHealApp(input({ strikes: 1 }))).toBe(false);
    expect(shouldHealApp(input({ strikes: HEAL_MIN_STRIKES - 1 }))).toBe(false);
  });

  it('NEVER touches an app the user stopped', () => {
    // `stopped` is a person's decision and outranks every observation we make.
    expect(shouldHealApp(input({ state: 'stopped', strikes: 99 }))).toBe(false);
  });

  it('NEVER touches one the supervisor gave up on', () => {
    // It stopped trying on purpose; restarting behind its back re-creates the
    // very loop it escaped.
    expect(shouldHealApp(input({ state: 'gave_up', strikes: 99 }))).toBe(false);
  });

  it('leaves a starting app alone', () => {
    expect(shouldHealApp(input({ state: 'starting', strikes: 99 }))).toBe(false);
  });

  it('leaves a running app alone', () => {
    expect(shouldHealApp(input({ state: 'running', strikes: 99 }))).toBe(false);
  });

  it('stops after the attempt budget — a heal must not become the outage', () => {
    // An app unreachable because its command is broken is unreachable after a
    // restart too. Restarting it every minute forever is the failure mode.
    expect(shouldHealApp(input({ attempts: HEAL_MAX_ATTEMPTS - 1 }))).toBe(true);
    expect(shouldHealApp(input({ attempts: HEAL_MAX_ATTEMPTS }))).toBe(false);
    expect(shouldHealApp(input({ attempts: HEAL_MAX_ATTEMPTS + 5 }))).toBe(false);
  });
});

describe('AppHealTracker', () => {
  it('counts consecutive unreachable sweeps', () => {
    const t = new AppHealTracker();
    expect(t.noteState('a', 'unreachable').strikes).toBe(1);
    expect(t.noteState('a', 'unreachable').strikes).toBe(2);
  });

  it('a single good sweep clears the spell', () => {
    const t = new AppHealTracker();
    t.noteState('a', 'unreachable');
    t.noteState('a', 'unreachable');
    expect(t.noteState('a', 'running').strikes).toBe(0);
  });

  it('spaces attempts apart by resetting the window', () => {
    // Without this the second restart fires on the very next sweep: strikes are
    // already past the threshold, so a 3-attempt budget would be spent in three
    // minutes flat instead of across nine.
    const t = new AppHealTracker();
    for (let i = 0; i < HEAL_MIN_STRIKES; i++) t.noteState('a', 'unreachable');
    t.noteAttempt('a');
    const r = t.noteState('a', 'unreachable');
    expect(r.attempts).toBe(1);
    expect(r.strikes).toBe(1); // must climb back to minStrikes before the next
    expect(shouldHealApp(input({ strikes: r.strikes, attempts: r.attempts }))).toBe(false);
  });

  it('gives a recovered app its full budget back', () => {
    // The budget is per SPELL, not per app forever — otherwise an app that
    // breaks three times over a month is permanently unhealable.
    const t = new AppHealTracker();
    t.noteAttempt('a');
    t.noteAttempt('a');
    t.noteAttempt('a');
    expect(t.noteState('a', 'running').attempts).toBe(0);
    for (let i = 0; i < HEAL_MIN_STRIKES; i++) t.noteState('a', 'unreachable');
    const r = t.noteState('a', 'unreachable');
    expect(shouldHealApp(input({ strikes: r.strikes, attempts: r.attempts }))).toBe(true);
  });

  it('announces giving up exactly once', () => {
    // Said once per spell, or the log becomes the retry loop it is reporting.
    const t = new AppHealTracker();
    expect(t.announceGiveUp('a')).toBe(true);
    expect(t.announceGiveUp('a')).toBe(false);
    t.noteState('a', 'running');
    expect(t.announceGiveUp('a')).toBe(true); // new spell, say it again
  });

  it('forgets an app that is gone', () => {
    const t = new AppHealTracker();
    t.noteState('a', 'unreachable');
    expect(t.known()).toContain('a');
    t.forget('a');
    expect(t.known()).not.toContain('a');
  });

  it('tracks apps independently', () => {
    const t = new AppHealTracker();
    t.noteState('a', 'unreachable');
    t.noteState('a', 'unreachable');
    expect(t.noteState('b', 'unreachable').strikes).toBe(1);
    expect(t.noteState('a', 'unreachable').strikes).toBe(3);
  });
});
