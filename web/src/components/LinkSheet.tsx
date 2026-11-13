import { useEffect, useRef, useState } from 'react';
import { LINKS_PROFILE, followTrail, linkHost, linkSheetViewerPath } from '../lib/link-sheet';
import './LinkSheet.css';

/**
 * A tapped link, opened in a sheet over the conversation — the way the native
 * X/Twitter app does it — instead of being handed to the OS.
 *
 * ONE SLIM BAR: ✕, Back (only once there is somewhere to go back to), the site
 * you are on, and the way out to a real browser. The viewer's own toolbar is
 * hidden in here — Phone and Paste are for driving an agent's browser, and a
 * second address row repeats the site this bar already names.
 *
 * BOTTOM-ANCHORED, ~72% of the height. On a phone the bottom is where the thumb
 * is: the X, the grabber and "open in browser" sit in the sheet's top bar, a
 * thumb's reach from the bottom edge, and the conversation stays visible above
 * it — the message you tapped is usually right there. Tapping that visible
 * strip closes the sheet, and so does dragging the bar down, so there are three
 * ways back and none of them needs finding.
 *
 * THE PAGE IS A PICTURE of muxpad's own browser (the same live viewer as a
 * browser card), not an <iframe src={link}>: most sites refuse to be framed,
 * and pixels from a real browser do not care.
 *
 * IT IS THE `links` BROWSER, NEVER THE CHAT'S OWN. The chat's browser is the
 * agent's; navigating it would yank the page out from under a task in
 * progress. The server refuses that outright — see POST /:profile/open.
 */

export interface LinkSheetProps {
  url: string;
  /** This pane, as the wheel's claimant. */
  by: string;
  onClose: () => void;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
  /** How often the lease is renewed while the sheet is open. */
  renewMs?: number;
}

/** How far the bar has to be dragged down to close the sheet. */
const DISMISS_DRAG_PX = 80;

export function LinkSheet({ url, by, onClose, fetchImpl, renewMs = 60_000 }: LinkSheetProps) {
  const doFetch = fetchImpl ?? fetch;
  const [state, setState] = useState<'opening' | 'ready' | { error: string }>('opening');
  const [drag, setDrag] = useState(0);
  const dragFrom = useRef<number | null>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  // The pages visited since this link was opened; see followTrail.
  const [trail, setTrail] = useState<readonly string[]>([]);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  // Open (or re-point) the links browser at this url.
  useEffect(() => {
    let live = true;
    setState('opening');
    setTrail([]);
    (async () => {
      try {
        const res = await doFetch(`/api/browsers/${LINKS_PROFILE}/open`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ url, by }),
        });
        if (!live) return;
        if (res.ok) setState('ready');
        else {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          setState({ error: body.error ?? `could not open (${res.status})` });
        }
      } catch {
        if (live) setState({ error: 'could not reach muxpad' });
      }
    })();
    return () => {
      live = false;
    };
  }, [url, by, doFetch]);

  // Keep the lease while the sheet is open; hand it back when it closes.
  useEffect(() => {
    const json = (method: string) => ({
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ by }),
    });
    const id = setInterval(() => {
      void doFetch(`/api/browsers/${LINKS_PROFILE}/wheel/renew`, json('POST')).catch(() => {});
    }, renewMs);
    return () => {
      clearInterval(id);
      void doFetch(`/api/browsers/${LINKS_PROFILE}/wheel`, json('DELETE')).catch(() => {});
    };
  }, [by, doFetch, renewMs]);

  // Escape, on the document: focus lives in the cross-origin-looking frame.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeRef.current();
    };
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return;
      if ((e.data as { muxpad?: string } | null)?.muxpad === 'handback') closeRef.current();
      const data = e.data as { muxpad?: string; url?: unknown } | null;
      if (
        data?.muxpad === 'url' &&
        typeof data.url === 'string' &&
        e.source === frameRef.current?.contentWindow
      ) {
        const next = data.url;
        setTrail((t) => followTrail(t, next));
      }
    };
    document.addEventListener('keydown', onKey);
    window.addEventListener('message', onMessage);
    return () => {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('message', onMessage);
    };
  }, []);

  // The site you are ON — which a page that links elsewhere can change.
  const current = trail[trail.length - 1] ?? url;
  const host = linkHost(current);
  const canGoBack = trail.length > 1;
  const label = `link · ${host}`;
  const dragStyle =
    drag > 0 ? { transform: `translateY(${drag}px)`, transition: 'none' } : undefined;

  return (
    <div className="link-sheet" data-testid="link-sheet">
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: Escape is handled on the document above. */}
      <div className="link-sheet__scrim" data-testid="link-sheet-scrim" onClick={onClose} />
      {/* biome-ignore lint/a11y/useSemanticElements: same reasons as BrowserModal — a framed viewer owns focus, Escape is bound on the document. */}
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
          {canGoBack ? (
            <button
              type="button"
              className="link-sheet__back"
              aria-label="Back"
              title="Back"
              onClick={() =>
                frameRef.current?.contentWindow?.postMessage(
                  { muxpad: 'back' },
                  window.location.origin,
                )
              }
            >
              ‹
            </button>
          ) : null}
          <span className="link-sheet__host" title={current}>
            {host}
          </span>
          {/* The way out to a REAL browser: logging in somewhere, or a page you
              mean to keep. Opted out of the chat's link interception. */}
          <a
            className="link-sheet__out"
            href={current}
            target="_blank"
            rel="noreferrer noopener"
            data-native-link=""
            onClick={() => onClose()}
          >
            Open in browser ↗
          </a>
        </div>
        {state === 'ready' ? (
          <iframe
            className="link-sheet__frame"
            ref={frameRef}
            title={`page · ${host}`}
            src={linkSheetViewerPath(by)}
            allow="clipboard-read; clipboard-write"
          />
        ) : (
          <div className="link-sheet__status" data-testid="link-sheet-status">
            {state === 'opening' ? (
              <>Opening {host}…</>
            ) : (
              <>
                <span>{state.error}</span>
                <a href={url} target="_blank" rel="noreferrer noopener" data-native-link="">
                  Open it in your browser instead
                </a>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
