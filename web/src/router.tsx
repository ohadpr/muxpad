import { createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { AppLayout } from './components/AppLayout';
import { WorkspaceLayout } from './components/WorkspaceLayout';
import { DocView } from './pages/DocView';
import { HostedAppView, HostedView } from './pages/HostedView';
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

// Root: just redirects (to first workspace, or auto-creates one).
const rootRedirectRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: '/',
  component: RootRedirect,
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
  validateSearch: (search: Record<string, unknown>): { pane?: string | undefined } => ({
    pane: typeof search.pane === 'string' && search.pane ? search.pane : undefined,
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

// /hosted — the Hosted surface (apps + published artifacts).
//
// A CHILD OF THE APP LAYOUT, not of a workspace. That placement is the
// feature: AppLayout renders its <Outlet/> whenever the URL carries no
// workspace, so Hosted inherits the brand/settings chrome while occupying no
// tab and belonging to no workspace. An app you are looking at is a route you
// can leave — closing it never touches the process, which is owned by ptyd.
const hostedRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: '/hosted',
  component: HostedView,
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
    hostedRoute,
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
