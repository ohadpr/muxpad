import { useEffect, useState } from 'react';
import {
  type PendingOpen,
  dismissOpen,
  getOpens,
  subscribeOpens,
} from '../lib/external-open-store';
import './ExternalOpenToasts.css';

interface Props {
  /**
   * Muxpad tab currently displayed in this browser tab, or null if
   * outside a tab. Used to filter requests scoped to a specific tab —
   * if a request carries a tab_id, only the browser tab(s) currently
   * viewing that muxpad tab show the toast. Unscoped requests (no
   * tab_id) show everywhere.
   */
  currentTabId: string | null;
  /**
   * Resolves a pane id to its display label using the same logic as the
   * pane chrome — keeps the toast and the tile header in agreement.
   * Returns null when the id doesn't resolve to a pane in the current
   * tab (e.g. the pane was deleted between CLI invocation and event
   * arrival).
   */
  paneLabel: (paneId: string) => string | null;
}

/**
 * Renders a stack of click-to-open toasts for pending `external_url.open`
 * requests. The click handler calls window.open() so the call lands
 * inside a user-gesture and bypasses popup blockers.
 *
 * Mount location matters: this component is mounted inside `TabView`,
 * so it renders only while the user is on a tab page (`/w/.../t/...`).
 * On the workspace home or empty-state routes, no toasts fire — that's
 * intentional, since the feature is meant for "I'm working in a pane
 * and want to escape it to a real browser tab." If you ever want
 * unscoped toasts to surface on non-tab routes, lift the mount to
 * `AppLayout` and pass `currentTabId={null}`.
 *
 * Labels are LIVE, not snapshotted: if the originating pane's title or
 * foreground command changes between the request firing and the user
 * clicking, the toast reflects the new value. Same source of truth as
 * the pane chrome header. If the pane is deleted in the interim, the
 * `tab.panes.some(...)` guard at the call site makes `paneLabel`
 * return `null` and the toast falls back to "A pane requested...".
 */
export function ExternalOpenToasts({ currentTabId, paneLabel }: Props) {
  const [opens, setOpens] = useState<PendingOpen[]>(() => getOpens());

  useEffect(() => subscribeOpens(setOpens), []);

  const visible = opens.filter((o) => o.tab_id === null || o.tab_id === currentTabId);

  if (visible.length === 0) return null;

  return (
    <div className="external-open-toasts" role="region" aria-label="External URL requests">
      {visible.map((o) => (
        <ExternalOpenToast key={o.id} open={o} paneLabel={paneLabel} />
      ))}
    </div>
  );
}

function ExternalOpenToast({
  open,
  paneLabel,
}: {
  open: PendingOpen;
  paneLabel: (paneId: string) => string | null;
}) {
  let host = open.url;
  try {
    host = new URL(open.url).host || open.url;
  } catch {
    // keep the raw string for things that don't parse as URLs.
  }

  const handleOpen = () => {
    // Must run synchronously inside the click handler so popup blockers
    // treat this as a user gesture.
    window.open(open.url, '_blank', 'noopener,noreferrer');
    dismissOpen(open.id);
  };

  const handleDismiss = (e: React.MouseEvent) => {
    e.stopPropagation();
    dismissOpen(open.id);
  };

  const label = open.pane_id ? paneLabel(open.pane_id) : null;

  return (
    <div className="external-open-toast" role="group">
      <div className="external-open-toast-body">
        <div className="external-open-toast-origin">{label ?? 'A pane'} requested to open:</div>
        <div className="external-open-toast-url" title={open.url}>
          {host}
        </div>
      </div>
      <button
        type="button"
        className="external-open-toast-action"
        onClick={handleOpen}
        title={`Open ${open.url} in a new browser tab`}
      >
        Open
      </button>
      <button
        type="button"
        className="external-open-toast-dismiss"
        aria-label="Dismiss"
        onClick={handleDismiss}
        title="Dismiss"
      >
        ×
      </button>
    </div>
  );
}
