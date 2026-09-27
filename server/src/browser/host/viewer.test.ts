import { describe, expect, it } from 'vitest';
import { VIEWER_HTML } from './viewer.js';

/**
 * The viewer's own script, EXECUTED.
 *
 * Why this file exists rather than a few `includes()` assertions: the two bugs
 * this page has actually shipped were both behavioural and both invisible to a
 * string match.
 *
 *   · The keyboard never appeared on a phone. The code called `focus()` — a
 *     grep for it passed — but called it from a WebSocket message, and iOS
 *     raises a keyboard only for a focus that happens DURING a user gesture.
 *     The bug was WHEN, not whether.
 *   · Twice the inlined template literal was broken by a stray backtick, which
 *     ships a syntactically dead page that every test still passed.
 *
 * So the script is pulled out of the HTML, run against a DOM stub, and poked.
 * `new Function` on our own build-time constant, in a test — not user input.
 */

function script(): string {
  const found = [...VIEWER_HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  if (found.length !== 1) throw new Error(`expected one script, found ${found.length}`);
  return found[0]?.[1] ?? '';
}

interface StubEl {
  id: string;
  focused: boolean;
  focusCount: number;
  attrs: Record<string, string>;
  value: string;
  style: Record<string, string>;
  hidden: boolean;
  textContent: string;
  fire(type: string, event?: Record<string, unknown>): void;
}

interface Harness {
  el(id: string): StubEl;
  /** Messages the page sent to the host. */
  sent: Array<Record<string, unknown>>;
  /** Push a message from the host to the page. */
  receive(msg: Record<string, unknown>): void;
  clipboard: { text: string; reads: number };
}

function run(search = ''): Harness {
  const els = new Map<string, StubEl>();
  const make = (id: string): StubEl => {
    const listeners = new Map<string, Array<(e: unknown) => void>>();
    const el: StubEl & { addEventListener: unknown } = {
      id,
      focused: false,
      focusCount: 0,
      attrs: {},
      value: '',
      style: {},
      hidden: false,
      textContent: '',
      // Anything the script reads off an element it never asserts on.
      naturalWidth: 0,
      naturalHeight: 0,
      width: 390,
      height: 844,
      files: [],
      classList: { add() {}, remove() {}, toggle() {} },
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 390, height: 844 }),
      setAttribute(k: string, v: string) {
        el.attrs[k] = v;
      },
      getAttribute: (k: string) => el.attrs[k] ?? null,
      removeAttribute(k: string) {
        delete el.attrs[k];
      },
      focus() {
        el.focused = true;
        el.focusCount++;
      },
      blur() {
        el.focused = false;
        for (const fn of listeners.get('blur') ?? []) fn({});
      },
      setPointerCapture() {},
      releasePointerCapture() {},
      click() {},
      addEventListener(type: string, fn: (e: unknown) => void) {
        const list = listeners.get(type) ?? [];
        list.push(fn);
        listeners.set(type, list);
      },
      removeEventListener() {},
      fire(type: string, event: Record<string, unknown> = {}) {
        const e = { preventDefault() {}, stopPropagation() {}, ...event };
        for (const fn of [...(listeners.get(type) ?? [])]) fn(e);
      },
    } as unknown as StubEl & { addEventListener: unknown };
    return el as StubEl;
  };
  const el = (id: string): StubEl => {
    const found = els.get(id) ?? make(id);
    els.set(id, found);
    return found;
  };

  const sent: Array<Record<string, unknown>> = [];
  const socketListeners = new Map<string, Array<(e: unknown) => void>>();
  const clipboard = { text: 'hunter2', reads: 0 };

  const ws: Record<string, unknown> = {
    readyState: 1,
    onmessage: null,
    send: (raw: string) => sent.push(JSON.parse(raw)),
    close() {},
    addEventListener(type: string, fn: (e: unknown) => void) {
      const list = socketListeners.get(type) ?? [];
      list.push(fn);
      socketListeners.set(type, list);
    },
  };

  const globals = {
    document: {
      getElementById: el,
      addEventListener() {},
      body: el('body'),
      documentElement: el('html'),
      createElement: () => make('made'),
      hidden: false,
    },
    location: { pathname: '/browser/default/', host: 'h', protocol: 'https:', search },
    WebSocket: function WS() {
      return ws;
    },
    navigator: {
      clipboard: {
        readText: async () => {
          clipboard.reads++;
          return clipboard.text;
        },
      },
      maxTouchPoints: 5,
    },
    URLSearchParams,
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    requestAnimationFrame: () => 0,
    URL: { createObjectURL: () => 'blob:', revokeObjectURL: () => {} },
    addEventListener: () => {},
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    console: { log() {}, warn() {}, error() {} },
    innerWidth: 390,
    innerHeight: 844,
    devicePixelRatio: 3,
  } as Record<string, unknown>;
  // The script reaches for `window.x` as well as bare `x`; point it at itself so
  // both spellings resolve to the same stub.
  globals.window = globals;
  globals.visualViewport = {
    height: 844,
    addEventListener() {},
    removeEventListener() {},
  };

  // eslint-disable-next-line no-new-func
  new Function(...Object.keys(globals), script())(...Object.values(globals));

  return {
    el,
    sent,
    receive(msg) {
      // The script assigns `ws.onmessage` rather than adding a listener. Getting
      // this wrong made a passing harness that delivered nothing — every
      // assertion about a received message was vacuously true.
      const handler = ws.onmessage as ((e: unknown) => void) | null;
      if (!handler) throw new Error('nothing is listening for host messages');
      handler({ data: JSON.stringify(msg) });
      for (const fn of socketListeners.get('message') ?? []) fn({ data: JSON.stringify(msg) });
    },
    clipboard,
  };
}

