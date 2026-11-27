import type { ChatEvent } from '@muxpad/shared';
import { describe, expect, it } from 'vitest';
import type { Task } from './TaskStore.js';
import { CONTINUATION_LIMIT } from './task-continue.js';
import {
  YIELD_SPEAKER,
  asksTheOwner,
  hardStop,
  parseVerdict,
  renderYieldProd,
  yieldPair,
  yieldPrompt,
} from './yield-gate.js';

/**
 * THE ANTI-YIELD GATE.
 *
 * "The main chat is too fragile — all it takes is the harness deciding it's
 * done and bam, work is halted until I approve or answer a stupid question."
 *
 * The machinery to continue a chat already existed and was gated behind an
 * opt-in nobody took: six tasks declared across 2,434 chats, eighteen
 * continuations across ~27,500 turns. These tests are about the replacement
 * being SAFE in the one direction that matters — it may make the cockpit less
 * likely to stop, and must never be able to trap work inside a chat.
 */
const task = (over: Partial<Task> = {}): Task =>
  ({
    id: 't1',
    tab_id: 'tab1',
    state: 'open',
    request: 'ship it',
    continuations: 0,
    continued_from: null,
    updated_at: 1000,
    created_at: 1,
    ...over,
  }) as Task;

const ctx = (over: Partial<Parameters<typeof hardStop>[0]> = {}) => ({
  queued: 0,
  blocked: false,
  stopped: false,
  turnFailed: false,
  task: null,
  spawned: false,
  ...over,
});

describe('the handovers no judgement may overrule', () => {
  it('lets a chat that is WAITING ON THE OWNER through, every way it can wait', () => {
    // Each of these means the chat is waiting for something only a person can
    // supply — a passkey approval, an answer to a question it asked, a human
    // who pressed Stop. Prodding there is muxpad talking over its own request.
    expect(hardStop(ctx({ blocked: true }))).toMatch(/question it asked/);
    expect(hardStop(ctx({ stopped: true }))).toMatch(/stopped/);
    expect(hardStop(ctx({ turnFailed: true }))).toMatch(/failure/);
    expect(hardStop(ctx({ queued: 1 }))).toMatch(/already queued/);
  });

  it('leaves sub-chats alone — their reader is the parent, not the owner', () => {
    expect(hardStop(ctx({ spawned: true }))).toMatch(/sub-chat/);
  });

  it('stops when the budget is spent', () => {
    expect(hardStop(ctx({ task: task({ continuations: CONTINUATION_LIMIT }) }))).toMatch(/budget/);
    expect(hardStop(ctx({ task: task({ continuations: CONTINUATION_LIMIT - 1 }) }))).toBe(null);
  });

  it('stops a chat going round the same loop, on the SECOND lap', () => {
    // A prod is earned by progress: `continued_from` is the `updated_at` the
    // last one was spent against. Unchanged means nothing moved.
    expect(hardStop(ctx({ task: task({ continued_from: 1000, updated_at: 1000 }) }))).toMatch(
      /nothing moved/,
    );
    // …and movement earns the next one.
    expect(hardStop(ctx({ task: task({ continued_from: 1000, updated_at: 1001 }) }))).toBe(null);
  });

  it('has no opinion to overrule on an ordinary yield', () => {
    expect(hardStop(ctx())).toBe(null);
    expect(hardStop(ctx({ task: task() }))).toBe(null);
  });
});

