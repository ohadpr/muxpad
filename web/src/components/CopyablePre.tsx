import { type ComponentPropsWithoutRef, useEffect, useRef, useState } from 'react';
import { writeClipboard } from '../lib/clipboard-write';
import './CopyablePre.css';

/** Only block-level preformatted text gets a copy action. Keep the buttons
 * outside the pre so they neither scroll with the code nor enter the copy. */
export function CopyablePre({ children, ...props }: ComponentPropsWithoutRef<'pre'>) {
  const content = useRef<HTMLPreElement>(null);
  const reset = useRef<ReturnType<typeof setTimeout>>();
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle');
  /**
   * ── WRAP, FOR THE LINES THAT RUN OFF THE EDGE ──────────────────────────
   *
   * A block keeps `white-space: pre` on a desktop, which is right for code:
   * indentation is meaning, and there is a scrollbar and a pointer to move
   * it with. It is wrong for the thing people actually paste into these
   * blocks most often — an email, a prompt, a paragraph of prose — where the
   * sentence simply disappears past the right edge and the only way to read
   * it is to drag a bar sideways, one screen at a time, losing your line
   * each time you come back.
   *
   * So: a second button. Not a setting and not a default — the block keeps
   * the behaviour that is right for code, and a reader who needs the whole
   * sentence asks for it, per block, in the moment.
   */
  const [wrap, setWrap] = useState(false);
  /**
   * …and the button only exists when there is something to unwrap.
   *
   * A control that does nothing is worse than no control: it is the only
   * thing in this corner, a reader will press it once, and nothing will
   * happen. `scrollWidth > clientWidth` is the question asked exactly — does
   * this block have content past its right edge — rather than a guess from
   * the character count, which is wrong for a proportional face and wrong
   * again at every pane width.
   */
  const [overflows, setOverflows] = useState(false);

  useEffect(() => () => clearTimeout(reset.current), []);

  // Re-measured on every resize, because the pane is resizable and the answer
  // changes with it: a block that fits a wide pane overflows a narrow one.
  // `ResizeObserver` on the element itself rather than a window listener —
  // the rail drag changes this width without the window changing at all.
  useEffect(() => {
    const el = content.current;
    if (!el) return;
    const measure = () => setOverflows(el.scrollWidth > el.clientWidth + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
    // `children` is in the deps because a streaming block grows line by line:
    // the first token does not overflow and the fortieth does.
  }, [children]);

  async function copy() {
    const text = content.current?.textContent;
    if (text == null) return;
    const ok = await writeClipboard(text);
    setStatus(ok ? 'copied' : 'failed');
    clearTimeout(reset.current);
    reset.current = setTimeout(() => setStatus('idle'), 2000);
  }

  const label =
    status === 'copied' ? 'Copied' : status === 'failed' ? 'Copy failed — try again' : 'Copy block';
  const wrapLabel = wrap ? 'Stop wrapping long lines' : 'Wrap long lines';
  return (
    <div className="copyable-block">
      <pre dir="ltr" {...props} ref={content} data-wrap={wrap ? 'true' : undefined}>
        {children}
      </pre>
      {/* The wrap toggle sits BEFORE copy in the DOM and to its left on
          screen: copy is the action this corner has always had, and a control
          that appears and disappears with the content must not be the one
          that moves the stable one around. */}
      {overflows || wrap ? (
        <button
          type="button"
          className="copyable-block-button copyable-block-wrap"
          aria-pressed={wrap}
          aria-label={wrapLabel}
          title={wrapLabel}
          onClick={(event) => {
            event.stopPropagation();
            setWrap((v) => !v);
          }}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            {/* Two full lines and a third that turns back on itself — the
                standard "wrap" mark, and the one thing that reads at 16px. */}
            <path d="M4 6h16M4 18h6" />
            <path d="M4 12h13a3 3 0 0 1 0 6h-3" />
            <path d="m16 15-2 3 2 3" />
          </svg>
        </button>
      ) : null}
      <button
        type="button"
        className="copyable-block-button"
        data-status={status}
        aria-label={label}
        title={label}
        onClick={(event) => {
          event.stopPropagation();
          void copy();
        }}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          {status === 'copied' ? (
            <path d="m5 12 4 4L19 6" />
          ) : status === 'failed' ? (
            <path d="M12 5v9m0 4v1" />
          ) : (
            <>
              <rect x="8" y="8" width="12" height="12" rx="2" />
              <path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" />
            </>
          )}
        </svg>
      </button>
      <output className="copyable-block-status">{status === 'idle' ? '' : label}</output>
    </div>
  );
}
