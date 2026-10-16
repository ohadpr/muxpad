import { afterEach, describe, expect, it } from 'vitest';
import { recallOpenSubChats, rememberOpenSubChats } from './rail-folds';

/**
 * The disclosure has to SURVIVE a remount, because that is the only thing that
 * makes collapsing-by-default tolerable: a coordinator chat is one you sit with
 * for an hour, and a sidebar remounts on every tab switch.
 */
afterEach(() => localStorage.clear());

describe('the rail remembers whose sub-chats are open', () => {
  it('round-trips a set', () => {
    rememberOpenSubChats(new Set(['a', 'b']));
    expect([...recallOpenSubChats()].sort()).toEqual(['a', 'b']);
  });

  it('starts empty — collapsed is the default, including on a fresh browser', () => {
    expect(recallOpenSubChats().size).toBe(0);
  });

  it('clears the key rather than storing an empty list', () => {
    rememberOpenSubChats(new Set(['a']));
    rememberOpenSubChats(new Set());
    expect(localStorage.getItem('muxpad:rail-open-subs:v1')).toBeNull();
  });

  it('survives junk in the slot instead of throwing while the rail renders', () => {
    // The rail reads this during render. Anything that can throw there takes
    // the whole sidebar with it, so a corrupt value has to read as "nothing
    // open" — the same answer a first-time browser gives.
    for (const junk of ['not json', '{"a":1}', '42', 'null']) {
      localStorage.setItem('muxpad:rail-open-subs:v1', junk);
      expect(recallOpenSubChats().size).toBe(0);
    }
  });

  it('drops non-strings out of an otherwise valid list', () => {
    localStorage.setItem('muxpad:rail-open-subs:v1', JSON.stringify(['a', 7, null, 'b']));
    expect([...recallOpenSubChats()].sort()).toEqual(['a', 'b']);
  });

  it('is bounded, keeping the most recent', () => {
    const many = new Set(Array.from({ length: 140 }, (_, i) => `t${i}`));
    rememberOpenSubChats(many);
    const back = recallOpenSubChats();
    expect(back.size).toBe(100);
    expect(back.has('t139')).toBe(true);
    expect(back.has('t0')).toBe(false);
  });
});
