import { useEffect, useRef, useState } from 'react';
import { checkFrame, linkHost, markUnframeable } from '../lib/link-sheet';
import './LinkSheet.css';

/**
 * A tapped link, opened in a sheet over the conversation — the way the native
 * X/Twitter app does it — instead of being handed to the OS.
 *
 * ONE SLIM BAR: ✕, the site, and the way out to a real browser.
 *
 * BOTTOM-ANCHORED, ~72% of the height. On a phone the bottom is where the thumb
 * is: the X, the grabber and "open in browser" sit in the sheet's top bar, a
 * thumb's reach from the bottom edge, and the conversation stays visible above
 * it — the message you tapped is usually right there. Tapping that visible
 * strip closes the sheet, and so does dragging the bar down, so there are three
 * ways back and none of them needs finding.
 *
 * THE PAGE IS A PLAIN <iframe>, and only when the site allows framing — the
 * server reads its X-Frame-Options and CSP (see /api/open/frame). A site that
 * refuses, an answer that does not come, a frame that never loads: each hands
 * the link to the OS browser. Nothing here streams a headless browser.
 */

export interface LinkSheetProps {
  url: string;
  onClose: () => void;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
  /** How long a frame may take to load before the OS browser gets the link. */
  loadTimeoutMs?: number;
}

/** How far the bar has to be dragged down to close the sheet. */
const DISMISS_DRAG_PX = 80;

export function LinkSheet({ url, onClose, fetchImpl, loadTimeoutMs = 8_000 }: LinkSheetProps) {
  const [state, setState] = useState<'checking' | 'framing' | 'loaded' | 'native'>('checking');
  const [drag, setDrag] = useState(0);
  const dragFrom = useRef<number | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  // Ask whether this page may be framed here; a no goes to the OS browser.
  useEffect(() => {
    let live = true;
    setState('checking');
    void checkFrame(url, window.location.origin, fetchImpl).then((frame) => {
      if (!live) return;
      if (frame) {
        setState('framing');
        return;
      }
      setState('native');
      // Usually still inside the tap's activation window. If the platform
      // blocks it anyway, the sheet says so and offers the one-tap link.
      if (openNative(url)) closeRef.current();
    });
    return () => {
      live = false;
    };
  }, [url, fetchImpl]);

  // A frame that never loads (a network hang, a refusal the headers did not
  // show) is a doubt — and a doubt goes to the OS browser.
  useEffect(() => {
    if (state !== 'framing') return;
    const id = setTimeout(() => {
      markUnframeable(url);
      setState('native');
    }, loadTimeoutMs);
    return () => clearTimeout(id);
  }, [state, url, loadTimeoutMs]);

  // Escape, on the document: focus may live in the frame.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const host = linkHost(url);
  const label = `link · ${host}`;
  const dragStyle =
    drag > 0 ? { transform: `translateY(${drag}px)`, transition: 'none' } : undefined;

  return (
    <div className="link-sheet" data-testid="link-sheet">
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: Escape is handled on the document above. */}
      <div className="link-sheet__scrim" data-testid="link-sheet-scrim" onClick={onClose} />
      {/* biome-ignore lint/a11y/useSemanticElements: same reasons as BrowserModal — a framed page owns focus, Escape is bound on the document. */}
      <div className="link-sheet__panel" role="dialog" aria-label={label} style={dragStyle}>
        <div
          className="link-sheet__bar"
          data-testid="link-sheet-bar"
          onPointerDown={(e) => {
            if ((e.target as Element).closest('a,button')) return;
            dragFrom.current = e.clientY;
            (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
          }}
          onPointerMove={(e) => {
            if (dragFrom.current !== null) setDrag(Math.max(0, e.clientY - dragFrom.current));
          }}
          onPointerUp={(e) => {
            if (dragFrom.current === null) return;
            const dy = e.clientY - dragFrom.current;
            dragFrom.current = null;
            setDrag(0);
            if (dy > DISMISS_DRAG_PX) onClose();
          }}
          onPointerCancel={() => {
            dragFrom.current = null;
            setDrag(0);
          }}
        >
          <span className="link-sheet__grabber" aria-hidden="true" />
          <button
            type="button"
            className="link-sheet__close"
            aria-label="Close"
            title="Close (Esc)"
            onClick={onClose}
          >
            ✕
          </button>
          <span className="link-sheet__host" title={url}>
            {host}
          </span>
          {/* The way out to a REAL browser: logging in somewhere, or a page you
              mean to keep. Opted out of the chat's link interception. */}
          <a
            className="link-sheet__out"
            href={url}
            target="_blank"
            rel="noreferrer noopener"
            data-native-link=""
            onClick={() => onClose()}
          >
            Open in browser ↗
          </a>
        </div>
        {state === 'framing' || state === 'loaded' ? (
          <iframe
            className="link-sheet__frame"
            title={`page · ${host}`}
            src={url}
            referrerPolicy="no-referrer"
            // Its own origin, its own scripts — but never muxpad's top window.
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
            onLoad={() => setState('loaded')}
          />
        ) : (
          <div className="link-sheet__status" data-testid="link-sheet-status">
            {state === 'checking' ? (
              <>Opening {host}…</>
            ) : (
              <>
                <span>{host} can’t be shown here.</span>
                <a
                  href={url}
                  target="_blank"
                  rel="noreferrer noopener"
                  data-native-link=""
                  onClick={() => onClose()}
                >
                  Open it in your browser
                </a>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** The platform's own browser. False when it was blocked. */
function openNative(url: string): boolean {
  const w = window.open(url, '_blank');
  if (!w) return false;
  try {
    w.opener = null;
  } catch {
    /* cross-origin already */
  }
  return true;
}