describe('the question the gate asks itself', () => {
  const prompt = yieldPrompt({ ask: 'make the bar shorter', closing: 'Done, 59px now.' });

  it('asks for the GOAL, not the words — which is the whole idea', () => {
    expect(prompt).toMatch(/GOAL/);
    expect(prompt).toMatch(/not the literal words/);
    expect(prompt).toMatch(/would he consider that goal DONE/i);
  });

  it('tells it to answer the dumb questions rather than pass them on', () => {
    expect(prompt).toMatch(/what would HE answer/);
    expect(prompt).toMatch(/reversible/);
    expect(prompt).toMatch(/rather you\s+decided and told him/);
  });

  it('asks for the follow-up he would have asked for', () => {
    // "what follow up clarification/proof/scale/capability would he ask for"
    expect(prompt).toMatch(/clarification, proof it works, scale/);
  });

  it('names the handovers it must not take', () => {
    expect(prompt).toMatch(/irreversible/);
    expect(prompt).toMatch(/costs real money/);
    expect(prompt).toMatch(/reaches another person/);
    // The case most easily got wrong: he asked a QUESTION, so answering it is
    // the deliverable and the turn is correctly over.
    expect(prompt).toMatch(/his message was a question and it has been answered/);
  });

  it('forbids speaking as him, or inventing his opinion', () => {
    expect(prompt).toMatch(/Never speak as/);
    expect(prompt).toMatch(/never invent an opinion of his/);
  });

  it('carries both sides of the yield, bounded', () => {
    const long = yieldPrompt({ ask: 'x'.repeat(9000), closing: 'y'.repeat(9000) });
    expect(long).toContain('x'.repeat(4000));
    expect(long).not.toContain('x'.repeat(4001));
    expect(long.length).toBeLessThan(12000);
  });

  it('says so when there was nothing to go on', () => {
    const blank = yieldPrompt({ ask: '', closing: '' });
    expect(blank).toMatch(/\(nothing — the chat began on its own\)/);
    expect(blank).toMatch(/\(it said nothing\)/);
  });
});

/**
 * EVERY UNKNOWN IS A HANDOVER. The gate may only ever make the cockpit less
 * likely to stop; a bug that makes it MORE likely to trap work inside a chat
 * is the one outcome that would make it unusable, so the parser fails toward
 * the behaviour muxpad had before any of this existed.
 */
describe('reading the verdict', () => {
  it('takes a prod with something to say', () => {
    expect(
      parseVerdict('{"verdict":"prod","message":"run the suite","why":"no proof yet"}'),
    ).toEqual({ kind: 'prod', message: 'run the suite', why: 'no proof yet' });
  });

  it('takes a deliver', () => {
    expect(parseVerdict('{"verdict":"deliver","why":"he asked a question"}')).toEqual({
      kind: 'deliver',
      why: 'he asked a question',
    });
  });

  it('finds the line inside whatever else the model said', () => {
    const v = parseVerdict(
      'Sure!\n```json\n{"verdict":"prod","message":"go on","why":"mid-job"}\n```',
    );
    expect(v).toEqual({ kind: 'prod', message: 'go on', why: 'mid-job' });
  });

  it.each([
    ['empty', ''],
    ['prose', 'I think it should probably continue, honestly'],
    ['broken json', '{"verdict":"prod", "message":'],
    ['a prod with no message', '{"verdict":"prod","why":"mid-job"}'],
    ['a prod with a blank message', '{"verdict":"prod","message":"   ","why":"x"}'],
    ['a verdict nobody defined', '{"verdict":"escalate","why":"ring him"}'],
    ['null', 'null'],
  ])('hands over on %s', (_name, raw) => {
    expect(parseVerdict(raw).kind).toBe('deliver');
  });

  it('always carries a reason a human can read', () => {
    expect(parseVerdict('{"verdict":"deliver"}').why).toBe('no reason given');
    expect(parseVerdict('nonsense').why).toBeTruthy();
  });
});

describe('whose voice it speaks in', () => {
  it('is muxpad, and not the owner', () => {
    // Not a label choice. Every word he has ever typed is archived, and that
    // archive is what a later version of this learns "what would Ohad answer"
    // from. A machine writing in his voice poisons its own training data.
    expect(YIELD_SPEAKER).toBe('muxpad');
    expect(YIELD_SPEAKER.toLowerCase()).not.toContain('ohad');
  });
});

