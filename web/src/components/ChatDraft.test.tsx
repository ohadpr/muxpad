import { act, createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DRAFT_TOKEN_ATTR } from '../lib/chat-draft';
import type { MentionChat } from '../lib/chat-mention';
import { ChatDraft, type ChatDraftHandle } from './ChatDraft';

/**
 * THE COMPOSER DRAWS THE CHIP WHILE YOU ARE STILL TYPING.
 *
 * The bug this defends: picking a chat from the `@` picker left the literal text
 * `@Investing` in the composer, and only the SENT message drew it as a chip. The
 * claims worth holding, in the order they matter:
 *
 *   1. a resolvable mention is a chip in the draft, drawn by the same component
 *      the log draws (not a lookalike);
 *   2. the draft is still exactly the string the user typed — the chip stands
 *      for its token and changes nothing about what gets sent;
 *   3. typing prose does NOT rebuild the DOM, because a rebuild moves the caret
 *      and the browser has already put the caret in the right place.
 *
 * A real DOM rather than static markup, unlike the other `@` tests: the whole
 * subject here is a child list React does not own and an effect that decides
 * whether to touch it, neither of which exists in a string.
 */

function chat(tabId: string, tabName: string): MentionChat {
  return {
    tabId,
    tabSlug: tabId,
    tabName,
    workspaceId: 'w1',
    workspaceSlug: 'personal',
    workspaceName: 'Personal',
    paneIds: [`${tabId}-pane`],
    chip: { name: tabName, icon: '📈' },
  };
}

const CORPUS = [chat('t1', 'Investing'), chat('t2', 'Main repo')];

interface Mounted {
  el: HTMLElement;
  root: HTMLDivElement;
  handle: ChatDraftHandle;
  /** Re-render with a new value / corpus, as ChatPane's state changes would. */
  set(next: { value?: string; corpus?: readonly MentionChat[] }): void;
  onChange: ReturnType<typeof vi.fn>;
}

const mounted: Array<() => void> = [];
afterEach(() => {
  for (const un of mounted.splice(0)) un();
});

function mount(value: string, corpus: readonly MentionChat[] = CORPUS): Mounted {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const ref = createRef<ChatDraftHandle>();
  const onChange = vi.fn();
  let state = { value, corpus };
  const draw = () =>
    act(() => {
      root.render(
        <ChatDraft
          ref={ref}
          value={state.value}
          corpus={state.corpus}
          placeholder="Message Chat…"
          onChange={onChange}
          onCaret={() => {}}
        />,
      );
    });
  draw();
  mounted.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  const el = host.querySelector('.chat-draft') as HTMLElement;
  return {
    el,
    root: host as HTMLDivElement,
    handle: ref.current as ChatDraftHandle,
    onChange,
    set: (next) => {
      state = { ...state, ...next };
      draw();
    },
  };
}

/** The chip hosts in the child list, in order. */
const hosts = (el: HTMLElement) => [...el.querySelectorAll(`[${DRAFT_TOKEN_ATTR}]`)];

/**
 * Type `more` at the end of the draft, the way a browser does it.
 *
 * jsdom has no editing engine, so the three steps a real keystroke takes are
 * spelled out: the browser mutates a text node in place, fires `input`, and the
 * component's own reader is what turns that back into a string. Then ChatPane's
 * half — storing the reported text and re-rendering with it — closes the loop.
 * Doing it this way is the point: it is the round trip, not the component in
 * isolation, that has to leave the caret alone.
 */
