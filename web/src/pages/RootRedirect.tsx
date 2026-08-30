import { useNavigate } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';
import { api } from '../api';
import { useDocumentTitle } from '../use-document-title';
import { refreshWorkspaces, visibleWorkspaces } from '../workspaces';

// Module-level so two RootRedirect mounts (StrictMode double-invoke,
// route remounts, etc.) don't both fire workspace-bootstrap and create
// duplicate Workspace 1/Workspace 2 rows.
let bootstrapInFlight: Promise<void> | null = null;

/**
 * The root route `/` doesn't render its own page — it just figures out
 * where the user belongs and redirects there. The user is always either
 * inside a workspace or transiently passing through this redirect.
 *
 *   - If there's at least one workspace, go to the first one (its
 *     WorkspaceLayout will then redirect to that workspace's first tab).
 *   - If there are zero workspaces, auto-create one (with a starter
 *     tab + pane) and land in it.
 *
 * This makes the workspace switcher dropdown the single overview of
 * workspaces; there's no separate picker page to maintain.
 */
export function RootRedirect() {
  useDocumentTitle('muxpad');
  const navigate = useNavigate();
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    // Preserve the current URL's search params (e.g. ?debug=1) across
    // the redirect chain — without this, devtools tooling that relies on
    // query flags would silently lose state on every visit to /.
    const search = Object.fromEntries(new URLSearchParams(window.location.search).entries());

    let cancelled = false;
    const run = async () => {
      // Visible only: a hidden system workspace must never be
      // the default landing spot — with only it present, bootstrap a real one.
      const workspaces = visibleWorkspaces(await refreshWorkspaces());
      if (cancelled) return;
      if (workspaces.length > 0) {
        const first = workspaces[0]!;
        void navigate({
          to: '/w/$wsSlug',
          params: { wsSlug: first.slug },
          search,
          replace: true,
        });
        return;
      }
      // No workspaces — bootstrap one so the user is never stuck on a
      // blank page. Mirrors the create-from-dropdown flow: workspace +
      // tab-with-pane (created atomically server-side), then navigate.
      try {
        const w = await api.createWorkspace();
        const t = await api.createTab(w.id, { bootstrap: 'shell' });
        await refreshWorkspaces();
        if (cancelled) return;
        void navigate({
          to: '/w/$wsSlug/t/$tabSlug',
          params: { wsSlug: w.slug, tabSlug: t.slug },
          search,
          replace: true,
        });
      } catch (err) {
        console.error('failed to bootstrap initial workspace', err);
      }
    };

    // Module-level promise gate so two concurrent mounts share one run,
    // even if React unmounts and remounts the component mid-flight.
    if (!bootstrapInFlight) {
      bootstrapInFlight = run().finally(() => {
        bootstrapInFlight = null;
      });
    }

    return () => {
      cancelled = true;
    };
  }, [navigate]);

  return <div className="workspace-loading">loading…</div>;
}
