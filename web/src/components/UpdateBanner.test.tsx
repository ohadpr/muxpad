import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// `act` from 'react', not 'react-dom/test-utils' — the latter is deprecated in
// 18.3 and logs a warning on every use.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The affordance itself: quiet, tappable, and never acting on its own.
 *
 * STRUCTURE is checked against static markup; BEHAVIOUR by mounting and
 * clicking, because "the tap reloads and the × does not" is the entire meaning
 * of the component and a markup test passes just as happily with the two
 * handlers swapped.
 *
 * The CSS is checked too, for one reason that is not cosmetic: this banner is
 * for an installed iOS PWA, where the document runs under the status bar /
 * Dynamic Island (`viewport-fit=cover`) and the bottom edge is occupied by the
 * mobile composer. A pill that lands under the notch or on top of the composer
 * is a pill the user cannot tap.
 */

let pending: string | null = null;
let listener: ((b: string | null) => void) | null = null;
const applyUpdate = vi.fn();
const dismissUpdate = vi.fn();
const startUpdateCheck = vi.fn();
vi.mock('../lib/update-check', () => ({
  pendingUpdate: () => pending,
  subscribeUpdate: (l: (b: string | null) => void) => {
    listener = l;
    return () => {
      listener = null;
    };
  },
  startUpdateCheck: () => startUpdateCheck(),
  applyUpdate: () => applyUpdate(),
  dismissUpdate: () => dismissUpdate(),
}));

const { UpdateBanner } = await import('./UpdateBanner');

beforeEach(() => {
  pending = null;
  listener = null;
  applyUpdate.mockReset();
  dismissUpdate.mockReset();
  startUpdateCheck.mockReset();
});

let host: HTMLDivElement | null = null;
afterEach(() => {
  host?.remove();
  host = null;
});

/** Mount for real so effects (the subscription) run. */
function mount(): HTMLDivElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(<UpdateBanner />));
  return host;
}

describe('structure', () => {
  it('renders nothing at all when there is no newer build', () => {
    expect(renderToStaticMarkup(<UpdateBanner />)).toBe('');
  });

  it('offers one reload control and one way to wave it away', () => {
    pending = 'index-bbbb2222.js';
    const html = renderToStaticMarkup(<UpdateBanner />);
    expect(html.match(/<button/g) ?? []).toHaveLength(2);
    expect(html).toMatch(/new version/i);
    expect(html).toMatch(/reload/i);
  });

  it('announces itself politely rather than grabbing focus', () => {
    // It can appear while the user is typing into an agent. A live region
    // reaches a screen reader without moving the caret; a dialog would not.
    pending = 'index-bbbb2222.js';
    const html = renderToStaticMarkup(<UpdateBanner />);
    expect(html).toMatch(/role="status"/);
    expect(html).toMatch(/aria-live="polite"/);
    expect(html).not.toMatch(/role="(dialog|alertdialog)"/);
  });
});

describe('behaviour', () => {
  it('starts the check on mount — the window that can SHOW it is the one that asks', () => {
    // Popout routes (a pane popout, the doc surface) mount outside AppLayout, so
    // wiring the check here rather than at boot keeps them from spending a
    // request per foreground on a prompt they have nowhere to render.
    mount();
    expect(startUpdateCheck).toHaveBeenCalledTimes(1);
  });

  it('subscribes before it starts, so a fast answer cannot slip past', () => {
    startUpdateCheck.mockImplementation(() => {
      expect(listener).not.toBeNull();
    });
    mount();
    expect(startUpdateCheck).toHaveBeenCalledTimes(1);
  });

  it('reloads only when the reload control is tapped', () => {
    pending = 'index-bbbb2222.js';
    const el = mount();
    const buttons = [...el.querySelectorAll('button')];
    const reload = buttons.find((b) => /reload/i.test(b.textContent ?? ''));
    expect(reload).toBeTruthy();
    act(() => reload?.click());
    expect(applyUpdate).toHaveBeenCalledTimes(1);
    expect(dismissUpdate).not.toHaveBeenCalled();
  });

  it('dismisses without reloading — the user may be mid-message', () => {
    pending = 'index-bbbb2222.js';
    const el = mount();
    const x = el.querySelector<HTMLButtonElement>('.update-banner-dismiss');
    act(() => x?.click());
    expect(dismissUpdate).toHaveBeenCalledTimes(1);
    expect(applyUpdate).not.toHaveBeenCalled();
  });

  it('appears mid-session, without anything else re-rendering', () => {
    // The detection happens on a resume, long after this component mounted.
    const el = mount();
    expect(el.textContent).toBe('');
    pending = 'index-bbbb2222.js';
    act(() => listener?.('index-bbbb2222.js'));
    expect(el.textContent).toMatch(/new version/i);
  });

  it('takes itself away when the update is retired', () => {
    pending = 'index-bbbb2222.js';
    const el = mount();
    pending = null;
    act(() => listener?.(null));
    expect(el.textContent).toBe('');
  });
});

describe('placement', () => {
  // Comments stripped before whitespace is collapsed: these assertions are
  // about DECLARATIONS, and the prose in this sheet names the very properties
  // it exists to explain staying away from.
  const css = readFileSync(join(import.meta.dirname, 'UpdateBanner.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ');

  it('clears the iPhone status bar / Dynamic Island', () => {
    // In standalone the document owns the full screen (see the 100lvh +
    // safe-area rules in styles.css), so a `top` measured from the viewport
    // edge puts the pill under the notch.
    expect(css).toMatch(/top:\s*calc\([^)]*env\(safe-area-inset-top\)/);
  });

  it('is not anchored to the bottom, which already has three tenants', () => {
    // The mobile composer (position:fixed bottom:0), the move-undo stack
    // (bottom-left) and the external-open stack (bottom-right).
    expect(css).not.toMatch(/\bbottom:\s*(?!auto)/);
  });

  it('floats above the panes it overlaps', () => {
    expect(css).toMatch(/z-index:\s*1000/);
  });
});
