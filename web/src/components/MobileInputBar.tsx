import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { companionTextForImagePaste, splitClipboard } from '../lib/clipboard-detect';
import { isCursorAgentCmd } from '../lib/xterm-internals';
import './MobileInputBar.css';

/**
 * Always-visible mobile composer for sending input to the active shell
 * pane. The native xterm hidden textarea + soft keyboard is awkward on
 * touch (the bar disappears, focus is finicky, no easy way to send Esc /
 * Tab / arrows), so on small viewports we render a real composer pinned
 * above the keyboard.
 *
 * The bar dispatches a `muxpad:send-input` CustomEvent which XtermPane
 * subscribes to. The event-bus indirection keeps this component from
 * needing a direct ref into the active terminal — it just knows the
 * paneId of the active pane.
 *
 * Behavior:
 *   - 1 line by default; grows up to MAX_VISIBLE_LINES as the user types
 *     or pastes; scrolls internally past that. Resets to 1 line after send.
 *   - The Send button submits the buffer with a trailing CR so a typed
 *     command actually runs. Empty submit sends a bare CR (a blank Enter).
 *   - The special-keys row above the composer sends raw escape sequences
 *     for Esc / Tab / arrows / Ctrl-C — keys an iOS keyboard can't reach.
 *
 * Hidden when the active pane is a URL pane (nothing to send to).
 */
export interface MobileInputBarProps {
  paneId: string | null;
  paneKind: 'shell' | 'url' | null;
  /** Best-effort foreground command — drives ↑/↓/End behavior. */
  foregroundCmd?: string | null | undefined;
}

/** Cap auto-grow at ~5 lines of text before the textarea scrolls internally. */
const MAX_VISIBLE_LINES = 5;
/** Px per line at the composer's font-size (14px / line-height ~1.4). */
const LINE_HEIGHT_PX = 20;