function type(current: string, m: Mounted, more: string): void {
  const last = m.el.lastChild as Text;
  last.data += more;
  const sel = window.getSelection();
  const range = document.createRange();
  range.setStart(last, last.data.length);
  range.collapse(true);
  sel?.removeAllRanges();
  sel?.addRange(range);
  act(() => {
    m.el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const reported = m.onChange.mock.lastCall?.[0] as string;
  expect(reported).toBe(current + more);
  m.set({ value: reported });
}

describe('a picked mention is a chip, immediately', () => {
  it('renders the resolvable mention as a chip host carrying its token', () => {
    const { el } = mount('Ask @Investing about cash');
    expect(hosts(el).map((h) => h.getAttribute(DRAFT_TOKEN_ATTR))).toEqual(['@Investing']);
  });

  it('draws it with the SAME pill the log draws', () => {
    // The point of the portal. Hand-written chip markup here would pass a
    // "there is a chip" test and fork the one visual primitive four surfaces
    // share — which is exactly what ChatChip.tsx's header forbids.
    const { el } = mount('Ask @Investing about cash');
    const pill = el.querySelector('.chat-mention-pill');
    expect(pill).not.toBeNull();
    expect(pill?.querySelector('.chatchip')?.getAttribute('data-density')).toBe('chip');
    expect(pill?.querySelector('.chatchip-glyph')?.textContent).toBe('📈');
  });

  it('leaves the draft string exactly as typed', () => {
    // The chip stands for `@Investing`; the pill reads "📈Investing". If the
    // reader ever took the second for the first, sending would rewrite the
    // user's message.
    const { el, handle } = mount('Ask @Investing about cash');
    expect(handle.caret()).toBe('Ask @Investing about cash'.length);
    expect(el.textContent).not.toBe('Ask @Investing about cash'); // the pill is in there
  });

  it('leaves an unresolvable `@word` as plain text', () => {
    const { el } = mount('email me @ohad later');
    expect(hosts(el)).toHaveLength(0);
    expect(el.textContent).toBe('email me @ohad later');
  });

  it('makes the chip atomic and untabbable', () => {
    // contentEditable=false is what makes one Backspace delete the whole
    // mention instead of eating into a rendered pill; `inert` is what stops the
    // <button> inside from being a second tab stop in the composer.
    const { el } = mount('Ask @Investing');
    const host = hosts(el)[0] as HTMLElement;
    expect(host.getAttribute('contenteditable')).toBe('false');
    expect(host.hasAttribute('inert')).toBe(true);
  });
});

describe('the DOM is rebuilt only when the chips change', () => {
  it('keeps the very same host node while only prose changes', () => {
    // THE caret guarantee, stated as node identity: a rebuild replaces the
    // children, which moves the caret, which undoes the browser's own editing
    // under the user. Typing after a mention must touch nothing.
    //
    // Driven through the REAL loop, because that is where the guarantee lives:
    // the browser edits a text node and fires `input`; the component reads the
    // draft back out and reports it; ChatPane stores it and re-renders with it.
    // A test that skipped the first two steps would be asserting against the
    // model-driven path, which rebuilds on purpose.
    const m = mount('Ask @Investing about');
    const before = hosts(m.el)[0];
    type('Ask @Investing about', m, ' cash position');
    expect(hosts(m.el)[0]).toBe(before);
    expect(m.onChange).toHaveBeenLastCalledWith('Ask @Investing about cash position', 34);
  });

  it('rebuilds when a mention finishes being typed', () => {
    const m = mount('Ask @Investin');
    expect(hosts(m.el)).toHaveLength(0);
    m.set({ value: 'Ask @Investing' });
    expect(hosts(m.el).map((h) => h.getAttribute(DRAFT_TOKEN_ATTR))).toEqual(['@Investing']);
  });

  it('rebuilds when the corpus arrives late, without touching the draft', () => {
    // The common case for a draft restored from localStorage: the corpus is
    // fetched on the first `@` and lands a moment later, and the text that was
    // plain has to become a chip without the value changing or an edit firing.
    const m = mount('Ask @Investing about cash', []);
    expect(hosts(m.el)).toHaveLength(0);
    m.set({ corpus: CORPUS });
    expect(hosts(m.el)).toHaveLength(1);
    expect(m.onChange).not.toHaveBeenCalled();
  });
});

describe('the caret is restored only once the chips are DRAWN', () => {
  /**
   * THE REGRESSION, and it made the composer unusable on iOS.
   *
   * Typing `@Investing` and then a space left the draft reading ` @Investing`:
   * the space at the HEAD of the message, and every character after it too.
   * Measured in WebKit — Safari, and therefore every browser on iOS — where 7
   * of 10 end-to-end typing scenarios put the text at offset 0. Chromium is
   * unaffected, which is how it shipped: it was verified there.
   *
   * THE CAUSE is an ordering, not arithmetic. The reconcile built the child
   * list, restored the caret, and only THEN let React portal the pill into the
   * (empty) chip host. A caret beside a chip has no text node to live in, so it
   * is a position BETWEEN CHILDREN of the editable; WebKit holds its editing
   * caret as a rendered position rather than as that DOM offset and re-derives
   * it when the tree under the editable changes, so the portal's insertion
   * invalidated a caret placed one commit too early and WebKit re-resolved it
   * to the start. The DOM Range still read back as the position we set — which
   * is why nothing in the component could detect it, and why only the NEXT
   * keystroke showed it.
   *
   * jsdom has no editing engine, so what is asserted here is the ORDERING
   * itself, which is the defect: at the instant the selection is set, every
   * chip host must already hold its pill. Watched fail first — before the fix
   * the recorded host is empty.
   */
  function hostFillWhenCaretPlaced(m: Mounted, value: string): number[] {
    const sel = window.getSelection() as Selection;
    const proto = Object.getPrototypeOf(sel) as Selection;
    const real = proto.addRange;
    const seen: number[] = [];
    proto.addRange = function patched(this: Selection, r: Range) {
      seen.push(...hosts(m.el).map((h) => h.childNodes.length));
      return real.call(this, r);
    };
    try {
      m.set({ value });
    } finally {
      proto.addRange = real;
    }
    return seen;
  }

  it('never sets the selection while a chip host is still empty', () => {
    const m = mount('');
    act(() => m.el.focus());
    expect(document.activeElement).toBe(m.el);
    const filled = hostFillWhenCaretPlaced(m, '@Investing');
    // The caret WAS restored (the field is focused and the chips changed)…
    expect(filled.length).toBeGreaterThan(0);
    // …and not once against a host React had not drawn into yet.
    expect(filled).not.toContain(0);
  });

  it('still lands the caret where the model asks', () => {
    // The deferral must not cost the restore itself: an outside `setInput` puts
    // the caret at the end, chip or no chip.
    const m = mount('');
    act(() => m.el.focus());
    m.set({ value: 'Ask @Investing' });
    expect(m.handle.caret()).toBe('Ask @Investing'.length);
  });
});

describe('the caret is addressed in string offsets', () => {
  it('setCaret past a chip lands after it, not ten characters into it', () => {
    // What `pickMention` does the frame after inserting a token. The offset is
    // into the STRING (`'Ask @Investing '`.length), and there is no such DOM
    // position inside an atomic chip — mapping it is the whole job.
    const m = mount('Ask @Investing rest');
    act(() => m.handle.setCaret(15));
    expect(m.handle.caret()).toBe(15);
  });

  it('reports the end of the draft when nothing is focused', () => {
    const m = mount('Ask @Investing rest');
    expect(m.handle.caret()).toBe('Ask @Investing rest'.length);
  });
});

describe('the placeholder', () => {
  it('is shown only while the draft is empty', () => {
    // `:empty` cannot drive this — a contenteditable that has been typed in and
    // emptied keeps stray nodes — so the class is driven off the value.
    const m = mount('');
    expect(m.el.className).toContain('is-empty');
    expect(m.el.dataset.placeholder).toBe('Message Chat…');
    m.set({ value: 'x' });
    expect(m.el.className).not.toContain('is-empty');
  });
});
