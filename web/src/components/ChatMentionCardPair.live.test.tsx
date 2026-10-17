import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { ChatMentionCard } from './ChatMentionPicker';

/**
 * HOVER ONE END, SEE THE OTHER — in a real DOM, because that is where it
 * happens.
 *
 * The highlight is set IMPERATIVELY (see `highlightPair`): no React state, no
 * re-render, just an attribute on at most two elements. The alternative was
 * lifting a `hoveredPair` into ChatPane, whose render is the whole log, so
 * every pointer crossing a card would re-render thousands of rows for a
 * decoration. A string-rendering test cannot see any of this — it has to be
 * mounted and pointed at.
 */
const PAIR = '01ABC:7';

let container: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;

async function mountPair(): Promise<void> {
  container = document.createElement('div');
  document.body.append(container);
  await act(async () => {
    root = createRoot(container as HTMLDivElement);
    root.render(
      <>
        <ChatMentionCard chat={{ name: 'hn-top' }} thread="open" pair={PAIR} state="started" />
        <div id="between">a screenful of log</div>
        <ChatMentionCard chat={{ name: 'hn-top' }} thread="close" pair={PAIR} state="done" />
        {/* A DIFFERENT worker, to prove the key is per-pair and not "every card". */}
        <ChatMentionCard chat={{ name: 'other' }} thread="open" pair="other:1" state="started" />
        {/* A launch still RUNNING: no partner in the log, so no key at all. */}
        <ChatMentionCard chat={{ name: 'running' }} state="started" />
      </>,
    );
  });
}

const cards = () => [...(container?.querySelectorAll('.chat-mention-card') ?? [])];
const lit = () => cards().filter((c) => c.getAttribute('data-paired') === 'true').length;

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

describe('hovering one end of a pair lights the other', () => {
  it('lights BOTH ends, and only those', () => {
    return mountPair().then(() => {
      const [open] = cards();
      expect(lit()).toBe(0);
      act(() => {
        open?.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
      });
      expect(lit()).toBe(2);
      for (const c of cards()) {
        expect(c.getAttribute('data-paired') === 'true').toBe(c.getAttribute('data-pair') === PAIR);
      }
    });
  });

  it('goes dark again on leave — it is a hint, not a selection', () => {
    return mountPair().then(() => {
      const [open] = cards();
      act(() => {
        open?.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
      });
      expect(lit()).toBe(2);
      act(() => {
        open?.dispatchEvent(new PointerEvent('pointerout', { bubbles: true }));
      });
      expect(lit()).toBe(0);
    });
  });

  it('works from the OTHER end too — the relationship has no direction', () => {
    return mountPair().then(() => {
      const close = cards()[1];
      act(() => {
        close?.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
      });
      expect(lit()).toBe(2);
    });
  });

  it('a KEYBOARD reader gets the same answer', () => {
    // React's onFocus is focusin, which bubbles — so tabbing to the card's own
    // open button lights the pair, not just focusing the card itself.
    return mountPair().then(() => {
      const [open] = cards();
      act(() => {
        open?.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
      });
      expect(lit()).toBe(2);
      act(() => {
        open?.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      });
      expect(lit()).toBe(0);
    });
  });

  it('an UNPAIRED card carries no key, and hovering it lights nothing', () => {
    // A launch still running has no partner in the log — ChatPane passes `pair`
    // exactly when it passes `thread`, because a key with one end is a key for
    // nothing and a stub is a line to nowhere.
    return mountPair().then(() => {
      const running = cards()[3];
      expect(running?.hasAttribute('data-pair')).toBe(false);
      act(() => {
        running?.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
      });
      expect(lit()).toBe(0);
    });
  });

  it('a LONE key lights only itself — one end is not a pair', () => {
    return mountPair().then(() => {
      const lone = cards()[2];
      expect(lone?.getAttribute('data-pair')).toBe('other:1');
      act(() => {
        lone?.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
      });
      expect(lit()).toBe(1);
    });
  });
});
