import { useEffect, useRef } from 'react';
import './UrlPane.css';

interface UrlPaneProps {
  paneId: string;
  /**
   * The pane's URL, or null when this pane was just type-switched from
   * shell and the user hasn't entered a URL yet. In the null case we
   * render a blank body — the chrome's URL field auto-enters edit mode
   * so the user can type.
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
 * Pure iframe pane. All chrome (title-as-address-bar, reload button,
 * edit-on-double-click) lives in TabView's renderToolbar — this component
 * has no UI of its own beyond the iframe itself. Listens for a
 * `muxpad:reload-url-pane` window event so the chrome reload button can
 * force a reload without prop drilling a ref. Emits a
 * `muxpad:url-pane-loading` window event whenever load state changes so
 * the chrome can show a spinner.
 */
export function UrlPane({ paneId, url }: UrlPaneProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);

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

  if (url == null) {
    // Blank body — chrome's UrlPaneTitle is in edit mode waiting for input.
    return <div className="url-pane url-pane-blank" />;
  }

  return (
    <div className="url-pane">
      <iframe
        ref={iframeRef}
        src={url}
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
        referrerPolicy="no-referrer"
        title={url}
        onLoad={() => emitLoading(paneId, false)}
      />
    </div>
  );
}
