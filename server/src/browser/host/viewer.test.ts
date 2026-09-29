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
  /** Every socket the page has opened, oldest first. */
  sockets: Array<Record<string, unknown>>;
  /** Fire `open` on the newest socket. */
  open(): void;
  /** Fire `close` on the newest socket, as a dropped connection does. */
  drop(): void;
  /** Pending timers, so a test can see the backoff rather than only its effect. */
  timers: Array<{ fn: () => void; ms: number }>;
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

  const timers: Array<{ fn: () => void; ms: number }> = [];
  const sent: Array<Record<string, unknown>> = [];
  const socketListeners = new Map<string, Array<(e: unknown) => void>>();
  const clipboard = { text: 'hunter2', reads: 0 };

  // Every socket the page opens, in order. The page reconnects, so "the socket"
  // is not a thing — the LATEST one is.
  const sockets: Array<Record<string, unknown>> = [];
  const makeSocket = (): Record<string, unknown> => {
    const sock: Record<string, unknown> = {
      readyState: 1,
      onmessage: null,
      onopen: null,
      onclose: null,
      onerror: null,
      send: (raw: string) => sent.push(JSON.parse(raw)),
      close() {},
      addEventListener(type: string, fn: (e: unknown) => void) {
        const list = socketListeners.get(type) ?? [];
        list.push(fn);
        socketListeners.set(type, list);
      },
    };
    sockets.push(sock);
    return sock;
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
      return makeSocket();
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
    // A clock the test drives. The reconnect backs off with setTimeout, so a
    // stub that never fires makes a page that never reconnects look identical
    // to one that does.
    setTimeout: (fn: () => void, ms: number) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearTimeout: (id: number) => {
      if (timers[id - 1]) timers[id - 1] = { fn: () => {}, ms: 0 };
    },
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

  // The page dials on load; open it so handlers that wait for a connection run.
  const live = () => sockets[sockets.length - 1];
  const open = () => (live()?.onopen as (() => void) | undefined)?.();
  open();

  return {
    el,
    sent,
    sockets,
    open,
    drop() {
      const sock = live();
      (sock?.onclose as (() => void) | undefined)?.();
      // The retry is scheduled, not immediate — run the clock so the dial happens.
      for (const t of timers.splice(0)) t.fn();
    },
    timers,
    receive(msg) {
      // The script assigns `ws.onmessage` rather than adding a listener. Getting
      // this wrong made a passing harness that delivered nothing — every
      // assertion about a received message was vacuously true.
      const handler = live()?.onmessage as ((e: unknown) => void) | null;
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

/**
 * A tap cannot be placed on the page until the viewer knows the size of the
 * frame it is showing — until then it maps to nothing and every tap is a guess.
 * This is what a viewer looks like once one frame has arrived.
 */
function ready(h: Harness): Harness {
  const img = h.el('screen') as unknown as { naturalWidth: number; naturalHeight: number };
  img.naturalWidth = 390;
  img.naturalHeight = 844;
  h.el('screen').fire('load');
  h.receive({ t: 'frame', meta: { deviceWidth: 390, deviceHeight: 844 } });
  return h;
}

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

  it('raises NOTHING for a tap outside every known text field', () => {
    // The whole point of the host shipping field boxes. Without them the tap
    // focuses optimistically and the page's answer takes it back a third of a
    // second later, so tapping a link slides a keyboard up and then down again.
    const h = ready(run());
    h.receive({ t: 'fields', rects: [[0, 0, 100, 50]] });
    h.el('screen').fire('pointerdown', { clientX: 300, clientY: 300, button: 0 });
    expect(h.el('sink').focused).toBe(false);
  });

  it('raises one for a tap INSIDE a known text field, with no round trip', () => {
    const h = ready(run());
    h.receive({ t: 'fields', rects: [[0, 0, 100, 50]] });
    h.el('screen').fire('pointerdown', { clientX: 20, clientY: 20, button: 0 });
    expect(h.el('sink').focused).toBe(true);
  });

  it('still guesses before any boxes have arrived', () => {
    // Unknown is not "no fields". A keyboard that flashes is a blemish; one that
    // never appears is the bug this all started as.
    const h = ready(run());
    h.el('screen').fire('pointerdown', { clientX: 300, clientY: 300, button: 0 });
    expect(h.el('sink').focused).toBe(true);
  });

  it('KEEPS the keyboard when the page contradicts a tap on a known field', () => {
    // The page's answer cannot see into a cross-origin frame, so its "no" is
    // sometimes ignorance rather than information — and acting on it takes the
    // keyboard away from somebody who has just tapped a login box. Measured on
    // the real browser: an input inside an iframe or a shadow root reports
    // activeElement as the frame or the host element, and answers "not
    // editable" for a field the person is looking straight at.
    const h = ready(run());
    h.receive({ t: 'fields', rects: [[0, 0, 100, 50]] });
    h.el('screen').fire('pointerdown', { clientX: 20, clientY: 20, button: 0 });
    expect(h.el('sink').focused).toBe(true);
    h.receive({ t: 'focus', editable: false });
    expect(h.el('sink').focused).toBe(true);
  });

  it('still takes it back when the tap was NOT on a known field', () => {
    // The guess must still be correctable, or every tap anywhere leaves a
    // keyboard up over a page that ignores typing.
    const h = ready(run());
    h.el('screen').fire('pointerdown', { clientX: 300, clientY: 300, button: 0 });
    expect(h.el('sink').focused).toBe(true);
    h.receive({ t: 'focus', editable: false });
    expect(h.el('sink').focused).toBe(false);
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

describe('a connection that drops', () => {
  /**
   * It used to be opened once and, on close, replaced by "disconnected — the
   * browser may have restarted". True and useless: the page then sat on a frozen
   * image with an error across it until somebody reloaded, and EVERYTHING closes
   * this socket sooner or later — a phone locking, wifi changing hands, the
   * tailnet reconnecting, the cockpit restarting.
   */
  it('dials again instead of giving up', () => {
    const h = run();
    expect(h.sockets).toHaveLength(1);
    h.drop();
    expect(h.sockets.length).toBeGreaterThan(1);
  });

  it('says it is coming back, not that it is gone', () => {
    const h = run();
    h.drop();
    expect(h.el('msg').textContent).toMatch(/reconnect/i);
    expect(h.el('msg').textContent).not.toMatch(/disconnected/i);
  });

  it('clears the message once it is back', () => {
    const h = run();
    h.drop();
    h.open();
    expect(h.el('msg').textContent).toBe('');
  });

  it('ignores a late close from a socket it already replaced', () => {
    // Otherwise the dead socket queues a second dial, the two race, and the
    // page ends up opening sockets faster than it closes them.
    const h = run();
    const stale = h.sockets[0];
    h.drop();
    const after = h.sockets.length;
    (stale?.onclose as (() => void) | undefined)?.();
    expect(h.sockets).toHaveLength(after);
  });

  it('tells the new host it is a phone again', () => {
    // A restarted host remembers nothing it was told. Reconnecting into a
    // 1280px page on a phone is the bug the mobile toggle exists to fix,
    // arriving later and looking like a different one.
    const h = run();
    const mobileAsks = () => h.sent.filter((m) => m.t === 'emulate').length;
    const before = mobileAsks();
    h.drop();
    h.open();
    expect(mobileAsks()).toBeGreaterThan(before);
  });
});
