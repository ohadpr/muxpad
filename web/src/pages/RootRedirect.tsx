import { useEffect, useRef } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { api } from '../api';
import { refreshWorkspaces } from '../workspaces';
import { useDocumentTitle } from '../use-document-title';

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

    let cancelled = false;
    const run = async () => {
      const workspaces = await refreshWorkspaces();
      if (cancelled) return;
      if (workspaces.length > 0) {
        const first = workspaces[0]!;
        void navigate({
          to: '/w/$wsSlug',
          params: { wsSlug: first.slug },
          replace: true,
        });
        return;
      }
      // No workspaces — bootstrap one so the user is never stuck on a
      // blank page. Mirrors the create-from-dropdown flow: workspace +
      // tab + pane, then navigate straight to the tab.
      try {
        const w = await api.createWorkspace();
        const t = await api.createTab(w.id);
        const pane = await api.createPane(t.id, {});
        await api.patchTab(t.id, { layout: pane.id });
        await refreshWorkspaces();
        if (cancelled) return;
        void navigate({
          to: '/w/$wsSlug/t/$tabSlug',
          params: { wsSlug: w.slug, tabSlug: t.slug },
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
