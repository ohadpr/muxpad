import { type ComponentPropsWithoutRef, useEffect, useRef, useState } from 'react';
import { writeClipboard } from '../lib/clipboard-write';
import './CopyablePre.css';

/** Only block-level preformatted text gets a copy action. Keep the button
 * outside the pre so it neither scrolls with the code nor enters the copy. */
export function CopyablePre({ children, ...props }: ComponentPropsWithoutRef<'pre'>) {
  const content = useRef<HTMLPreElement>(null);
  const reset = useRef<ReturnType<typeof setTimeout>>();
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle');

  useEffect(() => () => clearTimeout(reset.current), []);

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
  return (
    <div className="copyable-block">
      <pre dir="ltr" {...props} ref={content}>
        {children}
      </pre>
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
