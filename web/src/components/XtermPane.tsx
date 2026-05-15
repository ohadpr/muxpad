import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { encodeInput, encodeResize, decodeServerMessage, encodePing } from '@muxpad/shared';
import { api } from '../api';
import { getCellDimensions, setScrollBarWidthZero } from '../lib/xterm-internals';
import { splitClipboard } from '../lib/clipboard-detect';
import { createSafeClipboardAddon } from '../lib/safe-clipboard-provider';
import { writeClipboard } from '../lib/clipboard-write';
import { ChunkedWriter, SyncBlockExtractor } from '../lib/write-coalescer';
import { getSettings, useSettings, type Theme } from '../settings';
import './XtermPane.css';

// Debug logging: enable via URL flag (?debug=1) OR localStorage
// (muxpad.debug=1). localStorage survives the / → /w/:slug → /w/:slug/t/:slug
// redirect chain that strips unknown query params.
const DEBUG =
  typeof window !== 'undefined' &&
  (new URLSearchParams(window.location.search).get('debug') === '1' ||
    window.localStorage?.getItem('muxpad.debug') === '1');
const dbg = (...args: unknown[]) => { if (DEBUG) console.log('[XtermPane]', ...args); };

export interface XtermPaneProps {
  paneId: string;
  /** Called when the server tells us the underlying PTY exited. */
  onExit?: ((code: number) => void) | undefined;
}

