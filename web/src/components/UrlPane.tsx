import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { normalizeUrl } from '../lib/normalize-url';
import './UrlPane.css';

interface UrlPaneProps {
  paneId: string;
  /**
   * The pane's URL, or null when this pane was just opened as a web view
   * and the user hasn't entered a URL yet.
   */
  url: string | null;
}

/**
 * Broadcast a load-state change for the URL pane with the given id.
 * The chrome (UrlPaneTitle in TabView) listens for these to render a
 * spinner. We use window events instead of prop-drilling state up because
 * the chrome and the iframe live in independent component subtrees.
 */
function emitLoading(paneId: string, loading: boolean): void {
  window.dispatchEvent(
    new CustomEvent('muxpad:url-pane-loading', { detail: { paneId, loading } }),
  );
}

/**
 * URL pane with its own address bar — required in tabbed/mobile where there
 * is no mosaic UrlPaneTitle. Split view still has a toolbar kind-switch;
 * the address bar here is the one place to set/change the URL in every mode.
 */
export function UrlPane({ paneId, url }: UrlPaneProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState(url == null);
  const [draft, setDraft] = useState(url ?? '');
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setDraft(url ?? '');
    if (url == null) setEditing(true);
    else setEditing(false);
  }, [url]);

  useEffect(() => {
    if (!editing) return;
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, [editing, url]);

  // Mark loading=true on every src change. `iframe.onLoad` flips it to
  // false. The load event fires even when X-Frame-Options blocks the
  // inner content, so failed loads still converge to "done". Skip when
  // url is null — there's nothing loading and we render no iframe.
  useEffect(() => {
    if (url == null) {
      emitLoading(paneId, false);
      return;
    }
    emitLoading(paneId, true);
  }, [paneId, url]);

  useEffect(() => {
    if (url == null) return;
    const onReload = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.paneId !== paneId || !iframeRef.current) return;
      // Re-assigning src is the cross-origin-safe reload (we can't call
      // contentWindow.location.reload() across origins).
      emitLoading(paneId, true);
      iframeRef.current.src = url;
    };
    window.addEventListener('muxpad:reload-url-pane', onReload);
    return () => window.removeEventListener('muxpad:reload-url-pane', onReload);
  }, [paneId, url]);

  const commit = async () => {
    const next = normalizeUrl(draft);
    if (!next) {
      setErr('Enter a URL');
      if (url == null) return;
      setDraft(url);
      setEditing(false);
      return;
    }
    if (next === url) {
      setEditing(false);
      setErr(null);
      return;
    }
    setErr(null);
    try {
      await api.patchPane(paneId, { url: next });
      setEditing(false);
      emitLoading(paneId, true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'could not set URL');
      setDraft(url ?? '');
    }
  };

  const cancel = () => {
    setDraft(url ?? '');
    setErr(null);
    if (url != null) setEditing(false);
  };

  return (
    <div className={`url-pane${url == null ? ' url-pane-blank' : ''}`}>
      <form
        className="url-pane-bar"
        onSubmit={(e) => {
          e.preventDefault();
          void commit();
        }}
      >
        {editing ? (
          <input
            ref={inputRef}
            className="url-pane-input"
            value={draft}
            spellCheck={false}
            autoComplete="off"
            inputMode="url"
            placeholder="https://…"
            aria-label="Page URL"
            onChange={(e) => {
              setDraft(e.target.value);
              if (err) setErr(null);
            }}
            onBlur={() => {
              // Keep focus while still blank so the field doesn't vanish
              // into an empty chrome state with nothing to click.
              if (url == null) return;
              // Revert on blur (standard address-bar behavior): clicking away
              // with a half-typed/garbage draft must NOT commit and navigate the
              // iframe. Commit happens only on Enter (form submit).
              cancel();
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                cancel();
              }
            }}
          />
        ) : (
          <button
            type="button"
            className="url-pane-display"
            title="Edit URL"
            onClick={() => setEditing(true)}
          >
            {url}
          </button>
        )}
        {url != null ? (
          <button
            type="button"
            className="url-pane-reload"
            title="Reload"
            aria-label="Reload"
            onClick={() =>
              window.dispatchEvent(
                new CustomEvent('muxpad:reload-url-pane', { detail: { paneId } }),
              )
            }
          >
            ↻
          </button>
        ) : null}
      </form>
      {err ? <p className="url-pane-error">{err}</p> : null}
      {url == null ? (
        <div className="url-pane-empty">
          <p className="url-pane-empty-title">Open a web view</p>
          <p className="url-pane-empty-hint">Type a URL above and press Enter</p>
        </div>
      ) : (
        <iframe
          ref={iframeRef}
          src={url}
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
          referrerPolicy="no-referrer"
          title={url}
          onLoad={() => emitLoading(paneId, false)}
        />
      )}
    </div>
  );
}
