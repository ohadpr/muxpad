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
    'forget that',
    'forget about that',
    'scratch that',
    'abandon that',
    "stop what you're doing",
    // Leading filler is stripped, however much of it there is.
    'ok, stop',
    'okay — no, wait, stop',
    'actually, never mind',
    'hey, cancel that',
    'no no, forget that',
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

  it('applies that same test back to itself — the dismissals of a REMARK are out', () => {
    // "ugh, forget it" and "never mind that" dismiss something just SAID at
    // least as often as they abandon work. Both had a near-identical survivor
    // in the set, so removing them costs a repetition, not a capability.
    for (const risky of ['forget it', 'never mind that']) {
      expect(CANCEL_VOCABULARY).not.toContain(risky);
      expect(isExplicitCancel(risky)).toBe(false);
    }
    // …and the survivors that make that trade cheap are still there.
    expect(isExplicitCancel('never mind')).toBe(true);
    expect(isExplicitCancel('forget that')).toBe(true);
  });
});

describe('a cancel in another language is a CANCEL, not a new agent task', () => {
  // The set was English-only, so these fell through to `enqueue` and were sent
  // to Claude AS WORK: the user asking for the work to stop got another turn
  // of it. Recognising them is strictly better than the no-op that was the
  // floor for this fix, and the whole-utterance closed-set rule is what keeps
  // it as safe as the English half.
  const foreign = ['עצור', 'תעצור', 'תפסיק', 'די', 'מספיק', 'בטל', 'para', 'basta', 'cancela'];
  for (const phrase of foreign) {
    it(`cancels on "${phrase}" and does not dispatch it`, () => {
      expect(isExplicitCancel(phrase)).toBe(true);
      expect(arrivalPolicyFor(phrase)).toBe('interrupt');
    });
  }

  it('still refuses a foreign cancel word with an object — that is a task', () => {
    // Exactly the "stop the dev server" rule, in Hebrew and Spanish.
    expect(isExplicitCancel('עצור את השרת')).toBe(false);
    expect(isExplicitCancel('para el servidor de desarrollo')).toBe(false);
  });

  it('excludes the "drop it" class in every language too', () => {
    for (const risky of ['עזוב', 'עזוב את זה', 'dejalo', 'déjalo', 'olvidalo']) {
      expect(isExplicitCancel(risky)).toBe(false);
    }
  });

  it('normalises non-Latin text instead of deleting it', () => {
    // The old normaliser stripped everything outside [a-z0-9], so a Hebrew
    // sentence became the empty string. Punctuation and accents still go.
    expect(isExplicitCancel('עצור!')).toBe(true);
    expect(isExplicitCancel('deténte')).toBe(true);
    // A real Hebrew REQUEST must still be a request.
    expect(arrivalPolicyFor('תריץ את הטסטים בבקשה')).toBe('enqueue');
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

// ═══ POLITENESS IS NOT A LANGUAGE FEATURE OF ENGLISH ═══
//
// The filler lists are what make the whole-utterance rule usable: "okay, no,
// wait — stop" reduces to "stop", and "stop, please" reduces to "stop". Both
// lists were English-only, so the non-English half of the closed set matched
// ONLY the bare, unadorned imperative.
//
// That is not a rare shape. Attaching a politeness particle to an imperative
// is the NORM in Spanish and Hebrew — "para, por favor", "עצור בבקשה" — and a
// hesitation before one is universal. So the failure was not "a foreign cancel
// is ignored". It was the exact outcome the non-English set was added to
// prevent, restated in this file's own header: the request to stop fell
// through to `enqueue` and was dispatched to Claude AS A NEW AGENT TURN.
//
// The previous suite tested only the bare forms — i.e. precisely the subset
// that worked — so the header's claim that the non-English entries are "held
// to exactly the same standard" was unpinned and untrue.
describe('a foreign cancel survives the politeness that normally surrounds it', () => {
  const spanish = [
    'para, por favor',
    'para por favor',
    'basta ya',
    'para ya',
    'vale, para',
    'oye, cancela',
    'bueno, basta',
    'cancela, gracias',
    'espera, detente',
    'no, para',
  ];
  for (const phrase of spanish) {
    it(`Spanish: "${phrase}" cancels`, () => {
      expect(isExplicitCancel(phrase)).toBe(true);
      expect(arrivalPolicyFor(phrase)).toBe('interrupt');
    });
  }

  const hebrew = [
    'עצור בבקשה',
    'תפסיק בבקשה',
    'רגע, עצור',
    'אוקיי תפסיק',
    'בסדר, עצור',
    'לא, תעצור',
    'תעצור עכשיו',
    'בטל, תודה',
  ];
  for (const phrase of hebrew) {
    it(`Hebrew: "${phrase}" cancels`, () => {
      expect(isExplicitCancel(phrase)).toBe(true);
      expect(arrivalPolicyFor(phrase)).toBe('interrupt');
    });
  }

  // The filler must not become a back door. Stripping it may only ever expose
  // a phrase that was already in the closed set — never turn a TASK into a
  // cancel, which is the one direction that costs the user work.
  it('stripping filler still leaves an object as an object', () => {
    for (const task of [
      'por favor para el servidor',
      'oye, cancela el cron',
      'בבקשה עצור את השרת',
      'רגע, תבטל את המשימה של אתמול',
      'vale, basta de tests por favor',
    ]) {
      expect(isExplicitCancel(task)).toBe(false);
      expect(arrivalPolicyFor(task)).toBe('enqueue');
    }
  });

  it('and the "drop it" class stays out, however politely it is said', () => {
    for (const risky of ['dejalo por favor', 'olvidalo ya', 'בבקשה עזוב את זה']) {
      expect(isExplicitCancel(risky)).toBe(false);
    }
  });
});
