import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';
import { useEffect, useRef } from 'react';
import '@xterm/xterm/css/xterm.css';
import { decodeServerMessage, encodeInput, encodePing, encodeResize } from '@muxpad/shared';
import { api } from '../api';
import { splitClipboard } from '../lib/clipboard-detect';
import { writeClipboard } from '../lib/clipboard-write';
import { createSafeClipboardAddon } from '../lib/safe-clipboard-provider';
import { ChunkedWriter, SyncBlockExtractor } from '../lib/write-coalescer';
import { getCellDimensions, setScrollBarWidthZero } from '../lib/xterm-internals';
import { type Theme, getSettings, useSettings } from '../settings';
import './XtermPane.css';

// Debug logging: enable via URL flag (?debug=1) OR localStorage
// (muxpad.debug=1). localStorage survives the / → /w/:slug → /w/:slug/t/:slug
// redirect chain that strips unknown query params.
const DEBUG =
  typeof window !== 'undefined' &&
  (new URLSearchParams(window.location.search).get('debug') === '1' ||
    window.localStorage?.getItem('muxpad.debug') === '1');
const dbg = (...args: unknown[]) => {
  if (DEBUG) console.log('[XtermPane]', ...args);
};

export interface XtermPaneProps {
  paneId: string;
  /** Called when the server tells us the underlying PTY exited. */
  onExit?: ((code: number) => void) | undefined;
}

const XTERM_THEMES: Record<
  Theme,
  {
    background: string;
    foreground: string;
    cursor: string;
    selectionBackground: string;
  }
> = {
  'tokyo-night': {
    background: '#1a1b26',
    foreground: '#c0caf5',
    cursor: '#7aa2f7',
    selectionBackground: '#283457',
  },
  dracula: {
    background: '#282a36',
    foreground: '#f8f8f2',
    cursor: '#bd93f9',
    selectionBackground: '#44475a',
  },
  'github-light': {
    background: '#ffffff',
    foreground: '#1f2328',
    cursor: '#0969da',
    selectionBackground: '#cae8ff',
  },
  acme: {
    background: '#fdf6ea',
    foreground: '#0d0d12',
    cursor: '#6f55ff',
    selectionBackground: '#e3daff',
  },
  'acme-dark': {
    background: '#221547',
    foreground: '#ebe5d2',
    cursor: '#9d85f5',
    selectionBackground: '#4d3490',
  },
};

function themeFor(theme: Theme) {
  return XTERM_THEMES[theme] ?? XTERM_THEMES.acme;
}

