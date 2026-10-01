import { describe, expect, it } from 'vitest';
import { answersFor, describeAnswer, matchOption, normalizeAnswer } from './question';

/** The real labels the reversibility gate ships (server/src/agent-runner/
 *  reversibility.ts) — curly apostrophe and all. */
const GATE_YES = 'Do it';
const GATE_NO = 'Don’t';
const GATE = [{ label: GATE_YES }, { label: GATE_NO }];

const pending = {
  qid: 'gate-1',
  questions: [
    {
      question: 'This publishes commits to the remote. Go ahead?',
      header: 'Push',
      multiSelect: false,
      options: [{ label: GATE_YES }, { label: GATE_NO }],
    },
  ],
};

describe('normalizeAnswer', () => {
  it('folds the curly apostrophe a transcript will never produce', () => {
    expect(normalizeAnswer('Don’t')).toBe(normalizeAnswer("Don't"));
  });
});

describe('matchOption — the affirmative', () => {
  it('matches the label said plainly', () => {
    expect(matchOption('Do it', GATE)).toBe(GATE_YES);
  });

  it('strips agreement and politeness around it', () => {
    expect(matchOption('Yes, do it.', GATE)).toBe(GATE_YES);
    expect(matchOption('Okay — do it, please', GATE)).toBe(GATE_YES);
    expect(matchOption('  Sure, do it!  ', GATE)).toBe(GATE_YES);
    // The phrasing a person actually uses out loud, which is what the spoken
    // prompt ("say one of those words exactly") steers them towards.
    expect(matchOption('Yes, do it, please.', GATE)).toBe(GATE_YES);
  });

  it('matches the negative label through the apostrophe mismatch', () => {
    expect(matchOption("Don't", GATE)).toBe(GATE_NO);
    expect(matchOption('don’t.', GATE)).toBe(GATE_NO);
  });
});

describe('matchOption — REFUSING TO GUESS, which is the point', () => {
  // The bug this whole module exists to not have: `Don't do it` CONTAINS
  // `Do it`, so any substring rule approves a push the user just refused.
  it('never reads a negated sentence as the affirmative', () => {
    expect(matchOption("Don't do it", GATE)).toBeNull();
    expect(matchOption('do not do it', GATE)).toBeNull();
    expect(matchOption('No, do it', GATE)).toBeNull();
    expect(matchOption('never do it', GATE)).toBeNull();
  });

  it('does not approve a loose yes that merely sounds like one', () => {
    expect(matchOption('Yes, go ahead and push it', GATE)).toBeNull();
    expect(matchOption('yeah sounds good', GATE)).toBeNull();
  });

  it('does not match a label buried in a longer instruction', () => {
    expect(matchOption('do it but only after the tests pass', GATE)).toBeNull();
  });

  it('returns null for an empty or filler-only utterance', () => {
    expect(matchOption('', GATE)).toBeNull();
    expect(matchOption('um, okay...', GATE)).toBeNull();
  });
});

describe('answersFor', () => {
  it('sends the EXACT label when one was named — the gate compares literally', () => {
    expect(answersFor('yes, do it', pending)).toEqual([
      { question: pending.questions[0]?.question, answers: [GATE_YES] },
    ]);
  });

  it('forwards the raw words when nothing matched, which the gate reads as a denial with a reason', () => {
    expect(answersFor('not to main — use a branch', pending)).toEqual([
      { question: pending.questions[0]?.question, answers: ['not to main — use a branch'] },
    ]);
  });

  it('answers every open question when several are asked at once', () => {
    const two = {
      qid: 'q',
      questions: [
        { question: 'A?', header: 'a', multiSelect: false, options: [{ label: 'One' }] },
        { question: 'B?', header: 'b', multiSelect: false, options: [{ label: 'Two' }] },
      ],
    };
    expect(answersFor('one', two)).toEqual([
      { question: 'A?', answers: ['One'] },
      { question: 'B?', answers: ['one'] },
    ]);
  });
});

describe('describeAnswer', () => {
  it('names the option when one was matched', () => {
    expect(describeAnswer('do it', pending)).toBe('Answered: Do it.');
  });

  it('reads back the words when they were passed through', () => {
    expect(describeAnswer('use a branch instead', pending)).toBe(
      'Passed that back as your answer: use a branch instead',
    );
  });
});
