// The auth self-heal CLASSIFIER and LADDER, on their own.
//
// The backend drives both through a real session (auth-recovery.test.ts); these
// pin the two decisions that file cannot exercise exhaustively without either
// waiting out 85 seconds of real back-off or writing prose at a live model:
// exactly which strings count as a dead credential, and exactly when the
// re-execs stop.

import { describe, expect, it } from 'vitest';
import {
  AUTH_HEAL_DELAYS_MS,
  AUTH_HEAL_REARM_MS,
  AuthHealPolicy,
  authGiveUpNotice,
  isAuthFailureText,
} from './auth-heal.js';

describe('isAuthFailureText — what counts as a dead credential', () => {
  // Verbatim from the pane logs of the 2026-09-20 incident. If either of these
  // stops matching, every pane goes back to dying silently at the next token
  // expiry, so they are pinned as literals rather than paraphrased.
  it.each([
    'Failed to authenticate: OAuth session expired and could not be refreshed',
    'Not logged in · Please run /login',
    'Invalid API key · Please run /login',
  ])('recognises %j', (text) => {
    expect(isAuthFailureText(text)).toBe(true);
  });

  it('recognises them with the surrounding whitespace the loop trims', () => {
    expect(isAuthFailureText('  Not logged in · Please run /login\n')).toBe(true);
  });

  // THE FALSE POSITIVE THAT MATTERS. This repository's agents write about auth
  // failures — this very feature was specified in a document quoting both
  // strings — and an agent that re-execs its own session every time it
  // discusses one is a worse bug than the one being fixed.
  it.each([
    [
      'prose quoting it',
      'The pane logged "Not logged in · Please run /login" and then stayed dead until someone respawned it by hand.',
    ],
    [
      'a multi-line report opening with it',
      'Not logged in · Please run /login\n\nThat is what every pane printed this morning.',
    ],
    ['a command', 'Run /login to fix it'],
    ['an unrelated sentence', 'Done — the login page now renders.'],
    ['empty', '   '],
  ])('does NOT fire on %s', (_name, text) => {
    expect(isAuthFailureText(text)).toBe(false);
  });

  it('does not fire on a long single line that merely starts with the phrase', () => {
    const long = `Not logged in, apparently — ${'x'.repeat(250)}`;
    expect(isAuthFailureText(long)).toBe(false);
  });
});

describe('AuthHealPolicy — the ladder, the cap, and the way back', () => {
  /** A policy on a clock the test owns outright. */
  function make(delaysMs: readonly number[] = [0, 10, 20], rearmMs = 1000) {
    let now = 0;
    const policy = new AuthHealPolicy({ delaysMs, rearmMs, now: () => now });
    return {
      policy,
      at: (t: number) => {
        now = t;
      },
    };
  }

  it('heals immediately on the first failure — that is the whole feature', () => {
    const { policy } = make();
    expect(policy.decide()).toEqual({ kind: 'heal', delayMs: 0, attempt: 1, of: 3 });
  });

  it('walks the ladder in order and then gives up', () => {
    const { policy } = make();
    expect(policy.decide()).toMatchObject({ kind: 'heal', delayMs: 0, attempt: 1 });
    expect(policy.decide()).toMatchObject({ kind: 'heal', delayMs: 10, attempt: 2 });
    expect(policy.decide()).toMatchObject({ kind: 'heal', delayMs: 20, attempt: 3 });
    expect(policy.decide()).toEqual({ kind: 'give-up', of: 3 });
    expect(policy.gaveUp).toBe(true);
  });

  it('stays quiet after giving up — one notification per burst, not one per turn', () => {
    const { policy, at } = make();
    policy.decide();
    policy.decide();
    policy.decide();
    expect(policy.decide().kind).toBe('give-up');
    at(1);
    expect(policy.decide()).toEqual({ kind: 'quiet', rearmInMs: 999 });
    at(500);
    expect(policy.decide()).toEqual({ kind: 'quiet', rearmInMs: 500 });
  });

  it('re-arms once the window passes — a /login an hour later still heals', () => {
    const { policy, at } = make();
    for (let i = 0; i < 3; i++) policy.decide();
    expect(policy.decide().kind).toBe('give-up');
    at(1000);
    expect(policy.decide()).toEqual({ kind: 'heal', delayMs: 0, attempt: 1, of: 3 });
    expect(policy.gaveUp).toBe(false);
  });

  // The probation rail from respawn-policy.ts: the counter is forgiven by
  // EVIDENCE of recovery, never by time between failures. Forgiving it on
  // anything weaker re-arms the ladder every cycle and the cap never bites.
  it('only a turn that actually worked resets the ladder', () => {
    const { policy } = make();
    policy.decide();
    policy.decide();
    policy.ok();
    expect(policy.decide()).toMatchObject({ attempt: 1, delayMs: 0 });
  });

  it('ok() also clears a give-up outright', () => {
    const { policy } = make();
    for (let i = 0; i < 4; i++) policy.decide();
    expect(policy.gaveUp).toBe(true);
    policy.ok();
    expect(policy.gaveUp).toBe(false);
    expect(policy.decide()).toMatchObject({ kind: 'heal', attempt: 1 });
  });

  it('an empty ladder falls back to the default rather than giving up at once', () => {
    const policy = new AuthHealPolicy({ delaysMs: [] });
    expect(policy.ladder).toBe(AUTH_HEAL_DELAYS_MS.length);
    expect(policy.decide()).toMatchObject({ kind: 'heal', delayMs: AUTH_HEAL_DELAYS_MS[0] });
  });

  it('the shipped ladder starts instant and ends patient', () => {
    expect(AUTH_HEAL_DELAYS_MS[0]).toBe(0);
    expect(AUTH_HEAL_DELAYS_MS.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < AUTH_HEAL_DELAYS_MS.length; i++) {
      expect(AUTH_HEAL_DELAYS_MS[i] as number).toBeGreaterThan(
        AUTH_HEAL_DELAYS_MS[i - 1] as number,
      );
    }
    // Bounded: a machine that was never logged in makes at most one burst of
    // re-execs (and one notification) per re-arm window.
    expect(AUTH_HEAL_REARM_MS).toBeGreaterThan(AUTH_HEAL_DELAYS_MS.reduce((a, b) => a + b, 0) * 2);
  });
});

describe('authGiveUpNotice — the lock screen sentence', () => {
  it('names the action that fixes it, not just the error', () => {
    const notice = authGiveUpNotice('muxpad', 'Not logged in · Please run /login');
    expect(notice).toContain('muxpad');
    expect(notice).toContain('/login');
    // It must also say the pane comes back on its own, or the user's next move
    // is a round of hand-respawning — which is what this whole change removes.
    expect(notice).toMatch(/retries on its own/);
  });
});
