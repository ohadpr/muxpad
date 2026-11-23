import { createRootRoute, createRoute, createRouter, redirect } from '@tanstack/react-router';
import { AppLayout } from './components/AppLayout';
import { WorkspaceLayout } from './components/WorkspaceLayout';
import { noticeCaptureNonce } from './lib/slack-notice-diagnostic';
import { ChatListFallback } from './pages/ChatListFallback';
import { DocView } from './pages/DocView';
import { AppsView, ArtifactsView, HostedAppView } from './pages/HostedView';
import { PopoutView } from './pages/PopoutView';
import { RootRedirect } from './pages/RootRedirect';

const rootRoute = createRootRoute();

// Pathless layout: persistent chrome (brand + actions + the tab bar
// when inside a workspace).
const appLayoutRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: '_app',
  component: AppLayout,
});

// Root: just redirects. On a phone to the chat list (/chats); on desktop to
// the first workspace, or auto-creates one. See lib/mobile-nav.
const rootRedirectRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: '/',
  component: RootRedirect,
});

// /chats — the phone's root: every workspace and its chats, full screen.
// AppLayout renders the list ITSELF, beside the kept-alive workspace hosts and
// never through this route's Outlet, so the list survives a trip into a chat.
// The component only ever renders where the list is not a destination (desktop,
// an embed), and sends you to `/`.
const chatListRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: '/chats',
  component: ChatListFallback,
});

// /w/$wsSlug — workspace layout. Loads workspace, redirects to first tab
// when the URL has no tab segment, auto-closes empty workspaces.
const workspaceLayoutRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: '/w/$wsSlug',
  component: WorkspaceLayout,
});

// /w/$wsSlug/t/$tabSlug — URL segment only. TabView instances are
// mounted by WorkspaceLayout (one per tab, hidden when inactive) so
// xterm / Ink scroll state survives tab switches.
const tabRoute = createRoute({
  getParentRoute: () => workspaceLayoutRoute,
  path: 't/$tabSlug',
  // `?pane=<id>` reflects the ACTIVE pane in single-pane modes (mobile + the
  // desktop 'tabbed' view, where panes read as tabs) so a refresh / shared
  // link / back button lands on the same pane. The split mosaic shows every
  // pane at once, so it ignores this. TabView owns reading + syncing it.
  validateSearch: (
    search: Record<string, unknown>,
  ): {
    pane?: string | undefined;
    slackNoticeCapture?: string | undefined;
    embed?: '1' | undefined;
  } => ({
    pane: typeof search.pane === 'string' && search.pane ? search.pane : undefined,
    slackNoticeCapture: noticeCaptureNonce(search.slackNoticeCapture),
    // ── `embed` HAS TO SURVIVE THIS FUNCTION ──────────────────────────────
    // Unlisted params are DROPPED, and TabView rewrites the search on mount
    // to reflect the active pane. So `?embed=1` lived exactly until the first
    // render, and any reload of the iframe — a pull-to-refresh, a crash, the
    // PWA restoring — came back as the FULL COCKPIT inside somebody's app:
    // sidebar, tab bar and all. lib/embed latches the flag at boot, which is
    // why the first paint was always right and the bug only showed on the
    // second load.
    embed: search.embed === '1' ? '1' : undefined,
  }),
  component: () => null,
});

// Pane popout — outside the app layout, renders chromeless.
const popoutPaneRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/p/$paneId',
  component: PopoutView,
});

// Document surface — a note where AI conversations are collapsible blocks.
// Outside the app layout (its own full-screen chrome); theme vars still apply
// since they live on :root in styles.css.
const docRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/doc',
  component: DocView,
});

// /artifacts and /apps — the two hosted surfaces, one entry each.
//
// CHILDREN OF THE APP LAYOUT, not of a workspace. That placement is the
// feature: AppLayout renders its <Outlet/> whenever the URL carries no
// workspace, so these inherit the brand/settings chrome while occupying no
// tab and belonging to no workspace. An app you are looking at is a route you
// can leave — closing it never touches the process, which is owned by ptyd.
//
// They were ONE route called /hosted. The reasoning for splitting them is in
// HostedView; the reasoning for keeping /hosted alive as a redirect is that
// the URL is in transcripts, in published reports and in muscle memory, and a
// 404 on it would teach nothing. It lands on Artifacts because that is the
// half people arrive looking for ("link to the thing I made").
const artifactsRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: '/artifacts',
  component: ArtifactsView,
});

const appsRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: '/apps',
  component: AppsView,
});

const hostedRedirectRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: '/hosted',
  beforeLoad: () => {
    throw redirect({ to: '/artifacts', replace: true });
  },
});

// /hosted/a/$slug — one app's web view, full screen. `?logs=true` opens
// straight onto the app's pane terminal (an app IS a pane underneath), so
// "why is this unreachable" is one tap from the list.
const hostedAppRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: '/hosted/a/$slug',
  validateSearch: (search: Record<string, unknown>): { logs?: boolean | undefined } => ({
    logs: search.logs === true || search.logs === 'true' ? true : undefined,
  }),
  component: HostedAppView,
});

const routeTree = rootRoute.addChildren([
  appLayoutRoute.addChildren([
    rootRedirectRoute,
    chatListRoute,
    artifactsRoute,
    appsRoute,
    hostedRedirectRoute,
    hostedAppRoute,
    workspaceLayoutRoute.addChildren([tabRoute]),
  ]),
  popoutPaneRoute,
  docRoute,
]);

export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
