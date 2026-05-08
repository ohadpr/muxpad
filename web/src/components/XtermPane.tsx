import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { encodeInput, encodeResize, decodeServerMessage } from '@muxpad/shared';
import { api } from '../api';
import { useSettings, type Theme } from '../settings';
import './XtermPane.css';

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

  // Recreate the entire terminal on paneId or settings change. xterm.js's
  // live option-update path (term.options.fontFamily = …) doesn't reliably
  // re-measure or re-render across renderer internals; teardown + rebuild
  // is the only deterministic path. The server replays the ring buffer on
  // reconnect, so visual state is preserved (you lose selection + scroll).
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      fontFamily: settings.fontFamily,
      fontSize: settings.fontSize,
      cursorBlink: true,
      theme: themeFor(settings.theme),
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new ClipboardAddon());
    term.loadAddon(new WebLinksAddon());

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
      .load(`${settings.fontSize}px ${settings.fontFamily}`)
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
        try {
          const core = (
            term as unknown as { _core?: { viewport?: { scrollBarWidth?: number } } }
          )._core;
          if (core?.viewport) core.viewport.scrollBarWidth = 0;
        } catch {
          // ignore
        }

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

    const safeSend = (frame: Uint8Array) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(frame);
    };

    const connect = () => {
      const ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;

      ws.addEventListener('open', () => {
        if (retries > 0) term.writeln('\r\n[reconnected]');
        retries = 0;
        try {
          fit.fit();
        } catch {
          // ignore
        }
        safeSend(encodeResize(term.cols, term.rows));
      });

      ws.addEventListener('message', (e) => {
        const buf = new Uint8Array(e.data as ArrayBuffer);
        const msg = decodeServerMessage(buf);
        if (msg.kind === 'output') {
          term.write(msg.data);
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
        }
      });

      ws.addEventListener('close', () => {
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
    const scrollSub = term.onScroll(() => updateScrollbar());
    const lineFeedSub = term.onLineFeed(() => updateScrollbar());
    const termResizeSub = term.onResize(() => updateScrollbar());
    // Initial state in case the buffer arrives before the first event.
    requestAnimationFrame(updateScrollbar);

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
        safeSend(encodeResize(term.cols, term.rows));
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
      const cell = (
        term as unknown as {
          _core?: { _renderService?: { dimensions?: { css?: { cell?: { width: number; height: number } } } } };
        }
      )._core?._renderService?.dimensions?.css?.cell;
      if (cell && cell.width > 0 && cell.height > 0) {
        refit();
        return;
      }
      if (attemptsLeft > 0) {
        window.setTimeout(() => fitWhenCellReady(attemptsLeft - 1), 50);
      }
    };
    fitWhenCellReady();
    const resizeObs = new ResizeObserver(refit);
    resizeObs.observe(container);
    // react-mosaic re-parenting can change a pane's available width without
    // firing ResizeObserver — fit to the new size on every layout-changed
    // notification. Spam refits across the mosaic transition window
    // (≈300ms) so we catch the final settled size regardless of timing.
    const refitBurst = () => {
      // First fit immediately for the common case (cell metrics already
      // measured), then a couple delayed retries to catch the *settled*
      // container size once the mosaic transition completes. The readiness
      // check guards against fit-addon's silent bail when cell.width is 0.
      fitWhenCellReady();
      window.setTimeout(() => fitWhenCellReady(), 240);
      window.setTimeout(() => fitWhenCellReady(), 600);
    };
    window.addEventListener('muxpad:layout-changed', refitBurst);
    // Backup for cases where ResizeObserver doesn't fire — e.g. browser
    // window resize that reflows mosaic via flex without changing the
    // pane element's CSS dimensions in a way RO notices.
    const onWindowResize = () => refitBurst();
    window.addEventListener('resize', onWindowResize);

    // Targeted-focus event: WorkspaceView dispatches this after deleting
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
          void navigator.clipboard.writeText(sel);
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
      const images = Array.from(data.items).filter((i) => i.type.startsWith('image/'));
      if (images.length === 0) return;
      e.preventDefault();
      e.stopPropagation();
      const paths: string[] = [];
      for (const item of images) {
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
      if (paths.length) safeSend(encodeInput(`${paths.join(' ')} `));
    };
    container.addEventListener('paste', onPaste, true);

    return () => {
      intentionallyClosed = true;
      opened = true; // skip the deferred open if it fires after unmount
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      resizeObs.disconnect();
      window.removeEventListener('muxpad:layout-changed', refitBurst);
      window.removeEventListener('resize', onWindowResize);
      window.removeEventListener('muxpad:focus-pane', onFocusPane);
      container.removeEventListener('keydown', onKeyDown, true);
      container.removeEventListener('paste', onPaste, true);
      onData.dispose();
      scrollSub.dispose();
      lineFeedSub.dispose();
      termResizeSub.dispose();
      container.removeEventListener('focusin', onFocusIn);
      container.removeEventListener('focusout', onFocusOut);
      toolbarEl?.removeEventListener('click', onToolbarClick);
      wsRef.current?.close();
      wsRef.current = null;
      term.dispose();
    };
  }, [paneId, settings.fontFamily, settings.fontSize, settings.theme]);

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
