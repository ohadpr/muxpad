import { useEffect, useRef, useState } from 'react';
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
}

/** Cap auto-grow at ~5 lines of text before the textarea scrolls internally. */
const MAX_VISIBLE_LINES = 5;
/** Px per line at the composer's font-size (14px / line-height ~1.4). */
const LINE_HEIGHT_PX = 20;

export function MobileInputBar({ paneId, paneKind }: MobileInputBarProps) {
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

  // Mirror the bar's height (which changes as the textarea grows) into
  // a CSS variable so the workspace-body above can leave room. The bar
  // is position:fixed (see MobileInputBar.css for why), so it doesn't
  // reserve space in the flex flow — the body has to compensate.
  useEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const h = entries[0]?.contentRect.height ?? 0;
      // Include the safe-area-inset padding the CSS adds (the
      // ResizeObserver reports content-rect height, not the full
      // border-box). offsetHeight covers border + padding.
      const full = el.offsetHeight || h;
      document.documentElement.style.setProperty('--mobile-input-bar-height', `${full}px`);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
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

  const submit = () => {
    // Empty submit = bare CR (a blank Enter at the prompt, sometimes
    // useful to refresh a prompt or break a TUI out of input mode).
    if (value.length === 0) {
      send('\r');
      return;
    }
    send(`${value}\r`);
    setValue('');
    // value→effect resets height, but the effect fires next tick — for
    // smoother UX shrink immediately as well.
    requestAnimationFrame(() => {
      if (textareaRef.current) textareaRef.current.style.height = 'auto';
    });
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
          onClick={() => send('\x1b[A')}
          aria-label="Up"
        >
          ↑
        </button>
        <button
          type="button"
          className="mobile-input-key"
          onClick={() => send('\x1b[B')}
          aria-label="Down"
        >
          ↓
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
          placeholder="Send to pane…"
          rows={1}
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
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
