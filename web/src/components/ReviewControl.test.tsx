import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReviewItem, ReviewState } from '../lib/review/session';
import {
  ReviewButton,
  ReviewPanel,
  clockOf,
  sendableNotes,
  unavailableReason,
} from './ReviewControl';

/**
 * THE PANEL IS THE SAFETY RAIL, so this suite is mostly about what it refuses.
 *
 * A review turns speech into instructions for an agent, and the two things that
 * can go wrong — a mishearing, a bad split — both produce something that READS
 * fine. The only defence is that the notes, with their pictures, are on screen
 * before anything is sent. Hence: no send button while recording, no send for a
 * review whose notes all failed, and a visible reason whenever a note is not
 * what it looks like.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const note = (over: Partial<ReviewItem> = {}): ReviewItem => ({
  id: 'n1',
  text: 'this button make it pink',
  startMs: 0,
  endMs: 1000,
  frames: ['/data/attachments/ab12cd34.jpg'],
  status: 'ready',
  ...over,
});

const state = (over: Partial<ReviewState> = {}): ReviewState => ({
  phase: 'recording',
  level: 0.4,
  speaking: true,
  items: [],
  startedAt: 0,
  sampled: 12,
  kept: 4,
  ...over,
});

let root: ReturnType<typeof createRoot> | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

function mount(node: React.ReactNode): HTMLElement {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root?.render(node);
  });
  return host;
}

const panel = (
  over: Partial<ReviewState> = {},
  props: Partial<Parameters<typeof ReviewPanel>[0]> = {},
) =>
  mount(
    <ReviewPanel
      state={state(over)}
      elapsedMs={12_000}
      onStop={vi.fn()}
      onScrap={vi.fn()}
      onSend={vi.fn()}
      onDiscard={vi.fn()}
      log={[]}
      {...props}
    />,
  );

const text = (el: Element | null) => el?.textContent ?? '';

describe('ReviewButton', () => {
  it('offers to start when it can', () => {
    const box = mount(
      <ReviewButton
        state={state({ phase: 'idle' })}
        available
        unconfigured={false}
        onStart={vi.fn()}
        onStop={vi.fn()}
      />,
    );
    const btn = box.querySelector<HTMLButtonElement>('[data-testid="review-start"]');
    expect(btn?.disabled).toBe(false);
  });

  it('DISABLES with a reason rather than hiding when there is no key', () => {
    // A missing control is indistinguishable from a bug, and this one has a fix
    // the user can go and apply.
    const box = mount(
      <ReviewButton
        state={state({ phase: 'idle' })}
        available
        unconfigured
        onStart={vi.fn()}
        onStop={vi.fn()}
      />,
    );
    const btn = box.querySelector<HTMLButtonElement>('[data-testid="review-start"]');
    expect(btn?.disabled).toBe(true);
    expect(btn?.title).toContain('OpenAI key');
  });

  it('becomes an unambiguous stop while recording', () => {
    const onStop = vi.fn();
    const box = mount(
      <ReviewButton
        state={state()}
        available
        unconfigured={false}
        onStart={vi.fn()}
        onStop={onStop}
      />,
    );
    expect(box.querySelector('[data-testid="review-start"]')).toBeNull();
    act(() => box.querySelector<HTMLButtonElement>('[data-testid="review-stop-inline"]')?.click());
    expect(onStop).toHaveBeenCalled();
  });
});

describe('ReviewPanel', () => {
  it('renders nothing at rest — the strip costs the last message its space', () => {
    expect(panel({ phase: 'idle' }).innerHTML).toBe('');
  });

  it('shows a mic meter while recording', () => {
    // The spike burned two runs on a live-but-silent built-in microphone with
    // nothing on screen to say so.
    const box = panel({ level: 0.42 });
    const fill = box.querySelector<HTMLElement>('.review-meter-fill');
    expect(fill?.style.width).toBe('42%');
  });

  it('tells you what to do while nothing has been said yet', () => {
    expect(text(panel().querySelector('.review-hint'))).toMatch(/talk while you point/i);
  });

  it('lists a note with its frame thumbnail', () => {
    const box = panel({ items: [note()] });
    const row = box.querySelector('[data-testid="review-note"]');
    expect(text(row)).toContain('this button make it pink');
    expect(row?.querySelector('img')?.getAttribute('src')).toBe(
      '/api/panes/attachments/ab12cd34.jpg',
    );
  });

  it('says a note is still being transcribed rather than showing it empty', () => {
    const box = panel({ items: [note({ text: '', status: 'pending' })] });
    expect(text(box.querySelector('[data-testid="review-note"]'))).toContain('listening');
  });

  it('shows WHY a note failed instead of dropping the remark silently', () => {
    const box = panel({ items: [note({ status: 'failed', error: 'HTTP 401' })] });
    expect(text(box.querySelector('[data-testid="review-note"]'))).toContain('401');
  });

  it('scraps one note', () => {
    const onScrap = vi.fn();
    const box = panel({ items: [note()] }, { onScrap });
    act(() => box.querySelector<HTMLButtonElement>('.review-scrap')?.click());
    expect(onScrap).toHaveBeenCalledWith('n1');
  });

  it('has NO send button while recording — nothing leaves mid-review', () => {
    expect(panel({ items: [note()] }).querySelector('[data-testid="review-send"]')).toBeNull();
  });

  it('sends on an explicit press once stopped', () => {
    const onSend = vi.fn();
    const box = panel({ phase: 'stopped', items: [note()] }, { onSend });
    act(() => box.querySelector<HTMLButtonElement>('[data-testid="review-send"]')?.click());
    expect(onSend).toHaveBeenCalled();
  });

  it('refuses to send a review whose notes all failed', () => {
    const box = panel({ phase: 'stopped', items: [note({ status: 'failed' })] });
    expect(box.querySelector<HTMLButtonElement>('[data-testid="review-send"]')?.disabled).toBe(
      true,
    );
  });

  it('explains a failure to start, with a way out', () => {
    const onDiscard = vi.fn();
    const box = panel({ phase: 'failed', error: 'Screen sharing was cancelled.' }, { onDiscard });
    expect(text(box.querySelector('.review-msg'))).toBe('Screen sharing was cancelled.');
    act(() => box.querySelector<HTMLButtonElement>('.review-dismiss')?.click());
    expect(onDiscard).toHaveBeenCalled();
  });

  it('shows the last diagnostic when a review produced nothing', () => {
    const box = panel(
      { phase: 'stopped', items: [] },
      { log: ['the browser refused cursor:always'] },
    );
    expect(text(box.querySelector('.review-log'))).toContain('cursor:always');
  });
});

describe('helpers', () => {
  it('sendableNotes keeps only transcribed, non-empty notes', () => {
    expect(
      sendableNotes([
        note(),
        note({ id: 'n2', status: 'pending', text: '' }),
        note({ id: 'n3', status: 'failed' }),
        note({ id: 'n4', text: '   ' }),
      ]).map((n) => n.id),
    ).toEqual(['n1']);
  });

  it('clockOf is m:ss', () => {
    expect(clockOf(0)).toBe('0:00');
    expect(clockOf(72_000)).toBe('1:12');
  });

  it('unavailableReason names the browser before the server', () => {
    expect(unavailableReason(false, true)).toContain('browser');
    expect(unavailableReason(true, true)).toContain('OpenAI key');
    expect(unavailableReason(true, false)).toBeNull();
  });
});
