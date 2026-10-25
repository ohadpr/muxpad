import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ANCHOR_ATTR } from '../lib/chat-scroll-dom';
import { type PendingQuestion, QuestionCard } from './ChatTranscript';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * THE CARD HAS TO BE A ROW THE SCROLL CONTROLLER CAN SEE.
 *
 * It is routinely the tallest thing in the log — 647px against a 700px
 * viewport for three questions, measured — and it was the only child of
 * `.chat-list` with no `data-eid`. The controller builds its entire model of
 * "where is the reader" from rows that have one (`anchorRows` / `rowBox` in
 * lib/chat-scroll-dom.ts), so this card did not exist to it: the newest row it
 * could name sat above several hundred pixels of options, and every re-place
 * put the reader back there.
 *
 * Reported as "i literally can't scroll to its bottom there's some scroll bug"
 * — with the jump-to-latest arrow showing, which was the controller correctly
 * reporting that the reader was nowhere near the end.
 */
const pending = (qid = 'q1'): PendingQuestion => ({
  qid,
  questions: [
    {
      header: 'Player',
      question: 'What model do you want?',
      multiSelect: false,
      options: [
        { label: 'Bottom bar', description: 'One player docked at the bottom.' },
        { label: 'Inline', description: 'Stays inside each card.' },
      ],
    },
  ],
});

let root: ReturnType<typeof createRoot> | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  host = null;
  root = null;
});

function mount(p = pending(), onAnswer = vi.fn()) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root?.render(<QuestionCard pending={p} onAnswer={onAnswer} />);
  });
  return host;
}

describe('QuestionCard', () => {
  it('is an anchored row, like every other row in the log', () => {
    const row = mount().firstElementChild as HTMLElement;
    expect(row.getAttribute(ANCHOR_ATTR)).toBe('q:q1');
  });

  it('anchors on the QID, so two cards are never the same row', () => {
    const a = mount(pending('alpha')).firstElementChild?.getAttribute(ANCHOR_ATTR);
    act(() => root?.unmount());
    host?.remove();
    const b = mount(pending('beta')).firstElementChild?.getAttribute(ANCHOR_ATTR);
    expect(a).not.toBe(b);
  });

  it('still renders the label and its description as separate spans', () => {
    // The inline layout is CSS (ChatPane.question.css.test.ts). The MARKUP
    // stays two spans so the separator can be a pseudo-element and an option
    // with no description cannot grow a stray dash.
    const box = mount();
    expect(box.querySelector('.chat-question-option-label')?.textContent).toBe('Bottom bar');
    expect(box.querySelector('.chat-question-option-desc')?.textContent).toBe(
      'One player docked at the bottom.',
    );
  });

  it('answers immediately for a single single-select question', () => {
    const onAnswer = vi.fn();
    const box = mount(pending(), onAnswer);
    const first = box.querySelector<HTMLButtonElement>('.chat-question-option');
    act(() => first?.click());
    expect(onAnswer).toHaveBeenCalledWith([
      { question: 'What model do you want?', answers: ['Bottom bar'] },
    ]);
  });
});
