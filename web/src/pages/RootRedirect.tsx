import { useNavigate } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';
import { api } from '../api';
import { HOUSE_CHAT_CREATE } from '../lib/agent-backend';
import { isEmbedded } from '../lib/embed';
import { isMobileLayout } from '../lib/mobile-layout';
import { CHAT_LIST_PATH, rootLanding } from '../lib/mobile-nav';
import { useDocumentTitle } from '../use-document-title';
import { refreshWorkspaces, visibleWorkspaces } from '../workspaces';

// Module-level so two RootRedirect mounts (StrictMode double-invoke,
// route remounts, etc.) don't both fire workspace-bootstrap and create
// duplicate Workspace 1/Workspace 2 rows.
let bootstrapInFlight: Promise<void> | null = null;

/**
 * The root route `/` doesn't render its own page — it just figures out
 * where the user belongs and redirects there.
 *
 *   - On a PHONE, the chat list (`/chats`) — the root of the mobile layout.
 *     Diving into a chat would put the list one gesture behind you on a cold
 *     open, which is backwards: the list is where you start. With zero
 *     workspaces the bootstrap below still runs first, then lands there.
 *
 * On desktop:
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
      // Read at fire time, not captured at mount: it is the layout the user is
      // looking at when the answer arrives that decides where they land.
      const toList = rootLanding({ isMobile: isMobileLayout(), embedded: isEmbedded() });
      if (toList === 'chat-list' && workspaces.length > 0) {
        void navigate({ to: CHAT_LIST_PATH, search, replace: true });
        return;
      }
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
      //
      // First run lands in the HOUSE CHAT, same as every other `+`. It used to
      // land in a bare shell, which made "what muxpad is" depend on which door
      // you came through. If the harness can't start, the empty chat's own
      // strip offers Terminal — so the escape hatch is on screen, labelled,
      // rather than being the silent default.
      try {
        const w = await api.createWorkspace();
        const t = await api.createTab(w.id, { ...HOUSE_CHAT_CREATE });
        await refreshWorkspaces();
        if (cancelled) return;
        if (rootLanding({ isMobile: isMobileLayout(), embedded: isEmbedded() }) === 'chat-list') {
          void navigate({ to: CHAT_LIST_PATH, search, replace: true });
          return;
        }
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
