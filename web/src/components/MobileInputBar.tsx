import { useEffect, useRef } from 'react';
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
 * The composer is a `contenteditable` div, NOT a <textarea>: iOS attaches
 * its keyboard accessory bar (the "< > / Done" form-assistant strip) only
 * to real form controls. A contenteditable element isn't a form field, so
 * the keyboard comes up clean. We force plaintext editing and manage the
 * content imperatively via a ref (React must not own a contenteditable's
 * children or it fights the caret).
 *
 * Behavior:
 *   - 1 line by default; grows up to the CSS max-height as the user types
 *     or pastes; scrolls internally past that. Clears after send.
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

export function MobileInputBar({ paneId, paneKind, foregroundCmd = null }: MobileInputBarProps) {
  const cursorBufferScroll = isCursorAgentCmd(foregroundCmd);
  const editableRef = useRef<HTMLDivElement | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);

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
    window.dispatchEvent(new CustomEvent('muxpad:scroll-buffer', { detail: { paneId, lines } }));
  };

  const scrollBufferBottom = () => {
    if (!paneId) return;
    window.dispatchEvent(
      new CustomEvent('muxpad:scroll-buffer', { detail: { paneId, toBottom: true } }),
    );
  };

  // Toggle the empty state so the CSS :before placeholder shows/hides.
  // Driven off textContent (not :empty) so a stray <br> the browser may
  // leave behind doesn't keep the placeholder hidden on an empty field.
  const syncEmpty = () => {
    const el = editableRef.current;
    if (el) el.classList.toggle('is-empty', (el.textContent ?? '').length === 0);
  };

  const insertAtCaret = (text: string) => {
    const el = editableRef.current;
    if (!el) return;
    el.focus();
    // This runs after an await (image upload), by which point the prior
    // caret/selection may be gone (blur, context-menu paste). Collapse the
    // selection to the end of the field so the inserted path lands
    // predictably instead of at position 0 / nowhere.
    const sel = window.getSelection();
    if (sel) {
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    }
    // execCommand('insertText') respects the caret/selection and undo stack
    // in a contenteditable; fall back to append if unavailable.
    if (!document.execCommand('insertText', false, text)) {
      el.textContent = (el.textContent ?? '') + text;
    }
    syncEmpty();
  };

  // Image paste: text fields don't natively accept image clipboard data —
  // intercept paste, upload the blob to muxpad's attachments endpoint, and
  // splice the returned path in at the caret so the user can add context
  // before sending. Plain-text pastes fall through to the contenteditable's
  // own plaintext-only handling. Mirrors the XtermPane paste handler.
  const onPaste = async (e: React.ClipboardEvent<HTMLDivElement>) => {
    if (!paneId) return;
    const { imageOnly, imageItems } = splitClipboard(e.clipboardData);
    if (imageItems.length === 0) return; // plain text → contenteditable handles it
    e.preventDefault();
    // Read the text portion now — clipboardData is cleared once this handler
    // returns / awaits.
    const tail = imageOnly ? '' : companionTextForImagePaste(e.clipboardData.getData('text/plain'));
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
    insertAtCaret(`${paths.join(' ')} ${tail}`);
  };

  const submit = () => {
    const el = editableRef.current;
    const current = el?.textContent ?? '';
    // One WS frame for text+CR avoids an intermediate TUI render between
    // "text at prompt" and "submitted" that can jerk Ink scroll position.
    // Empty submit = bare CR (blank Enter at the prompt).
    send(current.length > 0 ? `${current}\r` : '\r');
    if (el) {
      el.textContent = '';
      el.focus(); // keep the keyboard up for the next command
      syncEmpty();
    }
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
          onClick={() => (cursorBufferScroll ? scrollBuffer(-8) : send('\x1b[A'))}
          aria-label={cursorBufferScroll ? 'Scroll up' : 'Up'}
        >
          ↑
        </button>
        <button
          type="button"
          className="mobile-input-key"
          onClick={() => (cursorBufferScroll ? scrollBuffer(8) : send('\x1b[B'))}
          aria-label={cursorBufferScroll ? 'Scroll down' : 'Down'}
        >
          ↓
        </button>
        <button
          type="button"
          className="mobile-input-key"
          onClick={() => (cursorBufferScroll ? scrollBufferBottom() : send('\x1b[6~'.repeat(50)))}
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
        {/* contenteditable, not <textarea>: keeps iOS's keyboard accessory
            bar off (it only attaches to real form controls). plaintext-only
            forces plain text + a sane paste model. */}
        <div
          ref={editableRef}
          className="mobile-input-editable is-empty"
          contentEditable="plaintext-only"
          suppressContentEditableWarning
          role="textbox"
          tabIndex={0}
          aria-multiline="true"
          aria-label="Send to pane"
          data-placeholder="Send to pane…"
          onInput={syncEmpty}
          onPaste={onPaste}
        />
        <button type="button" className="mobile-input-send" onClick={submit} aria-label="Send">
          Send
        </button>
      </div>
    </div>
  );
}
