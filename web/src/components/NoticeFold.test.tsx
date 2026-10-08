import type { ChatEvent } from '@muxpad/shared';
import { renderCronMarker, withMentionContext } from '@muxpad/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { ChatRow, QueuedText, UserText } from './ChatTranscript';

/**
 * A notice with something folded behind it — a quiet cron's prompt.
 *
 * The claim: the fire stays in the log and stays INSPECTABLE, while the
 * plumbing it injected stops taking up the conversation. A fire you cannot
 * unfold is a fire you cannot debug.
 */
const notice = (): ChatEvent => ({
  kind: 'notice',
  id: 'n1',
  ts: 0,
  variant: 'cron',
  text: 'nw-close',
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

describe('a cron chip is a MARK, not a control', () => {
  it('is never pressable, and carries no caret', () => {
    // It briefly revealed a folded cron's prompt behind a caret of its own,
    // which gave one fire TWO folds — this one and the "N actions" run right
    // under it — and made a label look pressable for a reason no reader would
    // guess. The prompt folds in with the tool calls instead.
    const host = mount(notice());
    expect(host.querySelector('button.chat-sysnote')).toBeNull();
    expect(host.querySelector('.chat-sysnote-chevron')).toBeNull();
    expect(host.querySelector('.chat-sysnote-body')).toBeNull();
  });

  it('still says which schedule fired', () => {
    const host = mount(notice());
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

describe("a mention's handles never reach the reader", () => {
  const typed = 'what did @Investing decide?';
  const sent = withMentionContext(typed, [{ name: 'Investing', tabId: 'T1', paneIds: ['P1'] }]);

  const render = (node: React.ReactNode) => {
    const host = document.createElement('div');
    document.body.append(host);
    act(() => {
      createRoot(host).render(node);
    });
    return host;
  };

  it('strips them from a plain bubble', () => {
    const host = render(<UserText text={sent} />);
    expect(host.textContent).toBe(typed);
    expect(host.textContent).not.toContain('muxpad-context');
  });

  it('strips them from a QUEUED bubble', () => {
    // The queue holds the raw outgoing message.
    const host = render(<QueuedText text={sent} />);
    expect(host.textContent).not.toContain('muxpad-context');
    expect(host.textContent).not.toContain('P1');
  });

  it('is the choke point, so the optimistic echo is covered too', () => {
    // The optimistic bubble renders the server's turn-start text — raw, and
    // never through the transcript normalizer. It had the leak; stripping in
    // UserText is what closes it without a third patch.
    const host = render(<UserText text={sent} />);
    expect(host.textContent).not.toContain('tab T1');
  });

  it('leaves an ordinary message exactly as typed', () => {
    const host = render(<UserText text="just a message" />);
    expect(host.textContent).toBe('just a message');
  });
});
