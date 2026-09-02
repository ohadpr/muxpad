// `act` from 'react', not 'react-dom/test-utils' — the latter is deprecated in
// 18.3 and logs a warning on every use.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SWIPE_ACTION_COUNT, SWIPE_ACTION_WIDTH, SWIPE_TRAY_WIDTH } from '../lib/swipe-axis';
import { SwipeRow } from './SwipeRow';

/**
 * The tray's contract, in two layers.
 *
 * STRUCTURE is checked against static markup — no DOM library, and the
 * assertions are about what the browser will actually get. BEHAVIOUR (which
 * way the toggle goes, whether the tray puts itself away) is checked by
 * mounting and clicking, because that is where the only real logic in this
 * component lives: `onSetUnread(!unread)` is not delegation, it is the meaning
 * of the button, and a markup-only test passes just as happily with the
 * negation dropped.
 *
 * What the callbacks then DO — one route, optimistic patch, rollback — is
 * lib/tab-unread.test's job.
 */
const props = (over: Partial<Parameters<typeof SwipeRow>[0]> = {}) => ({
  id: 't1',
  label: 'chat Investing',
  pinned: false,
  unread: false,
  onPin: vi.fn(),
  onSetUnread: vi.fn(),
  onClose: vi.fn(),
  ...over,
});

const render = (over: { pinned?: boolean; unread?: boolean } = {}) =>
  renderToStaticMarkup(<SwipeRow {...props(over)}>{<div>row</div>}</SwipeRow>);

describe('the tray offers three actions', () => {
  it('renders exactly one button per SWIPE_ACTION_COUNT', () => {
    const buttons = render().match(/<button/g) ?? [];
    expect(buttons).toHaveLength(SWIPE_ACTION_COUNT);
  });

  it('orders them Pin · Unread · Close — destructive LAST', () => {
    const h = render();
    // The tray is `justify-content: flex-end`, so DOM order is left-to-right
    // and the last button sits hard against the row's right edge — the same
    // 0..SWIPE_ACTION_WIDTH band Close occupied before the third action
    // arrived, which is the one position worth holding still.
    expect(h.indexOf('-pin')).toBeLessThan(h.indexOf('-unread'));
    expect(h.indexOf('-unread')).toBeLessThan(h.indexOf('-close'));
  });

  it('lays the rendered buttons out to exactly the distance the row slides', () => {
    // Ties the DOM to the arithmetic: the tray the browser lays out is
    // (number of buttons × the published width), and the row slides
    // SWIPE_TRAY_WIDTH. If those disagree the last action is off-screen or
    // there is a gap of bare tray under the row.
    const h = render();
    const buttons = (h.match(/<button/g) ?? []).length;
    const width = Number(h.match(/--swipe-action-width:(\d+)px/)?.[1]);
    expect(width).toBe(SWIPE_ACTION_WIDTH);
    expect(buttons * width).toBe(SWIPE_TRAY_WIDTH);
  });
});

describe('mark unread names the state it produces', () => {
  it('offers "Unread" on a read row and "Read" on an unread one', () => {
    expect(render()).toContain('Unread');
    expect(render({ unread: true })).toContain('Read');
    expect(render({ unread: true })).toContain('aria-label="Mark chat Investing read"');
  });

  it('carries an accessible name that says which chat, both ways', () => {
    expect(render()).toContain('aria-label="Mark chat Investing unread"');
  });

  it('keeps Close armed-on-second-tap — the confirm is not traded away', () => {
    // The tray gained an action; the destructive one keeps its two-tap gate.
    const h = render();
    expect(h).toContain('aria-label="Close chat Investing"');
    expect(h).toContain('Close');
  });

  it('hides every action from the tab order while the row is shut', () => {
    // A closed tray must not add three tab stops and three announced buttons
    // per chat to a surface a keyboard user cannot even open.
    expect((render().match(/tabindex="-1"/g) ?? []).length).toBe(SWIPE_ACTION_COUNT);
  });
});

// ── Behaviour: mounted, clicked ──────────────────────────────────────────
// React 18 wants to be told it is under test before it will let `act` flush
// quietly; without it every render logs "not configured to support act(...)"
// and the real assertions drown in warnings.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;

