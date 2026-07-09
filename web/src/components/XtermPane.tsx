import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';
import { useEffect, useRef, useState } from 'react';
import '@xterm/xterm/css/xterm.css';
import { decodeServerMessage, encodeInput, encodePing, encodeResize } from '@muxpad/shared';
import { api } from '../api';
import { companionTextForImagePaste, splitClipboard } from '../lib/clipboard-detect';
import { writeClipboard } from '../lib/clipboard-write';
import { CursorScrollSession } from '../lib/cursor-scroll-session';
import { isMobileLayout } from '../lib/mobile-layout';
import { createSafeClipboardAddon } from '../lib/safe-clipboard-provider';
import { ChunkedWriter, SyncBlockExtractor } from '../lib/write-coalescer';
import {
  bufferHasScrollback,
  getCellDimensions,
  isCursorAgentCmd,
  isInkForegroundCmd,
  linesAboveBottom,
  linesAboveFromRatio,
  refreshVisibleRows,
  restoreLinesAboveBottom,
  scrollBufferByLines,
  scrollBufferWheel,
  scrollRatioFromTerm,
  setScrollBarWidthZero,
  shouldForwardWheelToPty,
  shouldScrollXtermBuffer,
  shouldTouchScrollBuffer,
  triggerWheelMouseEvent,
  wheelInputForPty,
} from '../lib/xterm-internals';
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
  /**
   * Focus the terminal on mount. Default true (a freshly-opened pane
   * should be ready for input). The desktop multi-pane case sets this
   * false on every pane except the persisted-last-focused one, so a
   * refresh restores focus instead of letting last-to-mount win.
   */
  autoFocus?: boolean | undefined;
  /** Best-effort foreground command from ptyd (cursor-agent, claude, …). */
  foregroundCmd?: string | null | undefined;
  /** False when the parent tab/pane slot is hidden (display:none). */
  paneActive?: boolean | undefined;
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
  trayo: {
    background: '#fdf6ea',
    foreground: '#0d0d12',
    cursor: '#6f55ff',
    selectionBackground: '#e3daff',
  },
  'trayo-dark': {
    background: '#221547',
    foreground: '#ebe5d2',
    cursor: '#9d85f5',
    selectionBackground: '#4d3490',
  },
};

function themeFor(theme: Theme) {
  return XTERM_THEMES[theme] ?? XTERM_THEMES.trayo;
}

type PasteToast = { previewUrl: string; path: string };

