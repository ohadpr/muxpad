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
   * ── WRAPPED BY DEFAULT. THE TEXT IS THE POINT ──────────────────────────
   *
   * This started as an opt-in: the block kept `white-space: pre`, which is
   * right for CODE — indentation is meaning, and a desktop has a scrollbar
   * and a pointer to move it with — and a reader who wanted the whole
   * sentence pressed a button for it, per block, in the moment.
   *
   * That was the wrong default, and the reason is what these blocks actually
   * hold. Most of them are not code. They are an email, a prompt, a report, a
   * paragraph of prose the agent put in a fence — and for those, `pre` means
   * the sentence simply disappears past the right edge, with nothing on
   * screen saying there is anything to the right. The reader has to notice a
   * control, guess what it does, and press it, in order to see text that was
   * written to be read. "Default wrap so the text is visible."
   *
   * So the default is wrapped and the button now does the other thing: give
   * me back the original line structure, for the minority of blocks where the
   * shape IS the content. The cost lands on the case that can afford it —
   * indentation is recoverable with one press; words clipped at an edge you
   * cannot see are not recoverable at all, because you never knew they were
   * there.
   */
  const [wrap, setWrap] = useState(true);
  /**
   * …and the button only exists when it would DO something.
   *
   * A control that does nothing is worse than no control: it is one of two
   * things in that corner, a reader will press it once, and nothing will
   * happen. So the question is asked exactly, and it is a different question
   * in each state:
   *
   *   WRAPPED (the default) — is anything actually being wrapped? Compare the
   *     rendered height against the logical line count times the line height.
   *     A block whose lines all fit needs no unwrap button.
   *   UNWRAPPED — is anything past the right edge? `scrollWidth >
   *     clientWidth`, the original measurement, still exactly right here.
   *
   * Both are measurements rather than guesses from the character count, which
   * is wrong for a proportional face and wrong again at every pane width.
   */
  const [useful, setUseful] = useState(false);

  useEffect(() => () => clearTimeout(reset.current), []);

  // Re-measured on every resize, because the pane is resizable and the answer
  // changes with it: a block that fits a wide pane overflows a narrow one.
  // `ResizeObserver` on the element itself rather than a window listener —
  // the rail drag changes this width without the window changing at all.
  useEffect(() => {
    const el = content.current;
    if (!el) return;
    const measure = () => {
      if (!wrap) {
        setUseful(el.scrollWidth > el.clientWidth + 1);
        return;
      }
      // Wrapped: a logical line that became two visual ones makes the block
      // taller than its own line count.
      //
      // MEASURED ON THE `code`, NOT THE `pre`, and that one word was the whole
      // bug. The text lives in the code element at its own font and leading
      // (0.8225em, 1.55 — about 19.8px); the pre carries the conversation's
      // prose leading, about 25.1px. Reading the bigger number and comparing
      // it against the smaller rows meant a 40-line block with five wrapping
      // lines showed no button at all — it took roughly ten extra wrapped rows
      // before one appeared. The pre's padding was in `scrollHeight` too,
      // paying for another half-row of slack in the same direction.
      const box = (el.firstElementChild as HTMLElement | null) ?? el;
      const lh = Number.parseFloat(getComputedStyle(box).lineHeight);
      if (!Number.isFinite(lh) || lh <= 0) {
        // `normal` is not a number. Fail toward the control EXISTING: the
        // default is wrapped, so being wrong costs a button nobody needs
        // rather than a reader who cannot get the original shape back.
        setUseful(true);
        return;
      }
      // A trailing newline is not a line — a fenced block almost always has
      // one, and counting it bought a whole row of false slack.
      const lines = (box.textContent ?? '').replace(/\n$/, '').split('\n').length;
      setUseful(box.getBoundingClientRect().height > lines * lh + 1);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
    // `children` is in the deps because a streaming block grows line by line:
    // the first token does not wrap and the fortieth does. `wrap` is in them
    // because the two states ask different questions.
  }, [children, wrap]);

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
  const wrapLabel = wrap ? 'Show the original line breaks' : 'Wrap long lines';
  return (
    <div className="copyable-block">
      <pre dir="ltr" {...props} ref={content} data-wrap={wrap ? 'true' : undefined}>
        {children}
      </pre>
      {/* The wrap toggle sits BEFORE copy in the DOM and to its left on
          screen: copy is the action this corner has always had, and a control
          that appears and disappears with the content must not be the one
          that moves the stable one around. */}
      {useful || !wrap ? (
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