/**
 * A left swipe, as jsdom can express one.
 *
 * jsdom has no PointerEvent, so the events are MouseEvents wearing the pointer
 * fields the component actually reads. That is enough precisely because
 * SwipeRow reads only `pointerType`, `pointerId` and the coordinates — the
 * arithmetic it feeds them to is tested directly in swipe-axis.test.
 *
 * This exists because "the tray closes" is unassertable without it: with no
 * row ever opened, the module-level open token is already null and every
 * `setOpenRow(null)` is a silent no-op, so a test that skips the swipe passes
 * whether or not the component closes anything.
 */
function pointer(type: string, x: number, y: number): Event {
  const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
  Object.defineProperty(e, 'pointerType', { value: 'touch' });
  Object.defineProperty(e, 'pointerId', { value: 1 });
  return e;
}

function mount(over: Partial<Parameters<typeof SwipeRow>[0]> = {}) {
  const p = props(over);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root?.render(<SwipeRow {...p}>{<div>row</div>}</SwipeRow>);
  });
  const el = () => host as HTMLDivElement;
  const row = () => el().querySelector('.swiperow') as HTMLElement;
  const click = (cls: string) => {
    const btn = el().querySelector<HTMLButtonElement>(`.swiperow-action.${cls}`);
    act(() => btn?.click());
  };
  const swipeOpen = () => {
    const face = el().querySelector('.swiperow-face') as HTMLElement;
    act(() => {
      face.dispatchEvent(pointer('pointerdown', 300, 20));
      for (let dx = -20; dx >= -200; dx -= 20)
        face.dispatchEvent(pointer('pointermove', 300 + dx, 20));
      face.dispatchEvent(pointer('pointerup', 100, 20));
    });
  };
  return { p, click, el, row, swipeOpen };
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  host = null;
  root = null;
});

describe('tapping mark unread', () => {
  it('asks for the OPPOSITE of the row it is on — both ways round', () => {
    // The one assertion a markup test cannot make, and the one that catches
    // the likeliest edit: dropping the `!` and shipping a button that marks an
    // already-unread chat unread again.
    const read = mount({ unread: false });
    read.click('-unread');
    expect(read.p.onSetUnread).toHaveBeenCalledWith(true);
  });

  it('marks an unread row READ', () => {
    const unread = mount({ unread: true });
    unread.click('-unread');
    expect(unread.p.onSetUnread).toHaveBeenCalledWith(false);
  });

  it('puts the tray away, like Pin — the action is done, the row is not open', () => {
    // Leaving it open after a tap reads as "did that register?", and it parks
    // an armed Close under a thumb that has just finished tapping.
    const m = mount({ unread: false });
    m.swipeOpen();
    expect(m.row().getAttribute('data-open')).toBe('true');
    m.click('-unread');
    expect(m.row().getAttribute('data-open')).toBeNull();
  });

  it('does not fire the row’s other actions', () => {
    const m = mount();
    m.click('-unread');
    expect(m.p.onPin).not.toHaveBeenCalled();
    expect(m.p.onClose).not.toHaveBeenCalled();
  });
});

describe('Close still takes two taps, with a third action in the tray', () => {
  const armed = (m: ReturnType<typeof mount>) =>
    (m.el().querySelector('.swiperow-action.-close') as HTMLElement).getAttribute('data-armed');

  it('arms on the first tap and only destroys on the second', () => {
    const m = mount();
    m.swipeOpen();
    m.click('-close');
    expect(m.p.onClose).not.toHaveBeenCalled();
    expect(armed(m)).toBe('true');
    expect((m.el().querySelector('.swiperow-action.-close') as HTMLElement).textContent).toContain(
      'Sure?',
    );
    m.click('-close');
    expect(m.p.onClose).toHaveBeenCalledTimes(1);
  });

  it('DISARMS when the tray is dismissed by another action', () => {
    // Arming points a loaded Close at a chat. Tapping Unread closes the tray,
    // and a tray that came back still armed would destroy on what the user
    // experiences as a first tap. Only observable through a real open/close
    // cycle — the disarm rides the "someone closed this row" listener.
    const m = mount();
    m.swipeOpen();
    m.click('-close');
    expect(armed(m)).toBe('true');
    m.click('-unread');
    expect(armed(m)).toBeNull();
    expect(m.p.onClose).not.toHaveBeenCalled();
  });
});
