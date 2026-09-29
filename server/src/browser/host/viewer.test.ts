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
  /** Every fetch the page made, so a test can see what it asked the server for. */
  fetches: Array<{ url: string; method?: string; body?: string }>;
  /** Runs the page's intervals once, and settles what they started. */
  tickTimers(): Promise<void>;
  /** Lets async handlers finish before asserting on what they did. */
  settle(): Promise<void>;
  /** Messages the page sent to the host. */
  sent: Array<Record<string, unknown>>;
  /** Push a message from the host to the page. */
  receive(msg: Record<string, unknown>): void;
  clipboard: { text: string; reads: number };
}

interface RunOpts {
  search?: string;
  /** What every fetch resolves to, so the wheel state can be posed. */
  fetchJson?: unknown;
  /** A fixed clock, so a lease can be put past its halfway point. */
  nowMs?: number;
  /** Whether fetches succeed, so a refusal can be posed. */
  fetchOk?: boolean;
}

function run(opts: RunOpts | string = {}): Harness {
  const {
    search = '',
    fetchJson = {},
    nowMs,
    fetchOk = true,
  } = typeof opts === 'string' ? { search: opts } : opts;
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
      listenerCount(type: string) {
        return (listeners.get(type) ?? []).length;
      },
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
  const fetches: Array<{ url: string; method?: string; body?: string }> = [];
  const intervals: Array<{ fn: () => void; ms: number }> = [];
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
    fetch: async (url: string, init?: { method?: string; body?: string }) => {
      fetches.push({ url: String(url), ...(init ?? {}) });
      return { ok: fetchOk, json: async () => fetchJson };
    },
    Date: nowMs === undefined ? Date : { ...Date, now: () => nowMs },
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
    // Intervals are collected, not run — a test drives them with tickTimers so
    // a thirty-second renewal loop does not take thirty seconds to observe.
    setInterval: (fn: () => void, ms: number) => {
      intervals.push({ fn, ms });
      return intervals.length;
    },
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
    fetches,
    async settle() {
      // Two awaited fetches deep in some handlers; a handful of microtasks is
      // not enough, and a test that under-settles reads as a handler that never
      // ran.
      for (let i = 0; i < 4; i++) {
        await new Promise((r) => setImmediate(r));
        for (let n = 0; n < 8; n++) await Promise.resolve();
      }
    },
    async tickTimers() {
      for (const t of intervals) t.fn();
      // The handlers are async; let their promises settle before asserting.
      for (let i = 0; i < 4; i++) {
        await new Promise((r) => setImmediate(r));
        for (let n = 0; n < 8; n++) await Promise.resolve();
      }
    },
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

describe('where a tap lands on the page', () => {
  /**
   * The viewer maps a tap on a JPEG to a point in a page, and nothing has ever
   * checked the arithmetic. Every click, drag and keyboard-raising tap goes
   * through it, so being a few percent out is a browser that almost works.
   */
  const framed = (
    natural: { w: number; h: number },
    rendered: { w: number; h: number },
    device: { w: number; h: number },
  ) => {
    const h = run();
    const img = h.el('screen') as unknown as {
      naturalWidth: number;
      naturalHeight: number;
      getBoundingClientRect: () => { left: number; top: number; width: number; height: number };
    };
    img.naturalWidth = natural.w;
    img.naturalHeight = natural.h;
    img.getBoundingClientRect = () => ({ left: 0, top: 0, width: rendered.w, height: rendered.h });
    h.el('screen').fire('load');
    h.receive({ t: 'frame', meta: { deviceWidth: device.w, deviceHeight: device.h } });
    return h;
  };
  const tapAt = (h: ReturnType<typeof run>, x: number, y: number) => {
    h.el('screen').fire('pointerdown', { clientX: x, clientY: y, button: 0 });
    return h.sent.filter((m) => m.t === 'mouse').at(-1) as { x: number; y: number } | undefined;
  };

  it('maps the middle of the picture to the middle of the page', () => {
    // A phone: 3x pixels, shown at CSS size, page 390x844.
    const h = framed({ w: 1170, h: 2532 }, { w: 390, h: 844 }, { w: 390, h: 844 });
    const p = tapAt(h, 195, 422);
    expect(Math.round(p?.x ?? -1)).toBe(195);
    expect(Math.round(p?.y ?? -1)).toBe(422);
  });

  it('maps correctly when the picture is SHRUNK to fit', () => {
    // Desktop: a 1280x800 page shown in a 640px-wide panel. Half size, so a tap
    // at 320 is the middle of the page.
    const h = framed({ w: 1280, h: 800 }, { w: 640, h: 400 }, { w: 1280, h: 800 });
    const p = tapAt(h, 320, 200);
    expect(Math.round(p?.x ?? -1)).toBe(640);
    expect(Math.round(p?.y ?? -1)).toBe(400);
  });

  it('maps the VERTICAL axis by the vertical scale, not the horizontal one', () => {
    // The two are only interchangeable while the frame's aspect matches the
    // viewport's exactly. Chrome caps screencast frames, and the moment it does
    // — or a page is unusually tall — a y computed from the WIDTH ratio is
    // silently wrong, and every tap lands above or below what was aimed at.
    const h = framed({ w: 800, h: 400 }, { w: 800, h: 400 }, { w: 800, h: 1600 });
    const p = tapAt(h, 400, 200);
    expect(Math.round(p?.x ?? -1)).toBe(400);
    expect(Math.round(p?.y ?? -1)).toBe(800);
  });

  it('sends nothing before a frame has arrived', () => {
    // No size, no map. A guess here is a click somewhere the person did not aim.
    const h = run();
    expect(tapAt(h, 10, 10)).toBeUndefined();
  });
});

describe('keeping the wheel while somebody is holding it', () => {
  /**
   * The lease lapses after ten minutes so a person who falls asleep holding the
   * browser does not own it forever. Renewal lived only in the DESKTOP modal,
   * and on a phone the card opens THIS page in a tab — so nothing renewed. Ten
   * minutes is nothing for a real login: a password manager, a code from an
   * email, two-factor on another device. Past that an agent could claim the
   * browser and navigate the page out from under somebody still typing into it.
   */
  it('renews once the lease is past halfway', async () => {
    const h = run({
      fetchJson: { wheel: { holder: 'human', by: 'pane-7', takenAt: 0, expiresAt: 1000 } },
      nowMs: 900,
    });
    await h.tickTimers();
    expect(h.fetches.some((f) => f.url.endsWith('/wheel/renew'))).toBe(true);
  });

  it('leaves a fresh lease alone', async () => {
    // A renewal per tick is a request every thirty seconds for nothing.
    const h = run({
      fetchJson: { wheel: { holder: 'human', by: 'pane-7', takenAt: 0, expiresAt: 1000 } },
      nowMs: 100,
    });
    await h.tickTimers();
    expect(h.fetches.some((f) => f.url.endsWith('/wheel/renew'))).toBe(false);
  });

  it('renews on behalf of whoever holds it, not as itself', async () => {
    // This page usually did not take the wheel — the card did. Renewing as
    // somebody else is refused by the server, which is the same as not renewing.
    const h = run({
      fetchJson: { wheel: { holder: 'human', by: 'pane-7', takenAt: 0, expiresAt: 1000 } },
      nowMs: 900,
    });
    await h.tickTimers();
    const renew = h.fetches.find((f) => f.url.endsWith('/wheel/renew'));
    expect(JSON.parse(renew?.body ?? '{}')).toMatchObject({ by: 'pane-7' });
  });

  it('never renews an AGENT’s hold', async () => {
    const h = run({
      fetchJson: { wheel: { holder: 'agent', by: 'agent-1', takenAt: 0, expiresAt: 1000 } },
      nowMs: 900,
    });
    await h.tickTimers();
    expect(h.fetches.some((f) => f.url.endsWith('/wheel/renew'))).toBe(false);
  });

  it('never renews while only watching', async () => {
    // Watching takes no wheel and must not extend anybody else's.
    const h = run({
      search: '?mode=watch',
      fetchJson: { wheel: { holder: 'human', by: 'pane-7', takenAt: 0, expiresAt: 1000 } },
      nowMs: 900,
    });
    await h.tickTimers();
    expect(h.fetches.some((f) => f.url.endsWith('/wheel/renew'))).toBe(false);
  });
});

describe('handing the browser back', () => {
  /**
   * Closing the desktop modal releases the wheel. Closing a tab on a phone does
   * nothing — so there was no gesture for "I have finished" at all, and the
   * agent waited out the whole lease: up to ten minutes of nothing at the end of
   * every handoff, on the surface the handoff was built for.
   */
  it('offers a way out while driving', () => {
    const h = run();
    expect(h.el('handback').hidden).toBe(false);
  });

  it('offers none while only watching — there is nothing to give back', () => {
    const h = run({ search: '?mode=watch' });
    expect(h.el('handback').hidden).toBe(true);
  });

  it('releases the lease of whoever actually holds it', async () => {
    // This page usually did not take the wheel; the card did. Releasing as
    // somebody else is refused, which is the same as not releasing.
    const h = run({
      fetchJson: { wheel: { holder: 'human', by: 'pane-7', takenAt: 0, expiresAt: 1000 } },
    });
    h.el('handback').fire('click');
    await h.settle();
    const release = h.fetches.find((f) => f.method === 'DELETE');
    expect(release?.url).toContain('/wheel');
    expect(JSON.parse(release?.body ?? '{}')).toMatchObject({ by: 'pane-7' });
  });

  it('keeps showing the page afterwards, as a watcher', async () => {
    // Finishing is not leaving. You may well want to see what the agent does
    // next with what you just unlocked.
    const h = run({
      fetchJson: { wheel: { holder: 'human', by: 'pane-7', takenAt: 0, expiresAt: 1000 } },
    });
    h.el('handback').fire('click');
    await h.settle();
    expect(h.el('handback').hidden).toBe(true);
    expect(h.el('takeover').hidden).toBe(false);
  });

  it('stops renewing once it has been handed back', async () => {
    // Otherwise the page keeps the lease alive for an agent that now holds it.
    const h = run({
      fetchJson: { wheel: { holder: 'human', by: 'pane-7', takenAt: 0, expiresAt: 1000 } },
      nowMs: 900,
    });
    h.el('handback').fire('click');
    await h.settle();
    h.fetches.length = 0;
    await h.tickTimers();
    expect(h.fetches.some((f) => f.url.endsWith('/wheel/renew'))).toBe(false);
  });
});

describe('taking the wheel from the page', () => {
  /**
   * Untested until now, and I broke it while editing around it: the handler set
   * `watching = false` and stopped calling applyWatching(), so pressing "take
   * the wheel" changed the variable and nothing else — the button stayed, the
   * hand-back stayed hidden, and the body kept the class that marks a viewer as
   * a spectator. Nothing noticed, because nothing looked.
   */
  it('asks for the wheel', async () => {
    const h = run({ search: '?mode=watch' });
    h.el('takeover').fire('click');
    await h.settle();
    const take = h.fetches.find((f) => f.url.endsWith('/wheel/take'));
    expect(take?.method).toBe('POST');
  });

  it('and then actually looks like a driver', async () => {
    const h = run({ search: '?mode=watch' });
    expect(h.el('takeover').hidden).toBe(false);
    h.el('takeover').fire('click');
    await h.settle();
    expect(h.el('takeover').hidden).toBe(true);
    expect(h.el('handback').hidden).toBe(false);
  });

  it('says so, rather than silently staying a spectator', async () => {
    const h = run({ search: '?mode=watch', fetchOk: false });
    h.el('takeover').fire('click');
    await h.settle();
    expect(h.el('msg').textContent).toMatch(/could not take/i);
    expect(h.el('takeover').hidden).toBe(false);
  });
});
