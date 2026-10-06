import type { ChatEvent } from '@muxpad/shared';
import { renderCronMarker } from '@muxpad/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { ChatRow, QueuedText } from './ChatTranscript';

/**
 * A notice with something folded behind it — a quiet cron's prompt.
 *
 * The claim: the fire stays in the log and stays INSPECTABLE, while the
 * plumbing it injected stops taking up the conversation. A fire you cannot
 * unfold is a fire you cannot debug.
 */
const notice = (body?: string): ChatEvent => ({
  kind: 'notice',
  id: 'n1',
  ts: 0,
  variant: 'cron',
  text: 'nw-close',
  ...(body ? { body } : {}),
});

function mount(e: ChatEvent) {
  const host = document.createElement('div');
  document.body.append(host);
  act(() => {
    createRoot(host).render(<ChatRow event={e} />);
  });
  return host;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('a foldable notice', () => {
  it('is a plain row when there is nothing to unfold', () => {
    // A caret on a row that does nothing is worse than no caret.
    const host = mount(notice());
    expect(host.querySelector('.chat-sysnote-chevron')).toBeNull();
    expect(host.querySelector('button.chat-sysnote')).toBeNull();
  });

  it('offers a caret when it carries a prompt, and hides it until asked', () => {
    const host = mount(notice('Run: python3 nw_oneline.py CLOSE'));
    expect(host.querySelector('.chat-sysnote-chevron')).toBeTruthy();
    expect(host.querySelector('.chat-sysnote-body')).toBeNull();
    const btn = host.querySelector('button.chat-sysnote') as HTMLButtonElement;
    expect(btn.getAttribute('aria-expanded')).toBe('false');
  });

  it('unfolds the prompt, and folds it back', () => {
    const host = mount(notice('Run: python3 nw_oneline.py CLOSE'));
    const btn = host.querySelector('button.chat-sysnote') as HTMLButtonElement;
    act(() => btn.click());
    expect(host.querySelector('.chat-sysnote-body')?.textContent).toContain('nw_oneline.py');
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    act(() => btn.click());
    expect(host.querySelector('.chat-sysnote-body')).toBeNull();
  });

  it('still says which schedule fired', () => {
    // Folding the plumbing must not fold the fact that something ran.
    const host = mount(notice('plumbing'));
    expect(host.querySelector('.chat-sysnote-text')?.textContent).toBe('nw-close');
  });
});

describe('a queued message that is a cron fire', () => {
  const fire = (fold: boolean, prompt = 'Run: bash progress.sh') =>
    renderCronMarker(
      { id: 'c1', name: 'cards-demo', at: 1, missed: 0, ...(fold ? { fold: true } : {}) },
      prompt,
    );

  it('NEVER shows the raw marker — the bug this exists for', () => {
    // A queued message is the raw text that will be delivered, and a fire's raw
    // text starts with its marker. Seen in the log as a bubble full of
    // `<muxpad-cron id="…">` for the whole minute before it ran.
    const host = document.createElement('div');
    document.body.append(host);
    act(() => {
      createRoot(host).render(<QueuedText text={fire(false)} />);
    });
    expect(host.textContent).not.toContain('muxpad-cron');
    expect(host.textContent).not.toContain('<');
    // …and it still says which schedule is waiting, plus what it will run.
    expect(host.querySelector('.chat-queued-cron')?.textContent).toContain('cards-demo');
    expect(host.textContent).toContain('Run: bash progress.sh');
  });

  it('keeps a FOLDED cron quiet in the queue too', () => {
    // It would be odd for a message to be noisy while queued and quiet a
    // second later when it runs.
    const host = document.createElement('div');
    document.body.append(host);
    act(() => {
      createRoot(host).render(<QueuedText text={fire(true)} />);
    });
    expect(host.querySelector('.chat-queued-cron')?.textContent).toContain('cards-demo');
    expect(host.textContent).not.toContain('Run: bash');
  });

  it('leaves an ordinary queued message completely alone', () => {
    const host = document.createElement('div');
    document.body.append(host);
    act(() => {
      createRoot(host).render(<QueuedText text="just a message I typed" />);
    });
    expect(host.querySelector('.chat-queued-cron')).toBeNull();
    expect(host.textContent).toBe('just a message I typed');
  });
});