describe('the page is alive at all', () => {
  it('parses and runs', () => {
    // Two shipped pages were syntactically dead from a stray backtick inside
    // the template literal that builds this HTML. Every other test passed.
    expect(() => run()).not.toThrow();
  });
});

describe('the keyboard on a phone', () => {
  it('focuses the text sink DURING the tap, not after the page replies', () => {
    // THE BUG. iOS raises a keyboard only for a focus() issued inside a real
    // user gesture. Focusing when the host later reports "an input is focused"
    // is too late — it is silently ignored and no keyboard ever appears. So the
    // focus has to happen on the tap itself, before any round trip.
    const h = run();
    h.el('screen').fire('pointerdown', { clientX: 10, clientY: 10, button: 0 });
    expect(h.el('sink').focused).toBe(true);
  });

  it('keeps it up when the page confirms a text field', () => {
    const h = run();
    h.el('screen').fire('pointerdown', { clientX: 10, clientY: 10, button: 0 });
    h.receive({ t: 'focus', editable: true });
    expect(h.el('sink').focused).toBe(true);
  });

  it('takes it back when the tap was not on a text field', () => {
    // The flip side of focusing optimistically: tapping a link must not leave a
    // keyboard covering half the page.
    const h = run();
    h.el('screen').fire('pointerdown', { clientX: 10, clientY: 10, button: 0 });
    h.receive({ t: 'focus', editable: false });
    expect(h.el('sink').focused).toBe(false);
  });

  it('but never takes it back when you raised it by hand', () => {
    // Some pages accept typing without focusing anything the host can see. The
    // button is the override, and a focus report must not undo it.
    const h = run();
    h.el('kb').fire('click');
    expect(h.el('sink').focused).toBe(true);
    h.receive({ t: 'focus', editable: false });
    expect(h.el('sink').focused).toBe(true);
  });

  it('does not raise one while you are only watching', () => {
    // Watch mode takes no wheel and sends no input. A keyboard there offers to
    // type into a page that will ignore it.
    const h = run('?mode=watch');
    h.el('screen').fire('pointerdown', { clientX: 10, clientY: 10, button: 0 });
    expect(h.el('sink').focused).toBe(false);
  });
});

describe('paste', () => {
  it('reads the clipboard and sends it as text', () => {
    // A phone cannot paste into the stream: the sink is off-screen, so the
    // system paste menu has nothing to appear over, and a password manager
    // fills the wrong page. Reading it here is the only route that works.
    const h = run();
    h.el('paste').fire('click');
    return Promise.resolve().then(() => {
      expect(h.clipboard.reads).toBe(1);
      expect(h.sent).toContainEqual({ t: 'text', text: 'hunter2' });
    });
  });

  it('says so when the browser refuses the clipboard', async () => {
    const h = run();
    h.clipboard.text = '';
    h.el('paste').fire('click');
    await Promise.resolve();
    expect(h.sent.filter((m) => m.t === 'text')).toEqual([]);
  });

  it('treats Cmd+V as a paste rather than forwarding the keystroke', async () => {
    // Forwarded, it reaches the REMOTE Chrome and pastes from its clipboard,
    // which is empty — the gesture appears to do nothing at all.
    const h = run();
    h.el('screen').fire('keydown', { key: 'v', metaKey: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(h.sent).toContainEqual({ t: 'text', text: 'hunter2' });
    expect(h.sent.filter((m) => m.t === 'key')).toEqual([]);
  });

  it('still forwards a plain v', async () => {
    const h = run();
    h.el('screen').fire('keydown', { key: 'v' });
    expect(h.sent.some((m) => m.t === 'key' && m.key === 'v')).toBe(true);
    expect(h.clipboard.reads).toBe(0);
  });

  it('pastes nothing while you are only watching', async () => {
    const h = run('?mode=watch');
    h.el('paste').fire('click');
    await Promise.resolve();
    expect(h.clipboard.reads).toBe(0);
  });
});