/**
 * THE AGENT IS TOLD. The alternative — a prod that reads like an ordinary
 * instruction — buys more compliance and creates the failure that matters: an
 * agent that believes Ohad asked for something, works a day on it, and tells
 * him so afterwards.
 */
describe('the prod, as the agent receives it', () => {
  const prod = renderYieldProd(
    { kind: 'prod', message: 'Run the suite and paste the counts.', why: 'no proof yet' },
    { attempt: 2, limit: 6 },
  );

  it('says who is speaking, and that he has not seen this', () => {
    expect(prod).toContain(`[${YIELD_SPEAKER} autopilot`);
    expect(prod).toMatch(/not Ohad/);
    expect(prod).toMatch(/has not seen this turn/);
  });

  it('carries the instruction and the reason for it', () => {
    expect(prod).toContain('Run the suite and paste the counts.');
    expect(prod).toContain('no proof yet');
  });

  it('shows the budget, and what spends it', () => {
    expect(prod).toMatch(/Continuation 2 of 6/);
    expect(prod).toMatch(/spent by finishing,\s*\n?not by trying/);
  });

  it('says how to FINISH, not only how to refuse', () => {
    // The gate's first real prod cost a wasted round trip: the work was done,
    // committed and pushed, the turn ended, and the task the gate had written
    // came back untouched because nobody had closed it. The message explained
    // refusal and never completion.
    expect(prod).toMatch(/close the task with the evidence/);
    expect(prod).toMatch(/commands run,?\s*\n?results seen/);
    expect(prod).toMatch(/in the same turn/);
  });

  it('leaves the valve CHEAP to pull — one line and stop', () => {
    // A refusal that costs a negotiation is a refusal nobody makes, and then
    // the gate has no way to hear "this one really is for him".
    expect(prod).toMatch(/say so in one line and\s*\n?stop/);
    expect(prod).toMatch(/irreversible/);
    expect(prod).toMatch(/Do not argue with this message/);
  });
});

/**
 * READING THE YIELD out of a transcript tail. The two inputs decide
 * everything: what the owner actually asked for, and everything the chat has
 * said since — not just its last paragraph, because "and that's the last of
 * it" means nothing without the findings above it.
 */
describe('the two sides of a yield', () => {
  const ev = (kind: 'user' | 'assistant', text: string, over: Partial<ChatEvent> = {}) =>
    ({ kind, text, ...over }) as ChatEvent;
  // Continuations, cron fires and sub-chat reports all arrive as user events.
  const human = (t: string) => !t.startsWith('[muxpad') && !t.startsWith('[cron');

  it('takes the owner’s last message and everything said after it', () => {
    expect(
      yieldPair(
        [
          ev('user', 'old thing'),
          ev('assistant', 'did the old thing'),
          ev('user', 'now do the new thing'),
          ev('assistant', 'found three issues'),
          ev('assistant', 'fixed one, the rest need you'),
        ],
        human,
      ),
    ).toEqual({
      ask: 'now do the new thing',
      closing: 'found three issues\n\nfixed one, the rest need you',
    });
  });

  it('does not mistake its OWN prod for a fresh instruction', () => {
    // Otherwise the gate measures a turn against the thing it said last time,
    // and the owner's actual ask scrolls out of the question entirely.
    const pair = yieldPair(
      [
        ev('user', 'make the bar shorter'),
        ev('assistant', 'done'),
        ev('user', '[muxpad autopilot] prove it with a measurement'),
        ev('assistant', '59px, measured'),
      ],
      human,
    );
    expect(pair.ask).toBe('make the bar shorter');
    expect(pair.closing).toContain('59px, measured');
    expect(pair.closing).toContain('done');
  });

  it('skips folded context and empty turns', () => {
    const pair = yieldPair(
      [
        ev('user', 'the real ask'),
        ev('user', 'pasted log', { folded: true } as Partial<ChatEvent>),
        ev('assistant', '  '),
      ],
      human,
    );
    expect(pair.ask).toBe('the real ask');
    expect(pair.closing).toBe('');
  });

  it('answers empty for a chat with nothing in it', () => {
    expect(yieldPair([], human)).toEqual({ ask: '', closing: '' });
  });
});