const XTERM_THEMES: Record<Theme, {
  background: string;
  foreground: string;
  cursor: string;
  selectionBackground: string;
}> = {
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

export function XtermPane({ paneId, onExit }: XtermPaneProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const scrollbarRef = useRef<HTMLDivElement | null>(null);
  const thumbRef = useRef<HTMLDivElement | null>(null);
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
    term.loadAddon(new WebLinksAddon());
    termRef.current = term;
    fitRef.current = fit;

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

        // Belt-and-suspenders: force xterm's cached scrollBarWidth to 0.
        // We hide the native viewport scrollbar via CSS and render our own
        // overlay below. On systems with overlay scrollbars (most macOS)
        // xterm already measures 0; on always-show systems it measures
        // ~14px and fit-addon would reserve that space, leaving an empty
        // gutter. Zeroing the cached value keeps cells flush regardless.
        // Private API — try/catch falls back to the previous behavior if
        // a future xterm version moves this field.
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
            if (ws && ws.readyState === WebSocket.OPEN) {
              lastSentCols = term.cols;
              lastSentRows = term.rows;
              ws.send(encodeResize(term.cols, term.rows));
            }
          } catch {
            // container may not yet be sized; resize observer will retry.
          }
        };
        requestAnimationFrame(initialFit);
        // Belt-and-suspenders: if cell measurement is still pending after
        // one frame (some renderers need a beat longer), retry once more.
        setTimeout(initialFit, 100);
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
        idleTimer = window.setTimeout(() => {
          dbg('heartbeat ping');
          safeSend(encodePing());
          pongWaitTimer = window.setTimeout(() => {
            dbg('heartbeat pong timeout — force-closing');
            try { ws.close(); } catch { /* ignore */ }
          }, HEARTBEAT_PONG_MS);
        }, Math.max(0, HEARTBEAT_IDLE_MS - elapsed));
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
        // Always re-announce size on (re)connect. Cache on confirmed send
        // so a race where the socket flips closed doesn't poison the dedup.
        if (safeSend(encodeResize(term.cols, term.rows))) {
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

      ws.addEventListener('close', () => {
        if (idleTimer !== null) window.clearTimeout(idleTimer);
        if (pongWaitTimer !== null) window.clearTimeout(pongWaitTimer);
        dbg('ws close', { paneId, intentionallyClosed, paneExited, retries });
        if (wsRef.current === ws) wsRef.current = null;
        if (intentionallyClosed || paneExited) return;
        const delay = Math.min(200 * 2 ** retries, 5000);
        if (retries === 0) term.writeln(`\r\n[connection lost, reconnecting…]`);
        retries++;
        retryTimer = window.setTimeout(connect, delay);
      });
    };

    connect();

    const onData = term.onData((d) => safeSend(encodeInput(d)));

    // Custom overlay scrollbar — drawn on top of the xterm content so it
    // doesn't take any width away from the cell grid AND doesn't visually
    // occlude the rightmost cells (it's only 6px wide vs the native ~14px
    // overlay). Hooked to xterm's scroll state to keep the thumb in sync.
    const updateScrollbar = () => {
      const sb = scrollbarRef.current;
      const thumb = thumbRef.current;
      if (!sb || !thumb) return;
      const buf = term.buffer.active;
      const totalRows = buf.length;
      const visibleRows = term.rows;
      if (totalRows <= visibleRows) {
        sb.dataset.visible = 'false';
        return;
      }
      sb.dataset.visible = 'true';
      const heightPct = Math.max(8, (visibleRows / totalRows) * 100);
      const maxScroll = totalRows - visibleRows;
      const progress = maxScroll > 0 ? buf.viewportY / maxScroll : 0;
      const topPct = progress * (100 - heightPct);
      thumb.style.top = `${topPct}%`;
      thumb.style.height = `${heightPct}%`;
    };
    let scrollbarRaf: number | null = null;
    const scheduleScrollbarUpdate = () => {
      if (scrollbarRaf !== null) return;
      scrollbarRaf = requestAnimationFrame(() => {
        scrollbarRaf = null;
        updateScrollbar();
      });
    };
    const scrollSub = term.onScroll(scheduleScrollbarUpdate);
    const lineFeedSub = term.onLineFeed(scheduleScrollbarUpdate);
    const termResizeSub = term.onResize(scheduleScrollbarUpdate);
    const writeParsedSub = term.onWriteParsed(scheduleScrollbarUpdate);
    // Initial state in case the buffer arrives before the first event.
    requestAnimationFrame(updateScrollbar);

    // Make the overlay scrollbar interactive — press the track or drag to
    // scroll. This is the ONLY way to reach scrollback when the inner app
    // (Claude Code) has mouse reporting on and swallows wheel/touch events,
    // and it gives mobile a reliable scroll affordance. Pointer events cover
    // mouse + touch + pen uniformly; setPointerCapture keeps the drag alive
    // when the pointer slides off the 14px-wide hit strip.
    const sbEl = scrollbarRef.current;
    let sbDragging = false;
    const scrollToPointer = (clientY: number) => {
      if (!sbEl) return;
      const rect = sbEl.getBoundingClientRect();
      if (rect.height <= 0) return;
      const frac = Math.min(1, Math.max(0, (clientY - rect.top) / rect.height));
      const maxScroll = Math.max(0, term.buffer.active.length - term.rows);
      term.scrollToLine(Math.round(frac * maxScroll));
    };
    const onSbPointerDown = (e: PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      sbDragging = true;
      try {
        sbEl?.setPointerCapture(e.pointerId);
      } catch {
        // ignore — capture is best-effort
      }
      scrollToPointer(e.clientY);
    };
    const onSbPointerMove = (e: PointerEvent) => {
      if (!sbDragging) return;
      scrollToPointer(e.clientY);
    };
    const onSbPointerUp = (e: PointerEvent) => {
      sbDragging = false;
      try {
        sbEl?.releasePointerCapture(e.pointerId);
      } catch {
        // ignore
      }
    };
    sbEl?.addEventListener('pointerdown', onSbPointerDown);
    sbEl?.addEventListener('pointermove', onSbPointerMove);
    sbEl?.addEventListener('pointerup', onSbPointerUp);
    sbEl?.addEventListener('pointercancel', onSbPointerUp);

    const MIN_COLS = 40;
    const MIN_ROWS = 10;
    let lastSentCols = 0;
    let lastSentRows = 0;
    const refit = () => {
      try {
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
        dbg('refit', { cols, rows, w: container.clientWidth, h: container.clientHeight });
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
    // wrapped so a future xterm rename falls back to a no-op (the
    // belt-and-suspenders rAF/setTimeout initialFit above will still run).
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
    // churn disrupts the in-progress touch-scroll gesture. The container
    // ResizeObserver + window 'resize' already cover keyboard show/hide
    // adequately; the draggable overlay scrollbar covers the rest.
    const onOrientation = () => scheduleRefit();
    window.screen.orientation?.addEventListener('change', onOrientation);

    // Re-assert our terminal size to the PTY whenever this tab becomes the
    // active one (visibilitychange) or the window regains focus. The server
    // is last-writer-wins, so returning to a tab that sat idle while another
    // device drove the same pane immediately reclaims the PTY size for THIS
    // view — no manual resize nudge needed. Bypasses the dedup cache (the
    // PTY may have changed under us) but still respects the dim floor and
    // confirmed-send caching.
    const reassertSize = () => {
      try {
        fit.fit();
        const cols = term.cols;
        const rows = term.rows;
        if (cols < MIN_COLS || rows < MIN_ROWS) return;
        dbg('reassert size', { cols, rows });
        if (safeSend(encodeResize(cols, rows))) {
          lastSentCols = cols;
          lastSentRows = rows;
        }
      } catch {
        // ignore — the ResizeObserver / next refit will retry
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') reassertSize();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', reassertSize);

    // Targeted-focus event: TabView dispatches this after deleting
    // a pane so the next remaining pane picks up focus without a click.
    const onFocusPane = (e: Event) => {
      const detail = (e as CustomEvent<{ paneId?: string }>).detail;
      if (detail?.paneId === paneId) term.focus();
    };
    window.addEventListener('muxpad:focus-pane', onFocusPane);

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
      if (
        e.key === 'Enter' &&
        e.shiftKey &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey
      ) {
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
      window.removeEventListener('focus', reassertSize);
      if (refitTimer !== null) window.clearTimeout(refitTimer);
      window.removeEventListener('muxpad:focus-pane', onFocusPane);
      container.removeEventListener('keydown', onKeyDown, true);
      container.removeEventListener('paste', onPaste, true);
      onData.dispose();
      scrollSub.dispose();
      lineFeedSub.dispose();
      termResizeSub.dispose();
      writeParsedSub.dispose();
      sbEl?.removeEventListener('pointerdown', onSbPointerDown);
      sbEl?.removeEventListener('pointermove', onSbPointerMove);
      sbEl?.removeEventListener('pointerup', onSbPointerUp);
      sbEl?.removeEventListener('pointercancel', onSbPointerUp);
      if (scrollbarRaf !== null) cancelAnimationFrame(scrollbarRaf);
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
      <div
        className="xterm-pane-scrollbar"
        ref={scrollbarRef}
        data-visible="false"
        aria-hidden="true"
      >
        <div className="xterm-pane-scrollbar-thumb" ref={thumbRef} />
      </div>
    </div>
  );
}
