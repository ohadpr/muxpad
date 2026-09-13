// THE KILL SWITCH, EXERCISED FROM BOTH SIDES.
//
// The negative cases matter more than the positive ones and there are more of
// them on purpose: a missed cancel costs the user one repetition, a false
// cancel costs minutes of agent work. Every string in `refuses` is one somebody
// could plausibly say in a development cockpit while an agent is running.

import { describe, expect, it } from 'vitest';
import { CANCEL_VOCABULARY, arrivalPolicyFor, isExplicitCancel } from './cancel';

describe('cancels', () => {
  const accepts = [
    'stop',
    'Stop.',
    'stop it',
    'stop that',
    'stop the agent',
    'cancel',
    'cancel that',
    'cancel that, please',
    'abort',
    'never mind',
    'nevermind',
    'never mind that',
    'forget it',
    'forget about that',
    'scratch that',
    'abandon that',
    "stop what you're doing",
    // Leading filler is stripped, however much of it there is.
    'ok, stop',
    'okay — no, wait, stop',
    'actually, never mind',
    'hey, cancel that',
    'no no, forget it',
    // Trailing politeness likewise.
    'stop please',
    'cancel that for now',
    'stop, thanks',
  ];
  for (const phrase of accepts) {
    it(`accepts "${phrase}"`, () => {
      expect(isExplicitCancel(phrase)).toBe(true);
      expect(arrivalPolicyFor(phrase)).toBe('interrupt');
    });
  }
});

describe('refuses — every one of these is a TASK or a remark', () => {
  const refuses = [
    // The homonym that makes a naive prefix match dangerous.
    'stop the dev server',
    'stop the docker container',
    'stop the cron from firing',
    'cancel the cron job',
    'cancel my subscription in the billing code',
    'abort the deploy script',
    'forget the cache and rebuild',
    // Corrections and additions: a second task, never a cancellation.
    'actually do the router one instead',
    'never mind that, do the other thing',
    'okay stop and then run the tests instead',
    'no wait, check the router first',
    // Explicit opposites.
    "don't stop",
    'do not stop',
    'keep going',
    "don't cancel it",
    // Progress questions — the whole reason this release exists.
    'how is it going',
    'what is it doing right now',
    'is it done yet',
    'are you still there',
    // Ordinary conversation.
    'that is a good stopping point for today',
    'the tests stop halfway through',
    'i had to cancel the meeting',
    'yeah',
    'hmm',
    '',
    '   ',
  ];
  for (const phrase of refuses) {
    it(`refuses "${phrase}"`, () => {
      expect(isExplicitCancel(phrase)).toBe(false);
      expect(arrivalPolicyFor(phrase)).toBe('enqueue');
    });
  }

  it('refuses anything long, whatever it starts with', () => {
    expect(isExplicitCancel('stop it right there because I have changed my mind')).toBe(false);
  });

  it('refuses a cancel word buried in a sentence', () => {
    expect(isExplicitCancel('when you get a chance, stop')).toBe(false);
  });
});

describe('the vocabulary is small and auditable', () => {
  it('stays small — every entry is a licence to destroy work', () => {
    expect(CANCEL_VOCABULARY.length).toBeLessThan(50);
  });

  it('excludes the words with an ordinary second meaning in this domain', () => {
    // "should I drop the index?" / "drop it." is a plausible exchange, and
    // answering it by killing a turn is the failure mode this guards.
    for (const risky of ['drop it', 'leave it', 'kill it', 'kill that', 'done']) {
      expect(CANCEL_VOCABULARY).not.toContain(risky);
      expect(isExplicitCancel(risky)).toBe(false);
    }
  });
});

describe('the arrival policy is per-arrival, not a global mode', () => {
  it('defaults to enqueue — a second task queues, it does not supersede', () => {
    expect(arrivalPolicyFor('also check the router')).toBe('enqueue');
    expect(arrivalPolicyFor('run the tests')).toBe('enqueue');
  });

  it('does not consult system state — a sentence means the same thing always', () => {
    // No busy flag, no elapsed time, no queue depth. Same input, same answer.
    expect(arrivalPolicyFor('stop')).toBe(arrivalPolicyFor('stop'));
  });
});