export function XtermPane({ paneId, onExit }: XtermPaneProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;
  const settings = useSettings();
  const wsRef = useRef<WebSocket | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  // The terminal is created once per paneId. Font/theme changes are applied
  // in place by the live-update effect below (mutating term.options), so this
  // effect deliberately does NOT depend on `settings` — recreating the
  // Terminal would drop scrollback and re-establish the WS attach. Initial
  // font/theme is read from getSettings() at mount for the same reason.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const { fontFamily, fontSize, theme } = getSettings();
    const term = new Terminal({
      fontFamily,
      fontSize,
      cursorBlink: true,
      theme: themeFor(theme),
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    // Custom clipboard provider: the stock one throws inside term.write()'s
    // OSC 52 handler when navigator.clipboard is undefined (non-secure
    // context — Tailscale serve, LAN IP), which truncates the terminal frame.
    term.loadAddon(createSafeClipboardAddon());
    // Open clicked links directly — no confirm. The xterm default activator
    // prompts via window.confirm(), which Chrome amplifies with a generic
    // "WARNING: dangerous" line that adds no information (the URL is already
    // visible in the terminal). noopener,noreferrer keeps the destination
    // from reading window.opener or seeing the muxpad referer.
    term.loadAddon(
      new WebLinksAddon((_event, uri) => {
        window.open(uri, '_blank', 'noopener,noreferrer');
      }),
    );
    termRef.current = term;
    fitRef.current = fit;

    // Only a *visible* tab may resize the shared PTY. A hidden tab
    // (backgrounded, bfcache-restored, Chrome-discarded-then-restored)
    // measures its xterm against a stale/throttled viewport — its fit()
    // output is not trustworthy, and pushing it to the PTY shrinks the
    // terminal out from under whichever tab the user is actually looking
    // at. This was the root cause of the recurring "pane renders at 60%"
    // bug: an invisible phantom tab kept sending a small resize.
    //
    // When a hidden tab becomes visible again, the visibilitychange
    // handler's reassertSize() chain zeroes the dedup cache and
    // re-announces the now-correct size — so nothing is lost by staying
    // silent while hidden.
    const mayDriveResize = () => document.visibilityState === 'visible';

    // Diagnostic snapshot: captures everything that could explain a sudden
    // "renderer shrinks while no React event fires" state. snap() is the
    // single place to gather it so all events use a consistent shape.
    // Cheap when DEBUG is off (gated immediately).
    const shortId = paneId.slice(-6);
    const snap = (event: string, extra?: Record<string, unknown>): void => {
      if (!DEBUG) return;
      const cell = getCellDimensions(term);
      const screenEl = term.element?.querySelector('.xterm-screen') as HTMLElement | null;
      const rowsEl = term.element?.querySelector('.xterm-rows') as HTMLElement | null;
      const viewportEl = term.element?.querySelector('.xterm-viewport') as HTMLElement | null;
      const screen = screenEl?.getBoundingClientRect();
      const rowsRect = rowsEl?.getBoundingClientRect();
      const vpRect = viewportEl?.getBoundingClientRect();
      const expectedW = cell ? cell.width * term.cols : null;
      const expectedH = cell ? cell.height * term.rows : null;
      const ratio = screen && expectedW ? screen.width / expectedW : null;
      // Emit as a single string so Chrome's object-truncation can't hide
      // tail fields. Tagged "key=value" pairs stay grep-able.
      const fmt = (n: number | undefined): string =>
        n === undefined ? '?' : Math.round(n).toString();
      const cellStr = cell ? `${cell.width.toFixed(2)}x${cell.height.toFixed(2)}` : 'null';
      const screenStr = screen ? `${fmt(screen.width)}x${fmt(screen.height)}` : 'null';
      const rowsStr = rowsRect ? `${fmt(rowsRect.width)}x${fmt(rowsRect.height)}` : 'null';
      const vpStr = vpRect ? `${fmt(vpRect.width)}x${fmt(vpRect.height)}` : 'null';
      const expectedStr = expectedW && expectedH ? `${fmt(expectedW)}x${fmt(expectedH)}` : 'null';
      const ratioStr = ratio !== null ? ratio.toFixed(3) : 'null';
      const line =
        `[${event}] pane=${shortId} grid=${term.cols}x${term.rows} cell=${cellStr} ` +
        `cont=${container.clientWidth}x${container.clientHeight} ` +
        `screen=${screenStr} rows=${rowsStr} viewport=${vpStr} ` +
        `expected=${expectedStr} ratio=${ratioStr} dpr=${window.devicePixelRatio} ` +
        `vis=${document.visibilityState} foc=${document.hasFocus()} ` +
        `win=${window.innerWidth}x${window.innerHeight} zoom=${(window.visualViewport?.scale ?? 1).toFixed(3)}`;
      if (extra) dbg(line, extra);
      else dbg(line);
    };

    const chunker = new ChunkedWriter((s) => term.write(s), {
      chunkSize: 48 * 1024,
      raf: requestAnimationFrame.bind(window),
    });
    const extractor = new SyncBlockExtractor((s) => chunker.push(s), {
      raf: requestAnimationFrame.bind(window),
      maxHoldMs: 50,
    });
    // Force-flush any sync block held longer than maxHoldMs so a stuck
    // half-frame can't freeze output.
    const staleTimer = window.setInterval(() => extractor.flushStale(Date.now()), 25);

    // Debounced post-write repaint. xterm's DOM renderer occasionally
    // leaves a few top rows showing a stale frame after Claude finishes
    // a redraw — we've seen the bug repeatedly with no easy repro,
    // visible workaround was always to switch panes or reload. After
    // each parsed write we schedule a refresh; while the stream is
    // active the timer keeps resetting and never fires, but the moment
    // output settles the refresh fires once and clears any stuck rows.
    // Sub-millisecond cost per fire (~30×80 cells of DOM update).
    let postWriteRefreshTimer: number | null = null;
    const writeParsedSub = term.onWriteParsed(() => {
      if (postWriteRefreshTimer !== null) window.clearTimeout(postWriteRefreshTimer);
      postWriteRefreshTimer = window.setTimeout(() => {
        postWriteRefreshTimer = null;
        try {
          term.refresh(0, term.rows - 1);
        } catch {
          // ignore — term may be disposed
        }
      }, 500);
    });

    // Activity-independent diagnostic timer. The WS-heartbeat path only fires
    // when the connection is idle for HEARTBEAT_IDLE_MS — panes streaming
    // constant output (Vite HMR, dev TUIs) never go idle, so the heartbeat
    // never fires and we get zero diagnostic data on the panes most likely to
    // see the renderer-shrink bug. This interval ticks every 5s regardless of
    // activity, snapping current state and checking the screen-vs-expected
    // ratio. Single setInterval per pane, no work when DEBUG is off.
    const diagTimer = DEBUG ? window.setInterval(() => snap('diag tick'), 5000) : null;

    // Console-accessible dump hook (DEBUG only). Each mounted pane
    // registers its snap() here; `window.__muxpad_dump()` calls them
    // all so the user can grab current state the moment they see a bug.
    type DumpRegistry = { panes: Map<string, () => void> };
    if (DEBUG) {
      const w = window as unknown as { __muxpad?: DumpRegistry };
      if (!w.__muxpad) {
        w.__muxpad = { panes: new Map() };
        (window as unknown as { __muxpad_dump: () => void }).__muxpad_dump = () => {
          const reg = (window as unknown as { __muxpad?: DumpRegistry }).__muxpad;
          if (!reg) return;
          console.log(`[muxpad_dump] ${reg.panes.size} pane(s)`);
          for (const dump of reg.panes.values()) dump();
        };
      }
      w.__muxpad.panes.set(paneId, () => snap('manual dump'));
    }

    // Tag the surrounding mosaic tile when this pane has keyboard focus, so
    // CSS can highlight the active pane. Walks to the nearest .mosaic-window
    // ancestor (react-mosaic's tile wrapper) — falls back silently if the
    // structure changes. focusin/focusout (vs focus/blur) bubble from the
    // xterm-internal textarea, so a single listener on the container covers
    // any focusable descendant.
    const setFocusedAttr = (focused: boolean) => {
      const win = container.closest('.mosaic-window');
      if (!win) return;
      if (focused) win.setAttribute('data-focused', 'true');
      else win.removeAttribute('data-focused');
    };
    const onFocusIn = () => setFocusedAttr(true);
    const onFocusOut = () => setFocusedAttr(false);
    container.addEventListener('focusin', onFocusIn);
    container.addEventListener('focusout', onFocusOut);

    // Make the pane header click-to-focus. We hide react-mosaic's
    // title/controls so the toolbar is otherwise inert — clicking it
    // should focus this pane's terminal. Use `click` instead of
    // `mousedown` so we don't interfere with HTML5 drag (mousedown
    // initiates drag-to-rearrange, and preventDefault on mousedown
    // suppresses it in most browsers). click fires after mouseup, so
    // a drag gesture has already completed by the time we focus.
    const toolbarEl = container
      .closest('.mosaic-window')
      ?.querySelector<HTMLElement>('.mosaic-window-toolbar');
    const onToolbarClick = () => {
      term.focus();
    };
    toolbarEl?.addEventListener('click', onToolbarClick);

    // Pre-load the requested font before opening the terminal so xterm
    // measures with the correct glyph metrics from the start. If we open
    // first, xterm caches fallback metrics and never updates them.
    let opened = false;
    void document.fonts
      .load(`${fontSize}px ${fontFamily}`)
      .catch(() => {
        // ignore — open anyway
      })
      .finally(() => {
        if (opened) return;
        term.open(container);
        opened = true;
        // Focus on mount so a freshly-created workspace/pane is ready for
        // typing without an extra click. Re-mounts (font/theme change)
        // also refocus, which matches "I just navigated here" expectation.
        term.focus();

        // Force xterm's cached scrollBarWidth to 0 — we hide the native
        // viewport scrollbar via CSS, and on always-show-scrollbar systems
        // xterm would otherwise measure ~14px and have fit-addon reserve
        // that as an empty gutter. Private API — try/catch keeps us
        // safe if a future xterm version moves this field.
        setScrollBarWidthZero(term);

        // xterm measures cell.width asynchronously after the first render —
        // calling fit() *immediately* after open() runs while cell.width is
        // still 0, fit-addon bails early, and the terminal sticks at its
        // default 80 cols. Defer to the next animation frame so the renderer
        // has had a chance to size cells, then fit and tell the server.
        const initialFit = () => {
          try {
            fit.fit();
            const ws = wsRef.current;
            if (ws && ws.readyState === WebSocket.OPEN && mayDriveResize()) {
              lastSentCols = term.cols;
              lastSentRows = term.rows;
              ws.send(encodeResize(term.cols, term.rows));
            }
          } catch {
            // container may not yet be sized; resize observer will retry.
          }
        };
        // If cell measurement is still pending after one frame, the
        // fitWhenCellReady poll (every 50ms × 30) and the reassertSize
        // chain below cover the retry — no extra timer needed here.
        requestAnimationFrame(initialFit);
      });

    const wsUrl = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws/pane/${paneId}`;

    let intentionallyClosed = false;
    let paneExited = false;
    let retries = 0;
    let retryTimer: number | null = null;

    // Returns true iff the frame was actually written to an open socket.
    // Callers that cache "last sent" state (the resize dedup) MUST gate that
    // cache on this return value — otherwise a frame dropped here (WS not yet
    // open) still poisons the cache, and the dedup then suppresses every
    // future retry of that size, leaving the PTY stuck.
    const safeSend = (frame: Uint8Array): boolean => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(frame);
        return true;
      }
      return false;
    };

    const connect = () => {
      const ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;

      // After HEARTBEAT_IDLE_MS of silence, ping; if no pong within
      // HEARTBEAT_PONG_MS, force-close so the reconnect path can run. Lets
      // the client notice a dead connection fast instead of waiting on a
      // TCP timeout — matters most on flaky mobile networks.
      const HEARTBEAT_IDLE_MS = 15_000;
      const HEARTBEAT_PONG_MS = 5_000;
      let lastActivityAt = Date.now();
      let pongWaitTimer: number | null = null;
      let idleTimer: number | null = null;
      const armIdle = () => {
        if (idleTimer !== null) window.clearTimeout(idleTimer);
        const elapsed = Date.now() - lastActivityAt;
        idleTimer = window.setTimeout(
          () => {
            snap('heartbeat ping');
            safeSend(encodePing());
            pongWaitTimer = window.setTimeout(() => {
              dbg('heartbeat pong timeout — force-closing');
              try {
                ws.close();
              } catch {
                /* ignore */
              }
            }, HEARTBEAT_PONG_MS);
          },
          Math.max(0, HEARTBEAT_IDLE_MS - elapsed),
        );
      };
      const observeActivity = () => {
        lastActivityAt = Date.now();
        if (pongWaitTimer !== null) {
          window.clearTimeout(pongWaitTimer);
          pongWaitTimer = null;
        }
        armIdle();
      };

      ws.addEventListener('open', () => {
        dbg('ws open', { paneId, retries });
        if (retries > 0) term.writeln('\r\n[reconnected]');
        retries = 0;
        try {
          fit.fit();
        } catch {
          // ignore
        }
        // Re-announce size on (re)connect — but only if this tab is
        // visible. A hidden tab reconnecting must not push its (stale)
        // size; reassertSize() on the next visibilitychange handles it.
        if (mayDriveResize() && safeSend(encodeResize(term.cols, term.rows))) {
          lastSentCols = term.cols;
          lastSentRows = term.rows;
        }
        armIdle();
      });

      ws.addEventListener('message', (e) => {
        observeActivity();
        const buf = new Uint8Array(e.data as ArrayBuffer);
        const msg = decodeServerMessage(buf);
        if (msg.kind === 'output') {
          extractor.push(msg.data);
        } else if (msg.kind === 'exit') {
          paneExited = true;
          term.writeln(`\r\n[process exited ${msg.code}]`);
          // Only the natural-exit case (user typed `exit`, command finished
          // and shell closed) means "clean up this pane." 'killed' covers
          // explicit kills + daemon shutdown, neither of which should delete
          // anything client-side — the explicit X click already issued a
          // DELETE, and shutdown is transient.
          if (msg.cause === 'natural') {
            onExitRef.current?.(msg.code);
          }
        } else if (msg.kind === 'error') {
          term.writeln(`\r\n[server error: ${msg.message}]`);
        } else if (msg.kind === 'pong') {
          // observeActivity already cleared pongWaitTimer; nothing else to do.
        }
      });

      ws.addEventListener('close', (e) => {
        if (idleTimer !== null) window.clearTimeout(idleTimer);
        if (pongWaitTimer !== null) window.clearTimeout(pongWaitTimer);
        dbg('ws close', { paneId, intentionallyClosed, paneExited, retries, code: e.code });
        if (wsRef.current === ws) wsRef.current = null;
        if (intentionallyClosed || paneExited) return;
        // Server-side kind flip (PATCH /api/panes/:id) closes attached
        // WSes with code 4001. Don't reconnect — TabView will unmount
        // this component as soon as the optimistic state update lands.
        if (e.code === 4001) return;
        const delay = Math.min(200 * 2 ** retries, 5000);
        if (retries === 0) term.writeln(`\r\n[connection lost, reconnecting…]`);
        retries++;
        retryTimer = window.setTimeout(connect, delay);
      });
    };

    connect();

    const onData = term.onData((d) => safeSend(encodeInput(d)));

    // Touch handler: scroll the running TUI's own UI by sending SGR
    // mouse escapes straight to the PTY (the same bytes xterm would
    // emit for desktop wheel/click events in a mouse-reporting TUI with
    // DEC 1006 enabled — Claude Code, htop, vim, less, etc.). This
    // bypasses xterm's scrollback path, which renders garbled when the
    // pane was previously a different cols size.
    //
    // Caveat: at a plain shell prompt (no mouse mode enabled), these
    // escapes appear as literal text like `<0;5;3M` on the command
    // line. We accept that — mobile users rarely sit at a bare shell;
    // the dominant case is a running TUI with mouse reporting on.
    //
    // We use POINTER EVENTS with setPointerCapture, NOT touch events.
    // Pointer capture explicitly tells the browser "this pointer
    // belongs to this element until I release it" — iOS Safari's
    // gesture recognizer can't steal the gesture mid-drag the way it
    // can with raw touchmove events.
    //
    // Single-finger: tap-vs-swipe detection. Move past TAP_THRESHOLD_PX
    // → swipe-to-scroll. No movement before release → synthesize a
    // mouse click at the down position (SGR press + release at the
    // tap's col/row), so Claude still sees tap-to-click. Two-finger
    // swipe uses the midpoint and always scrolls (no tap-vs-swipe;
    // a two-finger tap is rare and confusing).
    //
    // Desktop mouse (pointerType='mouse') is filtered out — xterm's
    // own mouse handling continues to drive it.
    const WHEEL_STEP_PX = 30;
    const TAP_THRESHOLD_PX = 8;
    type Pt = { x: number; y: number; startX: number; startY: number; moved: boolean };
    const pointers = new Map<number, Pt>();
    let lastRefY = 0;
    let accumY = 0;
    // True if this gesture ever had >1 finger simultaneously. Used to
    // suppress the synthetic click on release: a 2-finger tap (both
    // still, then lifted in sequence) would otherwise reach the
    // `!p.moved && pointers.size === 0` gate on the second release and
    // fire a phantom click.
    let multiFingerGesture = false;
    // Compute the (col, row) inside the terminal for a client-coords
    // point. Returns null if the cell dimensions aren't known yet.
    const cellAt = (clientX: number, clientY: number) => {
      const screenEl = term.element?.querySelector('.xterm-screen') as HTMLElement | null;
      const cell = getCellDimensions(term);
      if (!screenEl || !cell || cell.width <= 0 || cell.height <= 0) return null;
      const rect = screenEl.getBoundingClientRect();
      const col = Math.max(
        1,
        Math.min(term.cols, Math.floor((clientX - rect.left) / cell.width) + 1),
      );
      const row = Math.max(
        1,
        Math.min(term.rows, Math.floor((clientY - rect.top) / cell.height) + 1),
      );
      return { col, row };
    };
    // Re-seed the reference Y from currently active pointers and reset
    // the wheel accumulator. Called when the pointer set changes so a
    // newly-added or removed finger doesn't cause a phantom jump.
    const reseed = () => {
      if (pointers.size === 0) return;
      const ys = [...pointers.values()].map((p) => p.y);
      lastRefY = ys.reduce((a, b) => a + b, 0) / ys.length;
      accumY = 0;
    };

    const onPointerDown = (e: PointerEvent) => {
      if (e.pointerType !== 'touch') return;
      pointers.set(e.pointerId, {
        x: e.clientX,
        y: e.clientY,
        startX: e.clientX,
        startY: e.clientY,
        moved: false,
      });
      try {
        container.setPointerCapture(e.pointerId);
      } catch {
        // capture is best-effort
      }
      if (pointers.size > 1) multiFingerGesture = true;
      reseed();
      e.preventDefault();
    };
    const onPointerMove = (e: PointerEvent) => {
      if (e.pointerType !== 'touch') return;
      const p = pointers.get(e.pointerId);
      if (!p) return;
      p.x = e.clientX;
      p.y = e.clientY;
      const dx = e.clientX - p.startX;
      const dy = e.clientY - p.startY;
      if (!p.moved && Math.hypot(dx, dy) > TAP_THRESHOLD_PX) p.moved = true;

      // Single finger that hasn't crossed the tap threshold yet: don't
      // accumulate wheel motion. Otherwise tiny jitter under a finger
      // resting on the screen would fire phantom scroll steps.
      if (pointers.size === 1 && !p.moved) return;

      const ps = [...pointers.values()];
      const refY = ps.reduce((s, q) => s + q.y, 0) / ps.length;
      const refX = ps.reduce((s, q) => s + q.x, 0) / ps.length;
      const dY = refY - lastRefY;
      lastRefY = refY;
      // Fingers DOWN reveals older content → wheel UP (negative).
      accumY += -dY;
      const steps = Math.trunc(accumY / WHEEL_STEP_PX);
      if (steps !== 0) {
        accumY -= steps * WHEEL_STEP_PX;
        const pos = cellAt(refX, refY);
        if (pos) {
          // SGR mouse wheel: 64 = up (older), 65 = down (newer).
          const button = steps > 0 ? 65 : 64;
          let seq = '';
          for (let i = 0; i < Math.abs(steps); i++) {
            seq += `\x1b[<${button};${pos.col};${pos.row}M`;
          }
          if (seq) safeSend(encodeInput(seq));
        }
      }
      e.preventDefault();
    };
    const onPointerUpOrCancel = (e: PointerEvent) => {
      if (e.pointerType !== 'touch') return;
      const p = pointers.get(e.pointerId);
      if (!p) return;
      pointers.delete(e.pointerId);
      try {
        container.releasePointerCapture(e.pointerId);
      } catch {
        // ignore
      }
      // Tap: single finger that never moved past threshold and no other
      // fingers are still down. Synthesize a left-button click at the
      // down position so the running TUI sees the tap. SGR encoding:
      // press = "<0;col;row;M", release = "<0;col;row;m".
      // Suppress when this gesture ever had >1 finger — otherwise a
      // motionless 2-finger tap fires a phantom click when the second
      // finger lifts (pointers.size === 0, !p.moved, both true).
      if (!p.moved && pointers.size === 0 && !multiFingerGesture) {
        const pos = cellAt(p.startX, p.startY);
        if (pos) {
          const seq = `\x1b[<0;${pos.col};${pos.row}M\x1b[<0;${pos.col};${pos.row}m`;
          safeSend(encodeInput(seq));
        }
      }
      if (pointers.size === 0) {
        multiFingerGesture = false;
        // Rapid SGR-wheel sequences can leave the TUI mid-redraw — Claude
        // gets the next scroll event before it finished painting from the
        // previous one, and we end up with stale rows at the top of the
        // viewport that don't reflect the current scroll position. Once
        // the gesture is fully done, ask xterm to repaint all visible
        // rows from its buffer so any straggler rows refresh. Cheap.
        try {
          term.refresh(0, term.rows - 1);
        } catch {
          // ignore — term may be disposed mid-cleanup
        }
      }
      // Re-seed for any remaining pointers so the next move doesn't
      // see a delta computed against the lifted finger's Y.
      reseed();
    };
    container.addEventListener('pointerdown', onPointerDown);
    container.addEventListener('pointermove', onPointerMove);
    container.addEventListener('pointerup', onPointerUpOrCancel);
    container.addEventListener('pointercancel', onPointerUpOrCancel);

    const MIN_COLS = 40;
    const MIN_ROWS = 10;
    let lastSentCols = 0;
    let lastSentRows = 0;
    const refit = () => {
      try {
        // A hidden tab must not drive the shared PTY size (see
        // mayDriveResize above). Bail before fit() so we don't even
        // measure a stale viewport. The visibilitychange→visible path
        // re-runs the full refit chain when the tab is looked at again.
        if (!mayDriveResize()) {
          dbg('refit skipped: tab hidden');
          return;
        }
        // Skip when the pane element is in a transient sub-pixel state
        // during mosaic re-layout (clientWidth=0, etc.). Pushing those
        // values through fit() and on to the PTY causes the running TUI
        // to receive a bogus SIGWINCH (e.g. 2×18) and redraw to that
        // ghost size before we send the real one a tick later — Claude
        // Code visibly relocates its input bar when this happens.
        if (container.clientWidth < 60 || container.clientHeight < 40) return;
        fit.fit();
        const cols = term.cols;
        const rows = term.rows;
        if (cols < MIN_COLS || rows < MIN_ROWS) {
          dbg('refit skipped: below floor', { cols, rows });
          return;
        }
        if (cols === lastSentCols && rows === lastSentRows) {
          dbg('refit skipped: dedup', { cols, rows });
          return;
        }
        snap('refit', { newCols: cols, newRows: rows });
        // Cache only on a confirmed send. If the socket isn't open yet the
        // frame is dropped; leaving the cache unchanged means the next
        // refit (or the WS 'open' handler) retries instead of dedup'ing.
        if (safeSend(encodeResize(cols, rows))) {
          lastSentCols = cols;
          lastSentRows = rows;
        }
      } catch {
        // ignore; the next ResizeObserver / layout-changed tick will retry.
      }
    };

    // xterm measures cell.width asynchronously after the first render. If
    // we call fit() before that, fit-addon's proposeDimensions() returns
    // undefined and silently bails — the terminal sticks at its default
    // 80 cols regardless of container size. Poll the renderer's css.cell
    // dimensions until they're populated, then fit. Private field access
    // wrapped so a future xterm rename falls back to a no-op (the rAF
    // initialFit above runs immediately and the reassertSize chain
    // re-attempts later, so a single missed fit isn't fatal).
    const fitWhenCellReady = (attemptsLeft = 30) => {
      if (getCellDimensions(term)) {
        refit();
        return;
      }
      if (attemptsLeft > 0) {
        window.setTimeout(() => fitWhenCellReady(attemptsLeft - 1), 50);
      }
    };
    fitWhenCellReady();
    // react-mosaic re-parenting can change a pane's available width without
    // firing ResizeObserver — fit to the new size on every layout-changed
    // notification. A single trailing-edge debounce coalesces overlapping
    // resize signals from RO, the layout-changed event, and window resize.
    let refitTimer: number | null = null;
    let hasSettledFirstResize = false;
    const scheduleRefit = () => {
      if (refitTimer !== null) window.clearTimeout(refitTimer);
      const delay = hasSettledFirstResize ? 50 : 250;
      refitTimer = window.setTimeout(() => {
        refitTimer = null;
        fitWhenCellReady();
        hasSettledFirstResize = true;
      }, delay);
    };
    const resizeObs = new ResizeObserver(scheduleRefit);
    resizeObs.observe(container);
    window.addEventListener('muxpad:layout-changed', scheduleRefit);
    // Backup for cases where ResizeObserver doesn't fire — e.g. browser
    // window resize that reflows mosaic via flex without changing the
    // pane element's CSS dimensions in a way RO notices.
    const onWindowResize = () => scheduleRefit();
    window.addEventListener('resize', onWindowResize);

    // Catch device rotation via the screen.orientation API — it doesn't
    // reliably fire window.resize. Optional-chained for older browsers.
    //
    // NOTE: we deliberately do NOT listen to visualViewport 'resize'. On
    // mobile, the address bar showing/hiding during a scroll fires that
    // event continuously, and the resulting refit → fit() → term.resize()
    // churn would garble TUI scrollback (cells positioned at old cols).
    // The container ResizeObserver + window 'resize' cover real layout
    // changes; viewport-only chrome movement is intentionally ignored.
    const onOrientation = () => scheduleRefit();
    window.screen.orientation?.addEventListener('change', onOrientation);

    // Re-assert our terminal size to the PTY whenever this tab becomes the
    // active one (visibilitychange) or the window regains focus. The server
    // is last-writer-wins, so returning to a tab that sat idle while another
    // device drove the same pane immediately reclaims the PTY size for THIS
    // view — no manual resize nudge needed. We zero the dedup cache (rather
    // than skip the dedup check) so the refit chain below re-announces the
    // size even if our local cols/rows match what we last sent; the dim
    // floor and confirmed-send caching still apply inside refit().
    //
    // Multi-step: a single synchronous fit() on the first frame after the
    // page becomes visible sometimes runs against stale cell metrics (xterm
    // measures glyphs asynchronously; the renderer hasn't repainted yet),
    // producing a too-small cols/rows that visibly shrinks the terminal
    // until the next layout-changed tick corrects it seconds later. Force a
    // refresh and route through refit() at 0/100/250/500ms so the metrics
    // have time to settle — same pattern the font/theme change effect uses.
    const reassertSizeTimerIds: number[] = [];
    const reassertSize = () => {
      try {
        term.refresh(0, term.rows - 1);
      } catch {
        // ignore
      }
      // Clear the dedup cache: another device may have resized the PTY
      // while this tab was hidden, so we must re-announce our size even if
      // our local cols/rows haven't changed. (refit() will set the cache
      // back on a confirmed send.)
      lastSentCols = 0;
      lastSentRows = 0;
      for (const id of reassertSizeTimerIds) window.clearTimeout(id);
      reassertSizeTimerIds.length = 0;
      for (const delay of [0, 100, 250, 500]) {
        const id = window.setTimeout(() => fitWhenCellReady(), delay);
        reassertSizeTimerIds.push(id);
      }
    };
    // Wrap reassertSize so we log every entry with the trigger source —
    // helps disambiguate which lifecycle event woke us up.
    const reassertSizeFromEvent = (source: string) => {
      snap(`reassertSize triggered by ${source}`);
      reassertSize();
      // After the resize chain has had time to settle (the chain itself
      // schedules at 0/100/250/500ms), force xterm to repaint all visible
      // rows from its buffer. iOS Safari/PWA can suspend the renderer
      // while the app is backgrounded and leave xterm's DOM in a stale
      // state on resume — the buffer is fine but the painted rows look
      // garbled until something triggers a redraw (refresh, pane switch).
      // term.refresh is a cheap, non-destructive repaint.
      window.setTimeout(() => {
        try {
          term.refresh(0, term.rows - 1);
        } catch {
          // ignore — term may be disposed
        }
      }, 600);
      // On lifecycle RESUME (not plain focus changes), follow up with a
      // wiggle resize — temporarily ±1 cols, then back. Forces the
      // running TUI to redraw its entire visible area via SIGWINCH,
      // which clears xterm-buffer corruption from iOS PWA suspending
      // the JS context mid-write or mid-escape-sequence parse. We've
      // seen this manifest as severely garbled rows where multiple
      // streams of content overlap; term.refresh alone can't fix it
      // because the cells themselves are wrong. window.focus is too
      // chatty (fires on every tab refocus), so we scope this to the
      // events that actually correlate with a real app/page resume.
      const isResume =
        source === 'visibilitychange' || source === 'pageshow' || source === 'resume';
      if (isResume) {
        window.setTimeout(() => {
          const ws = wsRef.current;
          if (!ws || ws.readyState !== WebSocket.OPEN) return;
          const cols = term.cols;
          const rows = term.rows;
          if (cols < 2 || rows < 1) return;
          try {
            ws.send(encodeResize(cols - 1, rows));
            window.setTimeout(() => {
              if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
              try {
                wsRef.current.send(encodeResize(cols, rows));
                lastSentCols = cols;
                lastSentRows = rows;
              } catch {
                // ignore
              }
            }, 80);
          } catch {
            // ignore — socket may have closed mid-flight
          }
        }, 800);
      }
    };
    const onVisibility = () => {
      snap(`visibilitychange → ${document.visibilityState}`);
      if (document.visibilityState === 'visible') reassertSizeFromEvent('visibilitychange');
    };
    document.addEventListener('visibilitychange', onVisibility);
    const onWinFocus = () => reassertSizeFromEvent('window.focus');
    const onWinBlur = () => snap('window.blur');
    window.addEventListener('focus', onWinFocus);
    window.addEventListener('blur', onWinBlur);

    // Page Lifecycle API — fires on Chrome tab discard/restore and
    // process freeze/resume, which standard visibilitychange misses on
    // macOS when the OS suspends the renderer for a backgrounded display.
    const onPageShow = (e: PageTransitionEvent) => {
      snap(`pageshow persisted=${e.persisted}`);
      reassertSizeFromEvent('pageshow');
    };
    const onPageHide = (e: PageTransitionEvent) => {
      snap(`pagehide persisted=${e.persisted}`);
    };
    const onFreeze = () => snap('freeze');
    const onResume = () => {
      snap('resume');
      reassertSizeFromEvent('resume');
    };
    window.addEventListener('pageshow', onPageShow);
    window.addEventListener('pagehide', onPageHide);
    document.addEventListener('freeze', onFreeze);
    document.addEventListener('resume', onResume);

    // devicePixelRatio change (monitor swap, OS zoom, browser zoom) —
    // matchMedia is the canonical way to observe these. The query has
    // to be re-armed each time it fires; otherwise we only catch one.
    let dprMql: MediaQueryList | null = null;
    const armDprListener = () => {
      const current = window.devicePixelRatio;
      dprMql = window.matchMedia(`(resolution: ${current}dppx)`);
      const onDprChange = () => {
        snap(`DPR change ${current} → ${window.devicePixelRatio}`);
        reassertSizeFromEvent('dpr');
        dprMql?.removeEventListener('change', onDprChange);
        armDprListener();
      };
      dprMql.addEventListener('change', onDprChange);
    };
    armDprListener();

    // Mount-time multi-step recovery. The single fitWhenCellReady()
    // earlier runs once; if the surrounding mosaic tile is mid-transition (which
    // happens whenever this pane mounted as part of a workspace/tab nav,
    // not a user-driven split or resize), that single fit can lock in an
    // intermediate cols/rows. ResizeObserver doesn't always fire on
    // react-mosaic reparenting (see comment near scheduleRefit), and
    // notifyLayoutChanged in TabView only fires on mosaic onChange — never
    // on route mounts. Running the same reassertion chain we use on
    // visibilitychange covers that gap: by the time the 0/100/250/500ms
    // schedule completes, the tile has finished its CSS transition and we'll
    // have refit to the final size. Cheap on the steady-state path (4 fits
    // converging to the same cols/rows; dedup suppresses redundant sends).
    reassertSize();

    // Targeted-focus event: TabView dispatches this after deleting
    // a pane so the next remaining pane picks up focus without a click.
    const onFocusPane = (e: Event) => {
      const detail = (e as CustomEvent<{ paneId?: string }>).detail;
      if (detail?.paneId === paneId) term.focus();
    };
    window.addEventListener('muxpad:focus-pane', onFocusPane);

    // Mobile composer (MobileInputBar) dispatches this for the active
    // pane. Forward the raw bytes to the PTY as if they came from the
    // hidden xterm textarea — same path as user keypresses.
    const onSendInput = (e: Event) => {
      const detail = (e as CustomEvent<{ paneId?: string; data?: string }>).detail;
      if (detail?.paneId !== paneId || typeof detail.data !== 'string') return;
      safeSend(encodeInput(detail.data));
    };
    window.addEventListener('muxpad:send-input', onSendInput);

    const onKeyDown = (e: KeyboardEvent) => {
      // Cmd/Ctrl+C: copy selection if any (else fall through so xterm sends
      // SIGINT to the PTY).
      if ((e.metaKey || e.ctrlKey) && (e.key === 'c' || e.key === 'C')) {
        const sel = term.getSelection();
        if (sel) {
          // writeClipboard falls back to execCommand('copy') so this works
          // in non-secure contexts (Tailscale serve, LAN IP) where
          // navigator.clipboard is undefined.
          void writeClipboard(sel);
          e.preventDefault();
          e.stopPropagation();
        }
        return;
      }
      // Shift+Enter (alone, no other modifiers) → Esc+Enter ("\x1b\r").
      // Claude Code and other TUI input editors interpret that as "insert
      // newline into the current input" — same as Option+Enter on Mac.
      // Default Shift+Enter would just be \r (submit).
      if (e.key === 'Enter' && e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
        safeSend(encodeInput('\x1b\r'));
        e.preventDefault();
        e.stopPropagation();
      }
    };
    container.addEventListener('keydown', onKeyDown, true);

    const onPaste = async (e: ClipboardEvent) => {
      const data = e.clipboardData;
      if (!data) return;
      // Guarded so the Array.from(...) isn't built on every paste when
      // DEBUG is off (dbg's own check happens after arg evaluation).
      if (DEBUG) {
        dbg('paste', {
          types: Array.from(data.types),
          items: Array.from(data.items).map((i) => `${i.kind}:${i.type}`),
        });
      }
      const { imageOnly, imageItems } = splitClipboard(data);
      if (imageItems.length === 0) return; // plain text — let xterm's bracketed-paste path handle it
      const paths: string[] = [];
      for (const item of imageItems) {
        const blob = item.getAsFile();
        if (!blob) continue;
        const ext = blob.type.split('/')[1] ?? 'png';
        try {
          const { path } = await api.uploadAttachment(paneId, blob, `pasted.${ext}`);
          paths.push(path);
        } catch (err) {
          term.writeln(`\r\n[upload failed: ${String(err)}]`);
        }
      }
      // Always swallow the paste event — we'll re-inject any text portion
      // manually so the wire order is deterministic: path(s) first, then
      // text. Without this, xterm's synchronous bracketed-paste path sends
      // text BEFORE our awaited upload completes, putting the path at the
      // end of the prompt.
      //
      // Trade-off: the text portion is no longer wrapped in
      // \x1b[200~ .. \x1b[201~ bracketed-paste markers. Claude Code does
      // not require them; if a future inner program (e.g. a shell with
      // bracketed-paste support) needs them, wrap `text` here.
      e.preventDefault();
      e.stopPropagation();
      if (paths.length) safeSend(encodeInput(`${paths.join(' ')} `));
      if (!imageOnly) {
        const text = data.getData('text/plain');
        if (text) safeSend(encodeInput(text));
      }
    };
    container.addEventListener('paste', onPaste, true);

    return () => {
      intentionallyClosed = true;
      opened = true; // skip the deferred open if it fires after unmount
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      resizeObs.disconnect();
      window.removeEventListener('muxpad:layout-changed', scheduleRefit);
      window.removeEventListener('resize', onWindowResize);
      window.screen.orientation?.removeEventListener('change', onOrientation);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', onWinFocus);
      window.removeEventListener('blur', onWinBlur);
      window.removeEventListener('pageshow', onPageShow);
      window.removeEventListener('pagehide', onPageHide);
      document.removeEventListener('freeze', onFreeze);
      document.removeEventListener('resume', onResume);
      // dprMql's per-instance change listener is owned by armDprListener's
      // closure; on unmount we drop the reference so the GC can reap it.
      dprMql = null;
      for (const id of reassertSizeTimerIds) window.clearTimeout(id);
      if (refitTimer !== null) window.clearTimeout(refitTimer);
      window.removeEventListener('muxpad:focus-pane', onFocusPane);
      window.removeEventListener('muxpad:send-input', onSendInput);
      container.removeEventListener('keydown', onKeyDown, true);
      container.removeEventListener('paste', onPaste, true);
      onData.dispose();
      writeParsedSub.dispose();
      if (postWriteRefreshTimer !== null) window.clearTimeout(postWriteRefreshTimer);
      container.removeEventListener('pointerdown', onPointerDown);
      container.removeEventListener('pointermove', onPointerMove);
      container.removeEventListener('pointerup', onPointerUpOrCancel);
      container.removeEventListener('pointercancel', onPointerUpOrCancel);
      container.removeEventListener('focusin', onFocusIn);
      container.removeEventListener('focusout', onFocusOut);
      toolbarEl?.removeEventListener('click', onToolbarClick);
      wsRef.current?.close();
      wsRef.current = null;
      window.clearInterval(staleTimer);
      if (diagTimer !== null) window.clearInterval(diagTimer);
      const reg = (window as unknown as { __muxpad?: { panes: Map<string, () => void> } }).__muxpad;
      reg?.panes.delete(paneId);
      extractor.dispose();
      chunker.dispose();
      if (termRef.current === term) termRef.current = null;
      if (fitRef.current === fit) fitRef.current = null;
      term.dispose();
    };
  }, [paneId]);

  // Live font/theme update: mutate term.options in place instead of
  // recreating the Terminal, so scrollback and the WS attach survive a font
  // or theme change. The multi-step refit handles xterm's async cell-metric
  // remeasurement after a font swap.
  useEffect(() => {
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit) return;
    term.options.fontFamily = settings.fontFamily;
    term.options.fontSize = settings.fontSize;
    term.options.theme = themeFor(settings.theme);
    const timerIds: number[] = [];
    let disposed = false;
    void document.fonts.load(`${settings.fontSize}px ${settings.fontFamily}`).finally(() => {
      if (disposed) return;
      const t = termRef.current;
      if (!t) return;
      t.refresh(0, t.rows - 1);
      // Multi-step refit handles xterm's async cell-metric remeasurement
      // after a font swap — the metrics settle a beat after document.fonts
      // resolves, so one nudge isn't enough.
      const steps = [0, 100, 250];
      steps.forEach((delay) => {
        const id = window.setTimeout(() => {
          // Route through muxpad:layout-changed rather than calling fit()
          // directly: the main effect's refit() both fits AND sends the new
          // size to the server. A bare fit() resizes xterm's view but never
          // SIGWINCHes the PTY, so a TUI like Claude Code keeps rendering at
          // the old row count and doesn't fill the pane.
          window.dispatchEvent(new Event('muxpad:layout-changed'));
        }, delay);
        timerIds.push(id);
      });
    });
    return () => {
      disposed = true;
      for (const id of timerIds) window.clearTimeout(id);
    };
  }, [settings.fontFamily, settings.fontSize, settings.theme]);

  return (
    <div className="xterm-pane-wrapper">
      <div className="xterm-pane" ref={containerRef} tabIndex={0} />
    </div>
  );
}