/**
 * THE GATE'S WORST FAILURE, from the Investing chat.
 *
 * The agent ended with "Stopping here — the question is yours and I've asked
 * it twice." The gate prodded it anyway. The agent answered the GATE, the
 * task handed it back again, and by the time the owner arrived the chat had
 * driven itself deeper into work he did not want: "why are you dealing with
 * my taxes? that's for another chat."
 *
 * `hardStop`'s `blocked` only catches a STRUCTURED question (the ask_user
 * tool). An agent writing "I need you to tell me X" in prose is yielding just
 * as deliberately, and in practice that is nearly all of them.
 */
describe('a chat that is asking HIM something', () => {
  it.each([
    "Stopping here — the question is yours and I've asked it twice.",
    'Only you can decide whether to reserve the tax.',
    'I need you to tell me the cost basis before I can finish.',
    'Your call: ship it now, or wait for the review?',
    'Which do you want — the fast one or the correct one?',
    'Done with the rest. Let me know about the pricing and I will finish.',
    'That needs your decision.',
    'Three options, all reasonable. Shall I take the second?',
  ])('is left alone: %s', (closing) => {
    expect(asksTheOwner(closing)).toBe(true);
  });

  it('takes a trailing question as a question to the reader', () => {
    expect(asksTheOwner('Fixed the bar.\n\nWant me to do the same on the phone?')).toBe(true);
  });

  it('does not take a question it went on to answer itself', () => {
    // A rhetorical question mid-paragraph is how half of good prose is
    // written; only the LAST line is a question put to the reader.
    expect(
      asksTheOwner('Why was it slow? The list re-sorted under the finger. Fixed, and measured.'),
    ).toBe(false);
  });

  it.each([
    'Done. 4,355 tests pass and the bar measures 59px.',
    'Fixed and pushed; the suite is green.',
    '',
  ])('still lets an ordinary finish be judged: %s', (closing) => {
    expect(asksTheOwner(closing)).toBe(false);
  });
});

/**
 * "I often ask for tldr — make the anti yield handle those automatically when
 * it's clear from the chat that I'm trying to get shorter results."
 */
describe('the shape he asked for is part of the goal', () => {
  const prompt = yieldPrompt({ ask: 'TLDR', closing: 'x'.repeat(900) });

  it('tells the gate that a right answer in the wrong shape is not done', () => {
    expect(prompt).toMatch(/THE SHAPE HE WANTS IS PART OF THE GOAL/);
    expect(prompt).toMatch(/TLDR/);
    expect(prompt).toMatch(/not done/);
    // …and that the prod is to re-say it, not to go and do more work.
    expect(prompt).toMatch(/say it again in the shape he asked for, not to do more work/);
  });

  it('works in the other direction too, so it is a style rule and not a short rule', () => {
    expect(prompt).toMatch(/if he asked to see the reasoning, a bare conclusion is/);
  });

  it('counts a chat waiting on him as a hand-over, in the prompt as well', () => {
    expect(prompt).toMatch(/the chat has put a question to HIM and is waiting/);
  });
});

/**
 * "When I come in what I see is the agent's final clarification to the anti
 * yield request. I want the actual final result."
 */
describe('what he sees when he comes back', () => {
  const prod = renderYieldProd(
    { kind: 'prod', message: 'Say it in three lines.', why: 'he asked for a TLDR' },
    { attempt: 1, limit: 6 },
  );

  it('tells the agent to answer HIM, not the prod', () => {
    expect(prod).toMatch(/Your closing message is what Ohad will see/);
    expect(prod).toMatch(/he has not read this one/);
    expect(prod).toMatch(/lead with the result/);
    expect(prod).toMatch(/Do not recap what the autopilot told you to do/);
  });
});