export function XtermPane({
  paneId,
  onExit,
  autoFocus = true,
  foregroundCmd = null,
  paneActive = true,
}: XtermPaneProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const foregroundCmdRef = useRef(foregroundCmd);
  foregroundCmdRef.current = foregroundCmd;
  const paneActiveRef = useRef(paneActive);
  paneActiveRef.current = paneActive;
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;
  const settings = useSettings();
  const wsRef = useRef<WebSocket | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [pasteToast, setPasteToast] = useState<PasteToast | null>(null);
  const pasteToastTimerRef = useRef<number | null>(null);
  const pasteToastPreviewUrlRef = useRef<string | null>(null);
  // Hide during ring-buffer replay so Cursor output does not visibly scrub.
  const [replayRestoring, setReplayRestoring] = useState(true);
  const setReplayRestoringRef = useRef(setReplayRestoring);
  setReplayRestoringRef.current = setReplayRestoring;
  // Connection status shown as a DOM overlay — never written into the
  // terminal buffer (that corrupted full-screen TUIs until a refresh).
  const [reconnecting, setReconnecting] = useState(false);
  const setReconnectingRef = useRef(setReconnecting);
  setReconnectingRef.current = setReconnecting;
  const tryOpenTermRef = useRef<(() => void) | null>(null);
  // Convergent re-fit chain (0/100/250/500ms). Exposed so the paneActive
  // become-visible effect can reuse it instead of a single-shot fit.
  const reassertSizeRef = useRef<(() => void) | null>(null);

  // The terminal is created once per paneId. Font/theme changes are applied
  // in place by the live-update effect below (mutating term.options), so this
  // effect deliberately does NOT depend on `settings` — recreating the
  // Terminal would drop scrollback and re-establish the WS attach. Initial
  // font/theme is read from getSettings() at mount for the same reason.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const { fontFamily, fontSize, theme } = getSettings();
    // Open a clicked link directly, no confirm. A terminal surfaces URLs two
    // independent ways and each needs its own opener:
    //   1. Plain-text URLs the WebLinksAddon detects by regex (below).
    //   2. OSC 8 hyperlinks, which xterm *core* renders via its own
    //      OscLinkProvider — the addon never sees these. With no `linkHandler`
    //      set, core falls back to a window.confirm() activator that Chrome
    //      amplifies into a generic "WARNING: dangerous" line, then does its
    //      own window.open(). Programs that emit terminal hyperlinks (Claude
    //      Code, gh, ls --hyperlink, …) hit that path, which is why the prompt
    //      kept showing up despite the addon's custom handler.
    // Routing both through one opener makes behavior identical regardless of
    // how the URL was emitted, and means a link is never opened more than once
    // per click. noopener,noreferrer keeps the destination from reading
    // window.opener or seeing the muxpad referer.
    const openUri = (uri: string): void => {
      window.open(uri, '_blank', 'noopener,noreferrer');
    };
    const term = new Terminal({
      fontFamily,
      fontSize,
      cursorBlink: true,
      theme: themeFor(theme),
      allowProposedApi: true,
      linkHandler: { activate: (_event, uri) => openUri(uri) },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    // Custom clipboard provider: the stock one throws inside term.write()'s
    // OSC 52 handler when navigator.clipboard is undefined (non-secure
    // context — Tailscale serve, LAN IP), which truncates the terminal frame.
    term.loadAddon(createSafeClipboardAddon());
    term.loadAddon(new WebLinksAddon((_event, uri) => openUri(uri)));
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
    const mayDriveResize = () => document.visibilityState === 'visible' && paneActiveRef.current;

    // Resize-send floor. ALL three fit-and-send paths (initial open below,
    // the (re)connect `announceSize`, and `refit`) consult these so a
    // near-zero measurement on a not-yet-settled layout (display:none→visible
    // slot, mosaic re-layout) can't push a bogus SIGWINCH to the PTY and make
    // a running TUI reflow / relocate its input bar. Declared up here (not
    // inline near refit) so the earlier fit paths can share them without a
    // temporal-dead-zone hazard.
    //
    // Floor values: must stay BELOW any size a real device can legitimately
    // be. A phone with a bumped font size fits ~36-39 cols — the original
    // 40x10 floor blocked those phones from ever connecting (tryInitialConnect
    // gates on this too), leaving a blinking caret on an empty terminal.
    // 20x5 still rejects the degenerate ghost sizes this floor exists for
    // (8x4 storms from suspended layouts).
    const MIN_COLS = 20;
    const MIN_ROWS = 5;
    let lastSentCols = 0;
    let lastSentRows = 0;
    const containerTooSmall = () => container.clientWidth < 60 || container.clientHeight < 40;
    const gridBelowFloor = () => term.cols < MIN_COLS || term.rows < MIN_ROWS;

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
    const cursorScroll = new CursorScrollSession({
      paneId,
      getForegroundCmd: () => foregroundCmdRef.current,
      revealAfterReplay: () => {
        setReplayRestoringRef.current(false);
      },
    });
    const writeParsedSub = term.onWriteParsed(() => {
      cursorScroll.onTerminalWriteParsed(term);
      // Desktop Cursor: skip post-write refresh (flicker). Mobile needs it
      // so buffer scroll / refit repaints on iOS Safari.
      if (isCursorAgentCmd(foregroundCmdRef.current) && !isMobileLayout()) return;
      if (postWriteRefreshTimer !== null) window.clearTimeout(postWriteRefreshTimer);
      postWriteRefreshTimer = window.setTimeout(
        () => {
          postWriteRefreshTimer = null;
          refreshVisibleRows(term);
        },
        isMobileLayout() ? 300 : 500,
      );
    });
    const scrollSub = term.onScroll(() => {
      cursorScroll.onUserScroll(term);
    });

    // Tag the surrounding mosaic tile when this pane has keyboard focus, so
    // CSS can highlight the active pane. Walks to the nearest .mosaic-window
    // ancestor (react-mosaic's tile wrapper) — falls back silently if the
    // structure changes. focusin/focusout (vs focus/blur) bubble from the
    // xterm-internal textarea, so a single listener on the container covers
    // any focusable descendant.
    const setFocusedAttr = (focused: boolean) => {
      const win = container.closest('.mosaic-window');
      if (!win) return;
      if (focused) {
        win.setAttribute('data-focused', 'true');
        // Broadcast so TabView can persist the active pane per tab —
        // enables refresh-restore of focus on the desktop multi-pane
        // layout, where there's no other notion of "last-active pane".
        window.dispatchEvent(new CustomEvent('muxpad:pane-focused', { detail: { paneId } }));
      } else {
        win.removeAttribute('data-focused');
      }
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
      if (!isMobileLayout()) term.focus();
    };
    toolbarEl?.addEventListener('click', onToolbarClick);

    // Pre-load the requested font before opening the terminal so xterm
    // measures with the correct glyph metrics from the start. If we open
    // first, xterm caches fallback metrics and never updates them.
    let opened = false;
    const openTerm = () => {
      if (opened) return;
      // Mobile hidden slots stay mounted but display:none — opening xterm
      // at 0×0 corrupts layout; defer until the pane slot is shown.
      if (isMobileLayout() && !paneActiveRef.current) return;
      term.open(container);
      opened = true;
      // Mobile: the terminal is a view/scroll/tap surface, not a typing
      // target. The MobileInputBar is the input method (it forwards text +
      // Esc/Tab/arrows/Ctrl-C via muxpad:send-input). Tell mobile browsers
      // not to raise the soft keyboard for xterm's helper textarea — that
      // keyboard is what drove the visualViewport churn (half-pane stick,
      // reflow-on-focus). inputMode='none' keeps the textarea focusable, so
      // a hardware/Bluetooth keyboard and tap-to-click still work; only the
      // on-screen keyboard is suppressed. Desktop is unaffected.
      if (isMobileLayout()) {
        if (term.textarea) {
          term.textarea.inputMode = 'none';
          // Drop xterm's helper textarea out of iOS's form-field navigation
          // so the keyboard accessory bar's prev/next field chevrons don't
          // appear while typing in the MobileInputBar (otherwise iOS sees two
          // fields — the composer and this textarea — and offers to jump
          // between them). It stays click/programmatically focusable, so a
          // hardware keyboard and tap-to-click are unaffected.
          term.textarea.tabIndex = -1;
        }
      } else if (autoFocus) {
        term.focus();
      }
      setScrollBarWidthZero(term);
      const initialFit = () => {
        try {
          // Don't fit a 0/near-zero container — fit() would mutate the
          // terminal to a few columns locally even if we never send it.
          if (!containerTooSmall()) {
            fit.fit();
            const ws = wsRef.current;
            if (ws && ws.readyState === WebSocket.OPEN && mayDriveResize() && !gridBelowFloor()) {
              lastSentCols = term.cols;
              lastSentRows = term.rows;
              ws.send(encodeResize(term.cols, term.rows));
            }
          }
        } catch {
          // container may not yet be sized; resize observer will retry.
        }
        tryInitialConnect();
      };
      requestAnimationFrame(initialFit);
    };
    tryOpenTermRef.current = openTerm;
    void document.fonts
      .load(`${fontSize}px ${fontFamily}`)
      .catch(() => {
        // ignore — open anyway
      })
      .finally(() => {
        openTerm();
      });

    let intentionallyClosed = false;
    let paneExited = false;
    let retries = 0;
    let retryTimer: number | null = null;
    let initialConnectDone = false;
    // Wall-clock start of the current outage (first unintentional close).
    // On reconnect, a long gap means the PTY kept writing into a void —
    // reconnects skip the ring-buffer replay, so that output never renders
    // and an Ink TUI's differential frames repaint only the bottom region:
    // the classic "top of the terminal is frozen" mobile-resume bug.
    let disconnectedAt: number | null = null;
    // Assigned inside connect(); lets the visibility handler force an
    // immediate liveness check of the current socket on resume instead of
    // waiting out the idle-heartbeat cycle (~20s of typing into a zombie).
    let probeLiveness: (hiddenForMs: number) => void = () => {};

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
      // Fresh mounts need the ring-buffer replay so a new xterm shows the
      // live session. Reconnects keep the existing xterm — replaying would
      // repaint the whole Ink session and jump scroll to the bottom.
      if (retries > 0) {
        cursorScroll.skipReplay();
      } else {
        cursorScroll.armReplayFallback(term);
      }
      const replayQ = retries > 0 ? '?replay=0' : '';
      const wsUrl = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws/pane/${paneId}${replayQ}`;
      const ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;

      // After HEARTBEAT_IDLE_MS of silence, ping; if no pong within
      // HEARTBEAT_PONG_MS, force-close so the reconnect path can run. Lets
      // the client notice a dead connection fast instead of waiting on a
      // TCP timeout — matters most on flaky mobile networks.
      const HEARTBEAT_IDLE_MS = 15_000;
      const HEARTBEAT_PONG_MS = 5_000;
      // The backoff (retries) is only cleared once a connection has stayed
      // open this long. Resetting it the instant we open lets a
      // connect-then-immediately-drop loop reconnect forever with no backoff
      // (and spam the terminal); gating on stability makes a persistent drop
      // back off 200ms→5s instead of hammering.
      const CONNECTION_STABLE_MS = 10_000;
      let lastActivityAt = Date.now();
      let pongWaitTimer: number | null = null;
      let idleTimer: number | null = null;
      let stableTimer: number | null = null;
      const armIdle = () => {
        if (idleTimer !== null) window.clearTimeout(idleTimer);
        const elapsed = Date.now() - lastActivityAt;
        idleTimer = window.setTimeout(
          () => {
            // Never run the ping/force-close while the tab is hidden. Browsers
            // throttle (and eventually freeze) setTimeout in background tabs,
            // so the pong-wait below fires spuriously even when ptyd's pong is
            // arriving — force-closing a perfectly healthy socket, which then
            // reconnects and force-closes again: the background reconnect loop.
            // A hidden pane shows data to no one; its liveness is covered by
            // the server's protocol-level heartbeat (which the browser answers
            // automatically). A socket that died while hidden is caught once
            // the tab is shown again: this re-armed idle timer fires, now
            // passes the visibility gate, pings, and force-closes on no pong →
            // reconnect. So while hidden, just re-arm and re-check — don't
            // probe, don't close.
            if (document.visibilityState !== 'visible') {
              lastActivityAt = Date.now();
              armIdle();
              return;
            }
            // A probe (resume-time liveness check) may already have a
            // pong-wait armed — overwriting its handle would orphan a timer
            // that later force-closes a healthy socket.
            if (pongWaitTimer !== null) {
              armIdle();
              return;
            }
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
      // Resume-time zombie check: iOS routinely kills sockets of backgrounded
      // pages without firing 'close', and the idle heartbeat only notices
      // ~HEARTBEAT_IDLE_MS later — during which every keystroke silently
      // vanishes ("the pane doesn't respond at all"). Ping NOW; a live socket
      // answers within the pong window, a dead one gets force-closed into the
      // reconnect path immediately.
      probeLiveness = (hiddenForMs: number) => {
        if (ws !== wsRef.current || ws.readyState !== WebSocket.OPEN) return;
        if (pongWaitTimer !== null) return; // probe already in flight
        safeSend(encodePing());
        pongWaitTimer = window.setTimeout(() => {
          dbg('resume probe pong timeout — force-closing');
          // A zombie detected here died sometime during the background —
          // iOS never fired 'close', so the outage clock never started.
          // Backdate it to the hidden start: the reconnect's gap check must
          // see the REAL outage (PTY output written while we were deaf) and
          // fire the full repaint, not the few-hundred-ms close→open hop.
          if (disconnectedAt === null) disconnectedAt = Date.now() - hiddenForMs;
          try {
            ws.close();
          } catch {
            /* ignore */
          }
        }, HEARTBEAT_PONG_MS);
      };

      ws.addEventListener('open', () => {
        dbg('ws open', { paneId, retries });
        const wasReconnect = retries > 0;
        // Clear the DOM "reconnecting" badge. NOT written into the terminal:
        // injecting text into a full-screen TUI's buffer corrupted the
        // display until a refresh.
        setReconnectingRef.current(false);
        // Clear the backoff only after the connection proves stable (see
        // CONNECTION_STABLE_MS) — not the instant it opens.
        if (stableTimer !== null) window.clearTimeout(stableTimer);
        stableTimer = window.setTimeout(() => {
          retries = 0;
          stableTimer = null;
        }, CONNECTION_STABLE_MS);
        const announceSize = () => {
          // Same floor as refit/initialFit: don't fit or announce a near-zero
          // size on a not-yet-settled slot. reassertSize() (visibilitychange /
          // become-visible) re-announces once the layout settles.
          if (containerTooSmall()) return;
          try {
            fit.fit();
          } catch {
            // ignore
          }
          // Re-announce size on (re)connect — but only if this tab is
          // visible. A hidden tab reconnecting must not push its (stale)
          // size; reassertSize() on the next visibilitychange handles it.
          if (
            mayDriveResize() &&
            !gridBelowFloor() &&
            safeSend(encodeResize(term.cols, term.rows))
          ) {
            lastSentCols = term.cols;
            lastSentRows = term.rows;
          }
        };
        // A fresh xterm attach replays only Claude/Ink's last DEC-2026 frame
        // (inkReplayPayload). Ink emits *differential* frames, so when the
        // live screen last changed just the spinner/input rows, that frame
        // repaints only the bottom — the transcript above stays blank. A hard
        // refresh keeps the same window size, so announceSize's resize is a
        // server-side no-op (PaneRuntime dedups equal sizes) and nothing
        // SIGWINCHes the app into a full repaint; the pane sits half-empty
        // until the user resizes. Nudge the PTY one row shorter and back —
        // two real size changes the server can't dedup — so the app
        // re-measures and repaints the whole screen. The local xterm stays at
        // its real size throughout; only the PTY wiggles. Skipped for
        // cursor-agent, which owns its own replay + scroll-restore that a
        // SIGWINCH would jerk to the bottom.
        const forceFullRepaint = () => {
          if (intentionallyClosed) return;
          if (isCursorAgentCmd(foregroundCmdRef.current)) return;
          if (!mayDriveResize() || gridBelowFloor()) return;
          const cols = term.cols;
          const rows = term.rows;
          if (rows - 1 < MIN_ROWS) return; // too short to wiggle safely
          if (!safeSend(encodeResize(cols, rows - 1))) return;
          lastSentCols = cols;
          lastSentRows = rows - 1;
          window.setTimeout(() => {
            if (intentionallyClosed) return;
            if (safeSend(encodeResize(cols, rows))) {
              lastSentCols = cols;
              lastSentRows = rows;
            }
          }, 80);
        };
        // Mobile panes often open while display:none; defer fit until the
        // slot has real dimensions so we do not SIGWINCH a ghost size.
        if (isMobileLayout()) {
          requestAnimationFrame(() => requestAnimationFrame(announceSize));
        } else {
          announceSize();
        }
        // Fresh attach: after the replayed frame has painted (and the
        // foreground command has usually been detected), force the full
        // repaint described above. Quick reconnects skip it — the xterm
        // buffer is intact (ring replay skipped via ?replay=0) and a
        // SIGWINCH would force Ink TUIs to redraw and reset their scroll.
        // But a LONG-gap reconnect (iOS killed the socket while the app was
        // backgrounded) is different: the PTY kept writing while we were
        // deaf, that output never renders, and without a SIGWINCH the TUI's
        // differential frames repaint only the bottom rows — the screen
        // above stays frozen until a manual resize. Repaint those too.
        const STALE_GAP_MS = 1500;
        const gapMs = disconnectedAt === null ? 0 : Date.now() - disconnectedAt;
        disconnectedAt = null;
        if (!wasReconnect || gapMs >= STALE_GAP_MS) {
          window.setTimeout(forceFullRepaint, 220);
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
        // A connection that closed before proving stable must keep its
        // backoff — cancel the pending reset so retries++ below sticks.
        if (stableTimer !== null) {
          window.clearTimeout(stableTimer);
          stableTimer = null;
        }
        dbg('ws close', { paneId, intentionallyClosed, paneExited, retries, code: e.code });
        if (wsRef.current === ws) wsRef.current = null;
        if (disconnectedAt === null) disconnectedAt = Date.now();
        if (intentionallyClosed || paneExited) return;
        // Server-side kind flip (PATCH /api/panes/:id) closes attached
        // WSes with code 4001. Don't reconnect — TabView will unmount
        // this component as soon as the optimistic state update lands.
        if (e.code === 4001) return;
        const delay = Math.min(200 * 2 ** retries, 5000);
        // Surface "reconnecting" as a DOM badge, not terminal text.
        setReconnectingRef.current(true);
        retries++;
        retryTimer = window.setTimeout(connect, delay);
      });
    };

    const tryInitialConnect = () => {
      if (initialConnectDone || intentionallyClosed) return;
      if (!opened) return;
      // Mobile keeps inactive pane slots mounted but hidden — defer WS
      // attach + ring-buffer replay until the pane is actually shown.
      if (!paneActiveRef.current) return;
      if (container.clientWidth < 60 || container.clientHeight < 40) return;
      if (term.cols < MIN_COLS || term.rows < MIN_ROWS) return;
      initialConnectDone = true;
      connect();
    };

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
    // Plain-text URL under a tapped cell, if any. On mobile a tap is otherwise
    // sent to the TUI as a mouse click (below) and never reaches xterm's link
    // opener — so a tapped link did nothing. We re-scan the tapped buffer line
    // for an http(s) URL spanning the tapped column and open it in THIS
    // device's browser. (Covers the common case; OSC 8 hyperlinks whose text
    // isn't itself a URL aren't handled here.)
    const linkAtTap = (clientX: number, clientY: number): string | null => {
      const pos = cellAt(clientX, clientY);
      if (!pos) return null;
      const buf = term.buffer.active;
      const tappedRow = buf.viewportY + pos.row - 1;

      // A long URL wraps across rows; xterm flags continuation rows with
      // `isWrapped`. Walk back to the logical line's start, then join it and
      // its continuations into one string so a URL split across rows is
      // matched whole — tracking where the tap falls. (Public xterm buffer
      // API only — no reaching into internals.)
      let startRow = tappedRow;
      const MAX_WRAP = 32;
      for (let i = 0; i < MAX_WRAP && startRow > 0 && buf.getLine(startRow)?.isWrapped; i++) {
        startRow--;
      }
      let text = '';
      let tapOffset = -1;
      for (let r = startRow; r < startRow + MAX_WRAP; r++) {
        const line = buf.getLine(r);
        if (!line) break;
        if (r === tappedRow) tapOffset = text.length + (pos.col - 1);
        text += line.translateToString(false);
        const next = buf.getLine(r + 1);
        if (!next || !next.isWrapped) break;
      }
      if (tapOffset < 0) return null;
      for (const m of text.matchAll(/https?:\/\/[^\s"'<>`]+/g)) {
        const start = m.index ?? 0;
        if (tapOffset >= start && tapOffset < start + m[0].length) {
          return m[0].replace(/[.,;:!?)\]}>'"]+$/, '');
        }
      }
      return null;
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
      if (cursorScroll.replayActive) return;
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
      if (cursorScroll.replayActive) return;
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
        const fg = foregroundCmdRef.current;
        const mobile = isMobileLayout();
        // Cursor CLI runs on xterm's normal buffer without mouse reporting.
        // SGR wheel bytes would appear as literal input ( [<64;…M ).
        // `steps` is already in wheel units (finger down → negative → older),
        // matching the SGR path below — pass it through unchanged so both
        // scroll modes feel identical under the same gesture. (A previous
        // -steps inversion here made plain-shell/Cursor scrollback move
        // opposite to Claude panes.)
        if (shouldTouchScrollBuffer(term, fg, mobile)) {
          scrollBufferByLines(term, steps, mobile);
        } else {
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
      }
      e.preventDefault();
    };

    const mobileScrollRecover = () => {
      if (!isMobileLayout()) return;
      try {
        if (isCursorAgentCmd(foregroundCmdRef.current)) {
          const above = linesAboveBottom(term);
          const active = term.buffer.active;
          // Stale absolute offset — clamp to live prompt.
          if (above > active.baseY) {
            term.scrollToBottom();
          }
        }
        refreshVisibleRows(term);
      } catch {
        // ignore
      }
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
      // Also suppress on pointercancel: the OS/browser stole the gesture
      // (notification pull, edge swipe) — the user didn't tap the pane.
      if (e.type === 'pointerup' && !p.moved && pointers.size === 0 && !multiFingerGesture) {
        const tappedUrl = linkAtTap(p.startX, p.startY);
        if (tappedUrl) {
          // Tapped a link → open it in THIS device's browser (the phone),
          // not as a mouse click to the TUI (and never on the host machine).
          openUri(tappedUrl);
        } else if (!shouldTouchScrollBuffer(term, foregroundCmdRef.current, isMobileLayout())) {
          // Cursor / scrollback mode has no mouse reporting — SGR clicks would
          // become literal text, so only synthesize a click for a real
          // mouse-mode TUI.
          const pos = cellAt(p.startX, p.startY);
          if (pos) {
            const seq = `\x1b[<0;${pos.col};${pos.row}M\x1b[<0;${pos.col};${pos.row}m`;
            safeSend(encodeInput(seq));
          }
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
        mobileScrollRecover();
      }
      // Re-seed for any remaining pointers so the next move doesn't
      // see a delta computed against the lifted finger's Y.
      reseed();
    };
    container.addEventListener('pointerdown', onPointerDown);
    container.addEventListener('pointermove', onPointerMove);
    container.addEventListener('pointerup', onPointerUpOrCancel);
    container.addEventListener('pointercancel', onPointerUpOrCancel);

    // Desktop wheel → discrete scroll steps. A raw Chromium mouse notch is
    // ~100-120px of deltaY; round(|deltaY|/30) turned one notch into 3-4
    // steps (and a flick into 8), so the transcript flew past — and it had
    // no sub-notch memory, so a precision wheel / trackpad's stream of tiny
    // deltas each forced a full step. Accumulate deltaMode-normalized pixels
    // and emit one step per WHEEL_NOTCH_PX of travel: ~1 step per notch
    // (the pre-rework feel) while small deltas sum smoothly. Per-pane state
    // (this closure), so panes don't share an accumulator.
    const WHEEL_NOTCH_PX = 80; // ~one wheel notch of pixel delta
    const WHEEL_GESTURE_GAP_MS = 120; // silence that marks a new gesture
    let wheelAccumPx = 0;
    let lastWheelAt = 0;
    const wheelStepsFor = (e: WheelEvent): number => {
      const cell = getCellDimensions(term);
      const lineH = cell?.height && cell.height > 0 ? cell.height : 16;
      // Normalize line/page-mode wheels (Firefox, some mice) to pixels so
      // they aren't mis-scaled as if deltaY were already in pixels.
      // deltaMode: 1 = DOM_DELTA_LINE, 2 = DOM_DELTA_PAGE, else pixels.
      let px = e.deltaY;
      if (e.deltaMode === 1) {
        px = e.deltaY * lineH;
      } else if (e.deltaMode === 2) {
        px = e.deltaY * lineH * term.rows;
      }
      // Start of a new gesture (no wheel events for a beat): emit the first
      // step right away instead of swallowing it into the accumulator's dead
      // zone. Hi-res / macOS wheels emit a stream of small deltas per notch,
      // so without this kick the first notch of travel scrolls nothing and
      // scrolling feels slow to start.
      const now = e.timeStamp || performance.now();
      const idle = now - lastWheelAt > WHEEL_GESTURE_GAP_MS;
      lastWheelAt = now;
      // A direction flip discards leftover opposite travel, so the first
      // step the other way lands immediately.
      if (px < 0 !== wheelAccumPx < 0) wheelAccumPx = 0;
      wheelAccumPx += px;
      let steps = Math.trunc(wheelAccumPx / WHEEL_NOTCH_PX);
      if (idle && steps === 0 && Math.abs(px) >= 2) {
        // Kick: one step now in the motion direction; consume the travel.
        steps = px < 0 ? -1 : 1;
        wheelAccumPx = 0;
      } else if (steps !== 0) {
        wheelAccumPx -= steps * WHEEL_NOTCH_PX;
      }
      // Clamp one violent delta (free-spin flick coalesced into a single
      // event) so it can't leap multiple pages at once.
      if (steps > 4) steps = 4;
      else if (steps < -4) steps = -4;
      return steps;
    };

    // Capture-phase wheel on the pane container — must run before xterm's
    // bubble listener on term.element, which otherwise sends ↑/↓ to the
    // input composer when the TUI has no xterm scrollback.
    const sendWheelToPty = (e: WheelEvent): boolean => {
      const fg = foregroundCmdRef.current;
      const forward = shouldForwardWheelToPty(term, fg);
      const active = term.buffer.active;
      const ink = isInkForegroundCmd(fg);
      dbg('wheel', {
        forward,
        bufferScroll: shouldScrollXtermBuffer(term, fg),
        fg,
        type: active.type,
        hasScrollback: active.length > term.rows,
        mouse: term.element?.classList.contains('enable-mouse-events') ?? false,
        deltaY: e.deltaY,
      });
      if (!forward) return false;
      const steps = wheelStepsFor(e);
      // Sub-notch travel: consumed into the accumulator. Still report the
      // event as handled (return true) so xterm's fallback wheel handler
      // doesn't also process it and double-count this delta.
      if (steps === 0) return true;
      const hit = cellAt(e.clientX, e.clientY);
      // Aim at the transcript band (upper third), not the input row.
      const col = hit?.col ?? Math.max(1, Math.floor(term.cols / 2));
      const row = hit?.row ?? Math.max(1, Math.floor(term.rows / 4));
      const transcriptRow = Math.min(row, Math.max(1, Math.floor(term.rows / 3)));
      // The encoders derive their step count from |delta|/stepPx; hand them
      // a synthetic delta that yields exactly `steps` (one per accumulated
      // notch) in the original direction, instead of the raw pixel delta.
      const delta = steps * WHEEL_STEP_PX;
      const sent =
        triggerWheelMouseEvent(term, col, transcriptRow, delta, WHEEL_STEP_PX) ||
        safeSend(
          encodeInput(wheelInputForPty(term, col, transcriptRow, delta, WHEEL_STEP_PX, ink)),
        );
      if (!sent) {
        dbg('wheel dropped: ws not open');
        return false;
      }
      dbg('wheel→pty', { col, row: transcriptRow, steps, deltaY: e.deltaY });
      return true;
    };
    const onWheelCapture = (e: WheelEvent) => {
      if (cursorScroll.replayActive) return;
      const t = e.target;
      if (!(t instanceof Node) || !container.contains(t)) return;
      const fg = foregroundCmdRef.current;
      if (shouldScrollXtermBuffer(term, fg)) {
        if (scrollBufferWheel(term, e)) {
          const active = term.buffer.active;
          dbg('wheel→buffer', {
            viewportY: active.viewportY,
            baseY: active.baseY,
            deltaY: e.deltaY,
          });
          e.preventDefault();
          e.stopImmediatePropagation();
        }
        return;
      }
      if (!sendWheelToPty(e)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    // Document capture: mosaic/splitter chrome can swallow wheel before it
    // reaches the pane div; filter to this pane's container subtree.
    document.addEventListener('wheel', onWheelCapture, { capture: true, passive: false });
    // Belt-and-suspenders: xterm's fallback wheel path still runs when the
    // mouse protocol lacks the wheel bit; return false to block ↑/↓ there.
    term.attachCustomWheelEventHandler((e) => {
      if (cursorScroll.replayActive) return false;
      return !sendWheelToPty(e);
    });

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
        if (containerTooSmall()) return;
        const preserveScroll =
          isCursorAgentCmd(foregroundCmdRef.current) && linesAboveBottom(term) > 0;
        const scrollRatio = preserveScroll ? scrollRatioFromTerm(term) : 0;
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
        // Cache only on a confirmed send. If the socket isn't open yet the
        // frame is dropped; leaving the cache unchanged means the next
        // refit (or the WS 'open' handler) retries instead of dedup'ing.
        if (safeSend(encodeResize(cols, rows))) {
          lastSentCols = cols;
          lastSentRows = rows;
        }
        if (preserveScroll && scrollRatio > 0.001) {
          restoreLinesAboveBottom(term, linesAboveFromRatio(term, scrollRatio));
        }
        if (isMobileLayout() && isCursorAgentCmd(foregroundCmdRef.current)) {
          refreshVisibleRows(term);
        }
        tryInitialConnect();
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
    // NOTE: we deliberately do NOT refit when the mobile soft keyboard shows
    // or hides. The on-screen keyboard shrinks visualViewport, but refitting
    // to the smaller above-keyboard height would SIGWINCH the PTY and force a
    // running TUI (Claude Code, Ink) to reflow and reset its layout on every
    // composer focus. The terminal keeps its rows; the keyboard simply
    // overlays the bottom, and MobileInputBar floats itself above the
    // keyboard via its own visualViewport listener. (An earlier
    // installMobileViewportSync hook drove exactly that bad refit — removed.)
    // react-mosaic re-parenting can change a pane's available width without
    // firing ResizeObserver — fit to the new size on every layout-changed
    // notification. A single trailing-edge debounce coalesces overlapping
    // resize signals from RO, the layout-changed event, and window resize.
    let refitTimer: number | null = null;
    let hasSettledFirstResize = false;
    let lastRefitW = container.clientWidth;
    let lastRefitH = container.clientHeight;
    const scheduleRefit = () => {
      if (isCursorAgentCmd(foregroundCmdRef.current)) {
        const w = container.clientWidth;
        const h = container.clientHeight;
        if (Math.abs(w - lastRefitW) < 2 && Math.abs(h - lastRefitH) < 2) return;
        lastRefitW = w;
        lastRefitH = h;
      }
      if (refitTimer !== null) window.clearTimeout(refitTimer);
      const cursor = isCursorAgentCmd(foregroundCmdRef.current);
      const delay = cursor ? (hasSettledFirstResize ? 150 : 300) : hasSettledFirstResize ? 50 : 250;
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
      // Trailing repaint once the fit chain has settled. The immediate
      // refresh above runs against a slot that may have JUST flipped from
      // display:none (in-app tab switch — mobile and desktop both toggle
      // paneActive, NOT document visibility), so xterm's DOM renderer can
      // capture stale top rows before its cells finish laying out. An idle
      // pane (Claude finished drawing, no new write) has nothing else to
      // trigger the per-write repaint, so those garbled rows stick until the
      // next pane switch. This final refresh clears them. The lifecycle path
      // (reassertSizeFromEvent) schedules its own 600ms refresh; this makes
      // the direct callers (the become-visible effect) just as robust.
      const settleRefreshId = window.setTimeout(() => {
        try {
          term.refresh(0, term.rows - 1);
        } catch {
          // ignore — term may be disposed
        }
      }, 550);
      reassertSizeTimerIds.push(settleRefreshId);
    };
    reassertSizeRef.current = reassertSize;
    const reassertSizeFromEvent = (source: string) => {
      // Cursor: replay + refit + scroll-restore on lifecycle events fought
      // each other (reload dance, jump to top mid-session). Repaint only;
      // sizing goes through ResizeObserver / layout-changed; scroll stays
      // put unless the user moves it or replay finishes once on mount.
      if (isCursorAgentCmd(foregroundCmdRef.current)) {
        if (cursorScroll.replayActive) return;
        if (source === 'window.focus') return;
        try {
          term.refresh(0, term.rows - 1);
        } catch {
          // ignore
        }
        return;
      }
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
      // pageshow and resume always correlate with a real lifecycle resume
      // (the browser only fires them after a freeze/discard). visibilitychange
      // fires on every refocus though, including quick pulls-down on iOS;
      // gate it on a real hidden-duration so we don't wiggle on every flip.
      const HIDDEN_RESUME_MS = 2000;
      const hiddenFor = hiddenSince ? Date.now() - hiddenSince : 0;
      const isResume =
        source === 'pageshow' ||
        source === 'resume' ||
        (source === 'visibilitychange' && hiddenFor >= HIDDEN_RESUME_MS);
      // Cursor CLI redraws its whole transcript on SIGWINCH; the wiggle
      // round-trip looks like a fast scroll through session history.
      if (isResume && !isCursorAgentCmd(foregroundCmdRef.current)) {
        window.setTimeout(() => {
          const ws = wsRef.current;
          if (!ws || ws.readyState !== WebSocket.OPEN) return;
          // Same gates as every other resize sender. This wiggle used to be
          // the ONE path that skipped both mayDriveResize() and the dim
          // floor — a backgrounded client resuming against a throttled/tiny
          // layout viewport (iOS Safari) would SIGWINCH every pane down to
          // single-digit dims (8x4 storms in ptyd's [size] log), which reads
          // as "terminal panes not showing" on every other device.
          if (!mayDriveResize()) return;
          const cols = term.cols;
          const rows = term.rows;
          if (cols < MIN_COLS || rows < MIN_ROWS) return;
          try {
            // Wiggle UP (+1 col, then back) instead of down: the transient
            // never dips below the floor, so the server-side sub-floor
            // resize backstop (proxyAttach) can't eat half the wiggle.
            ws.send(encodeResize(cols + 1, rows));
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
    // Tracks the wall-clock time the page went hidden; used to gate the
    // wiggle inside reassertSizeFromEvent so quick refocuses don't trigger
    // the full SIGWINCH round-trip.
    let hiddenSince: number | null = document.visibilityState === 'hidden' ? Date.now() : null;
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        cursorScroll.onTabHidden(term);
        hiddenSince = Date.now();
      } else {
        // Real resume (not a quick flip): verify the socket actually
        // survived the background before trusting it with input.
        const hiddenForMs = hiddenSince ? Date.now() - hiddenSince : 0;
        reassertSizeFromEvent('visibilitychange');
        if (hiddenForMs >= 2000) probeLiveness(hiddenForMs);
        hiddenSince = null;
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    const onWinFocus = () => reassertSizeFromEvent('window.focus');
    window.addEventListener('focus', onWinFocus);

    // Reclaim the PTY size when the user returns to THIS device/pane after a
    // lull. The lifecycle reasserts above cover a backgrounded tab or a window
    // that lost focus — but NOT the common "desktop window stayed visible and
    // focused while a phone drove the same pane" case. There, nothing fires
    // when the user walks back, so the PTY stays at the phone's width. A real
    // interaction (click/keypress/focus) after an idle gap is the reliable
    // "I'm active here now" signal; on it we re-announce our size so the
    // mobile-driven SIGWINCH doesn't leave the desktop terminal stuck narrow.
    // Gated to desktop + a visible, drive-eligible pane so a mobile tap or a
    // hidden tab can't fight whoever is actually looking. The reassert force-
    // re-announces our size (it can't know the PTY's current width, so it must
    // resend), which costs a redundant SIGWINCH/redraw when no device-switch
    // actually happened — so the idle threshold is set to "you physically
    // stepped away" (20s), not "you paused reading output" (a few seconds).
    const REACTIVATE_IDLE_MS = 20_000;
    let lastInteractionAt = Date.now();
    const onLocalActivity = () => {
      const now = Date.now();
      const returned = now - lastInteractionAt >= REACTIVATE_IDLE_MS;
      lastInteractionAt = now;
      if (returned && !isMobileLayout() && mayDriveResize()) {
        reassertSizeFromEvent('reactivate');
      }
    };
    container.addEventListener('pointerdown', onLocalActivity);
    container.addEventListener('keydown', onLocalActivity, true);
    container.addEventListener('focusin', onLocalActivity);

    // Page Lifecycle API — fires on Chrome tab discard/restore and
    // process freeze/resume, which standard visibilitychange misses on
    // macOS when the OS suspends the renderer for a backgrounded display.
    const onPageShow = (e: PageTransitionEvent) => {
      if (isCursorAgentCmd(foregroundCmdRef.current) && !e.persisted) return;
      reassertSizeFromEvent('pageshow');
    };
    const onPageHide = () => cursorScroll.onPageHide(term);
    const onResume = () => reassertSizeFromEvent('resume');
    window.addEventListener('pageshow', onPageShow);
    window.addEventListener('pagehide', onPageHide);
    document.addEventListener('resume', onResume);

    // devicePixelRatio change (monitor swap, OS zoom, browser zoom) —
    // matchMedia is the canonical way to observe these. The query has
    // to be re-armed each time it fires; otherwise we only catch one.
    let dprMql: MediaQueryList | null = null;
    let dprChangeHandler: (() => void) | null = null;
    const armDprListener = () => {
      if (intentionallyClosed) return;
      // Detach the previous query's listener before swapping — otherwise each
      // DPR change leaks an immortal MediaQueryList+closure that fires against
      // the (eventually disposed) term and re-arms itself forever.
      if (dprMql && dprChangeHandler) dprMql.removeEventListener('change', dprChangeHandler);
      const current = window.devicePixelRatio;
      dprMql = window.matchMedia(`(resolution: ${current}dppx)`);
      dprChangeHandler = () => {
        if (intentionallyClosed) return;
        reassertSizeFromEvent('dpr');
        armDprListener();
      };
      dprMql.addEventListener('change', dprChangeHandler);
    };
    armDprListener();

    // Mount sizing is handled by fitWhenCellReady() + ResizeObserver +
    // scheduleRefit above. We intentionally do NOT call reassertSize()
    // here — that 0/100/250/500ms chain (and optional wiggle SIGWINCH on
    // resume) forces Ink TUIs to redraw on every tab/pane mount and resets
    // their scroll position. Lifecycle resume still uses reassertSize via
    // visibilitychange / pageshow / resume below.

    // Targeted-focus event: TabView dispatches this after deleting
    // a pane so the next remaining pane picks up focus without a click.
    const onFocusPane = (e: Event) => {
      const detail = (e as CustomEvent<{ paneId?: string }>).detail;
      // Not on mobile: the MobileInputBar owns input there, and focusing the
      // terminal's hidden textarea would yank focus off the composer and
      // dismiss the soft keyboard.
      if (detail?.paneId === paneId && !isMobileLayout()) term.focus();
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

    const onScrollBuffer = (e: Event) => {
      const detail = (
        e as CustomEvent<{
          paneId?: string;
          lines?: number;
          toBottom?: boolean;
        }>
      ).detail;
      if (detail?.paneId !== paneId) return;
      try {
        if (detail.toBottom) {
          term.scrollToBottom();
          refreshVisibleRows(term);
          return;
        }
        if (typeof detail.lines === 'number') {
          scrollBufferByLines(term, detail.lines, isMobileLayout());
          mobileScrollRecover();
        }
      } catch {
        // ignore — term may be disposed
      }
    };
    window.addEventListener('muxpad:scroll-buffer', onScrollBuffer);

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

    const dismissPasteToast = () => {
      if (pasteToastTimerRef.current !== null) {
        window.clearTimeout(pasteToastTimerRef.current);
        pasteToastTimerRef.current = null;
      }
      if (pasteToastPreviewUrlRef.current) {
        URL.revokeObjectURL(pasteToastPreviewUrlRef.current);
        pasteToastPreviewUrlRef.current = null;
      }
      setPasteToast(null);
    };
    const showPasteToast = (blob: Blob, path: string) => {
      dismissPasteToast();
      const previewUrl = URL.createObjectURL(blob);
      pasteToastPreviewUrlRef.current = previewUrl;
      setPasteToast({ previewUrl, path });
      pasteToastTimerRef.current = window.setTimeout(() => {
        pasteToastTimerRef.current = null;
        if (pasteToastPreviewUrlRef.current) {
          URL.revokeObjectURL(pasteToastPreviewUrlRef.current);
          pasteToastPreviewUrlRef.current = null;
        }
        setPasteToast(null);
      }, 3000);
    };

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
      let previewBlob: Blob | null = null;
      for (const item of imageItems) {
        const blob = item.getAsFile();
        if (!blob) continue;
        if (!previewBlob) previewBlob = blob;
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
      if (paths.length) {
        safeSend(encodeInput(`${paths.join(' ')} `));
        dbg('paste paths', paths);
        // Cursor agent renders attachments as a [image] chip; show a muxpad
        // preview so the user can confirm what was pasted.
        if (previewBlob) showPasteToast(previewBlob, paths.join(' '));
      }
      if (!imageOnly) {
        const text = companionTextForImagePaste(data.getData('text/plain'));
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
      container.removeEventListener('pointerdown', onLocalActivity);
      container.removeEventListener('keydown', onLocalActivity, true);
      container.removeEventListener('focusin', onLocalActivity);
      window.removeEventListener('pageshow', onPageShow);
      window.removeEventListener('pagehide', onPageHide);
      document.removeEventListener('resume', onResume);
      // Detach the live DPR listener so the MediaQueryList + its closure
      // (which captures `term`) can be GC'd. `intentionallyClosed` is already
      // true here, so any in-flight onDprChange also bails before re-arming.
      if (dprMql && dprChangeHandler) dprMql.removeEventListener('change', dprChangeHandler);
      dprMql = null;
      dprChangeHandler = null;
      for (const id of reassertSizeTimerIds) window.clearTimeout(id);
      if (refitTimer !== null) window.clearTimeout(refitTimer);
      window.removeEventListener('muxpad:focus-pane', onFocusPane);
      window.removeEventListener('muxpad:send-input', onSendInput);
      window.removeEventListener('muxpad:scroll-buffer', onScrollBuffer);
      container.removeEventListener('keydown', onKeyDown, true);
      container.removeEventListener('paste', onPaste, true);
      onData.dispose();
      writeParsedSub.dispose();
      scrollSub.dispose();
      cursorScroll.dispose();
      if (postWriteRefreshTimer !== null) window.clearTimeout(postWriteRefreshTimer);
      container.removeEventListener('pointerdown', onPointerDown);
      container.removeEventListener('pointermove', onPointerMove);
      container.removeEventListener('pointerup', onPointerUpOrCancel);
      container.removeEventListener('pointercancel', onPointerUpOrCancel);
      document.removeEventListener('wheel', onWheelCapture, { capture: true });
      term.attachCustomWheelEventHandler(() => true);
      container.removeEventListener('focusin', onFocusIn);
      container.removeEventListener('focusout', onFocusOut);
      toolbarEl?.removeEventListener('click', onToolbarClick);
      wsRef.current?.close();
      wsRef.current = null;
      window.clearInterval(staleTimer);
      extractor.dispose();
      chunker.dispose();
      if (termRef.current === term) termRef.current = null;
      if (fitRef.current === fit) fitRef.current = null;
      tryOpenTermRef.current = null;
      reassertSizeRef.current = null;
      dismissPasteToast();
      term.dispose();
    };
  }, [paneId]);

  // Refit when a hidden tab/pane slot becomes visible again. xterm keeps
  // its viewport while mounted — no scroll restore (that caused regressions).
  const wasPaneActiveRef = useRef(paneActive);
  useEffect(() => {
    const wasActive = wasPaneActiveRef.current;

    if (!wasActive && paneActive) {
      tryOpenTermRef.current?.();
      // Re-fit through the convergent 0/100/250/500ms chain rather than a
      // single rAF tick. A slot that just flipped from display:none hasn't
      // settled its layout, so a one-shot fit() can measure a near-zero
      // width and lock the terminal at a few columns (the "pane is 5% wide"
      // bug) until the next unrelated resize. reassertSize also clears the
      // size dedup so the corrected dims actually reach the PTY.
      reassertSizeRef.current?.();
      if (isMobileLayout()) {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            const term = termRef.current;
            if (term && isCursorAgentCmd(foregroundCmdRef.current)) {
              try {
                term.scrollToBottom();
                refreshVisibleRows(term);
              } catch {
                // ignore
              }
            }
          });
        });
      }
    }

    wasPaneActiveRef.current = paneActive;
  }, [paneActive]);

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
    <div
      className={`xterm-pane-wrapper${
        replayRestoring && isCursorAgentCmd(foregroundCmd) ? ' replay-restoring' : ''
      }`}
    >
      <div className="xterm-pane" ref={containerRef} tabIndex={0} />
      {reconnecting ? (
        <div className="xterm-reconnecting" role="status" aria-live="polite">
          <span className="xterm-reconnecting-dot" aria-hidden="true" />
          Reconnecting…
        </div>
      ) : null}
      {pasteToast ? (
        <div className="xterm-paste-toast" title={pasteToast.path}>
          <img
            className="xterm-paste-toast-preview"
            src={pasteToast.previewUrl}
            alt="Pasted screenshot"
          />
          <span className="xterm-paste-toast-path">{pasteToast.path}</span>
        </div>
      ) : null}
    </div>
  );
}
