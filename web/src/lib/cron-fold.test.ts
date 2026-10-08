import type { ChatEvent } from '@muxpad/shared';
import { describe, expect, it } from 'vitest';
import { foldCronTurns, isPrivateReasoning } from './chat-voice';

/**
 * A folded cron's WHOLE turn is plumbing, not just its prompt.
 *
 * `--fold` hid the injected instruction but not what the agent then did about
 * it, so an hourly job still printed a tool row and a one-word reply into the
 * chat every time — six rows a day saying "closed", in a conversation whose
 * real content is one card.
 */
let n = 0;
const id = () => `e${++n}`;
const fire = (folded: boolean): ChatEvent => ({
  kind: 'notice',
  id: id(),
  ts: 0,
  variant: 'cron',
  text: 'nw-hourly',
  ...(folded ? { body: 'Are the markets open?' } : {}),
});
const prose = (text = 'closed'): ChatEvent => ({ kind: 'assistant', id: id(), ts: 0, text });
const reply = (text: string): ChatEvent => ({
  kind: 'assistant',
  id: id(),
  ts: 0,
  text,
  voice: 'reply',
});
const user = (text: string): ChatEvent => ({ kind: 'user', id: id(), ts: 0, text });
const tool = (): ChatEvent => ({
  kind: 'tool_use',
  id: id(),
  ts: 0,
  toolUseId: id(),
  name: 'Bash',
  input: {},
});

describe('foldCronTurns', () => {
  it('demotes the prose a FOLDED fire produced', () => {
    const out = foldCronTurns([fire(true), tool(), prose('closed')]);
    expect(isPrivateReasoning(out[2] as ChatEvent)).toBe(true);
  });

  it('leaves an UNFOLDED fire completely alone', () => {
    // Its author did not ask for this; its prompt is visible and so is its work.
    const out = foldCronTurns([fire(false), tool(), prose('closed')]);
    expect(isPrivateReasoning(out[2] as ChatEvent)).toBe(false);
  });

  it('stops at the next human turn', () => {
    const out = foldCronTurns([fire(true), prose('closed'), user('hey'), prose('hello!')]);
    expect(isPrivateReasoning(out[1] as ChatEvent)).toBe(true);
    expect(isPrivateReasoning(out[3] as ChatEvent)).toBe(false);
  });

  it("does not fold a cron's own prompt bubble back into itself", () => {
    // The bubble adjacent to a fire belongs to the fire; a bubble elsewhere is
    // a person and ends the fold.
    const f = fire(true);
    const out = foldCronTurns([f, user('the prompt'), prose('closed')]);
    expect(isPrivateReasoning(out[2] as ChatEvent)).toBe(true);
  });

  it('NEVER folds a deliberate reply', () => {
    // A cron told to say something was told to say it; hiding that would hide
    // the one part its author meant you to read.
    const out = foldCronTurns([fire(true), reply('SPX +0.4%')]);
    expect(out[1]).toMatchObject({ voice: 'reply' });
  });

  it('returns the SAME array when nothing changed', () => {
    // Identity matters: this runs on every render of every chat.
    const events = [user('hi'), prose('hello')];
    expect(foldCronTurns(events)).toBe(events);
  });

  it('a second fire re-opens the fold', () => {
    const out = foldCronTurns([fire(true), prose('a'), fire(true), prose('b')]);
    expect(isPrivateReasoning(out[1] as ChatEvent)).toBe(true);
    expect(isPrivateReasoning(out[3] as ChatEvent)).toBe(true);
  });

  it('a non-cron notice does not open one', () => {
    const task: ChatEvent = { kind: 'notice', id: id(), ts: 0, variant: 'task', text: 'x' };
    const out = foldCronTurns([task, prose('visible')]);
    expect(isPrivateReasoning(out[1] as ChatEvent)).toBe(false);
  });
});