export function MobileInputBar({ paneId, paneKind, foregroundCmd = null }: MobileInputBarProps) {
  const cursorBufferScroll = isCursorAgentCmd(foregroundCmd);
  const [value, setValue] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);

  // Auto-grow: reset to auto so scrollHeight reflects content (not the
  // previous explicit height), then clamp to MAX_VISIBLE_LINES.
  const autoResize = () => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    const cap = LINE_HEIGHT_PX * MAX_VISIBLE_LINES;
    ta.style.height = `${Math.min(ta.scrollHeight, cap)}px`;
  };

  // Shrink back to 1 line after the parent swaps the active pane or
  // after a send clears the value.
  useEffect(() => {
    autoResize();
  }, [value]);

  // Anchor the bar's bottom edge to the visual viewport bottom (= top
  // of the on-screen keyboard when open). We position by `top`, not by
  // `bottom:0`, because iOS Safari's keyboard-aware handling of
  // bottom:0 fixed elements is inconsistent — sometimes it floats them
  // above the keyboard with a visible gap. Positioning by an
  // explicitly-computed top kills the ambiguity.
  //
  // Also mirrors the bar's height into a CSS variable so the workspace
  // above can leave matching padding-bottom (the bar is position:fixed
  // and doesn't reserve flow space).
  useEffect(() => {
    const el = barRef.current;
    if (!el) return;
    // In standalone PWA mode (home-screen install) iOS has no URL bar
    // or form-accessory bar to fight, and its native handling of
    // `position: fixed; bottom: 0` correctly anchors to the visual
    // viewport (= keyboard top) on its own. Our JS-positioning hack is
    // only needed for the in-browser case where iOS chrome would leave
    // a gap. So in standalone: keep CSS bottom:0 and skip the JS.
    const isStandalone =
      // iOS-specific legacy property
      (navigator as Navigator & { standalone?: boolean }).standalone === true ||
      window.matchMedia('(display-mode: standalone)').matches;

    let barHeight = el.offsetHeight;
    const ro = new ResizeObserver(() => {
      barHeight = el.offsetHeight;
      document.documentElement.style.setProperty('--mobile-input-bar-height', `${barHeight}px`);
      reposition();
    });
    ro.observe(el);

    let reposition = () => {};
    let cleanup = () => {};
    if (isStandalone) {
      el.style.bottom = '0';
      el.style.top = 'auto';
    } else {
      const vv = window.visualViewport;
      reposition = () => {
        const vH = vv ? vv.height : window.innerHeight;
        const vTop = vv ? vv.offsetTop : 0;
        el.style.top = `${vTop + vH - barHeight}px`;
        el.style.bottom = 'auto';
      };
      vv?.addEventListener('resize', reposition);
      vv?.addEventListener('scroll', reposition);
      // iOS Safari can fire visualViewport 'resize' only at the END of
      // its keyboard animation — run a short rAF loop on focus to track
      // through the slide.
      let trackingFrame: number | null = null;
      const trackUntil = (deadline: number) => {
        reposition();
        if (Date.now() < deadline) {
          trackingFrame = requestAnimationFrame(() => trackUntil(deadline));
        } else {
          trackingFrame = null;
        }
      };
      const onFocusIn = () => {
        if (trackingFrame !== null) cancelAnimationFrame(trackingFrame);
        trackUntil(Date.now() + 600);
      };
      const onFocusOut = () => {
        if (trackingFrame !== null) cancelAnimationFrame(trackingFrame);
        trackUntil(Date.now() + 600);
      };
      el.addEventListener('focusin', onFocusIn);
      el.addEventListener('focusout', onFocusOut);
      reposition();
      cleanup = () => {
        vv?.removeEventListener('resize', reposition);
        vv?.removeEventListener('scroll', reposition);
        el.removeEventListener('focusin', onFocusIn);
        el.removeEventListener('focusout', onFocusOut);
        if (trackingFrame !== null) cancelAnimationFrame(trackingFrame);
      };
    }
    return () => {
      ro.disconnect();
      cleanup();
      document.documentElement.style.removeProperty('--mobile-input-bar-height');
    };
  }, []);

  if (!paneId || paneKind !== 'shell') return null;

  const send = (data: string) => {
    window.dispatchEvent(
      new CustomEvent('muxpad:send-input', {
        detail: { paneId, data },
      }),
    );
  };

  const scrollBuffer = (lines: number) => {
    if (!paneId) return;
    window.dispatchEvent(
      new CustomEvent('muxpad:scroll-buffer', { detail: { paneId, lines } }),
    );
  };

  const scrollBufferBottom = () => {
    if (!paneId) return;
    window.dispatchEvent(
      new CustomEvent('muxpad:scroll-buffer', { detail: { paneId, toBottom: true } }),
    );
  };

  // Image paste: textareas don't natively accept image clipboard data —
  // we have to intercept paste, upload the blob to muxpad's attachments
  // endpoint, and splice the returned path into the textarea so the
  // user can add context before sending. Mirrors the XtermPane paste
  // handler so behavior matches between desktop xterm and mobile composer.
  const onPaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (!paneId) return;
    const { imageOnly, imageItems } = splitClipboard(e.clipboardData);
    if (imageItems.length === 0) return; // plain text → textarea handles it
    e.preventDefault();
    const paths: string[] = [];
    for (const item of imageItems) {
      const blob = item.getAsFile();
      if (!blob) continue;
      const ext = blob.type.split('/')[1] ?? 'png';
      try {
        const { path } = await api.uploadAttachment(paneId, blob, `pasted.${ext}`);
        paths.push(path);
      } catch {
        // ignore — drop this image; other items in the same paste still get a chance
      }
    }
    if (paths.length === 0) return;
    // Splice paths into the textarea content at the caret. Preserve any
    // text portion of the paste (clipboard can carry both) after the path.
    const ta = textareaRef.current;
    const start = ta?.selectionStart ?? value.length;
    const end = ta?.selectionEnd ?? value.length;
    const pasted = paths.join(' ') + ' ';
    const tail = imageOnly ? '' : companionTextForImagePaste(e.clipboardData.getData('text/plain'));
    const before = value.slice(0, start);
    const after = value.slice(end);
    setValue(`${before}${pasted}${tail}${after}`);
  };

  const submit = () => {
    // Read straight from the DOM, not React state: iOS predictive text and
    // composition events can land a final keystroke between the last
    // onChange and our click handler, leaving `value` one tick behind the
    // textarea's true contents.
    const current = textareaRef.current?.value ?? value;
    // One WS frame for text+CR avoids an intermediate TUI render between
    // "text at prompt" and "submitted" that can jerk Ink scroll position.
    // Empty submit = bare CR (blank Enter at the prompt).
    send(current.length > 0 ? `${current}\r` : '\r');
    setValue('');
    // useEffect on [value] resets the textarea height on next tick.
  };

  return (
    <div ref={barRef} className="mobile-input-bar" data-pane={paneId}>
      <div className="mobile-input-keys" role="toolbar" aria-label="Special keys">
        <button type="button" className="mobile-input-key" onClick={() => send('\x1b')}>
          Esc
        </button>
        <button type="button" className="mobile-input-key" onClick={() => send('\t')}>
          Tab
        </button>
        <button
          type="button"
          className="mobile-input-key"
          onClick={() =>
            cursorBufferScroll ? scrollBuffer(-8) : send('\x1b[A')
          }
          aria-label={cursorBufferScroll ? 'Scroll up' : 'Up'}
        >
          ↑
        </button>
        <button
          type="button"
          className="mobile-input-key"
          onClick={() =>
            cursorBufferScroll ? scrollBuffer(8) : send('\x1b[B')
          }
          aria-label={cursorBufferScroll ? 'Scroll down' : 'Down'}
        >
          ↓
        </button>
        <button
          type="button"
          className="mobile-input-key"
          onClick={() =>
            cursorBufferScroll
              ? scrollBufferBottom()
              : send('\x1b[6~'.repeat(50))
          }
          aria-label="Jump to bottom"
        >
          End
        </button>
        <button
          type="button"
          className="mobile-input-key mobile-input-key-danger"
          onClick={() => send('\x03')}
          aria-label="Ctrl-C interrupt"
        >
          ^C
        </button>
      </div>
      <div className="mobile-input-row">
        <textarea
          ref={textareaRef}
          className="mobile-input-textarea"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onPaste={onPaste}
          placeholder="Send to pane…"
          rows={1}
          // Keep iOS autocorrect / autocapitalize / spellcheck ON — the
          // composer is for natural-language input to Claude (and any
          // TUI that accepts prose). autoComplete stays off since this
          // isn't a form field that should suggest from history.
          autoComplete="off"
          // iOS won't show a submit affordance on a textarea's Return key;
          // Return inserts a newline, which is what we want for paste /
          // multi-line composition. Send button is the only submitter.
        />
        <button type="button" className="mobile-input-send" onClick={submit} aria-label="Send">
          Send
        </button>
      </div>
    </div>
  );
}
