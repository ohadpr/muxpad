import { createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { AppLayout } from './components/AppLayout';
import { WorkspaceLayout } from './components/WorkspaceLayout';
import { CeoRedirect } from './pages/CeoRedirect';
import { DocView } from './pages/DocView';
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

// Legacy /ceo link — the CEO is a real tab in the hidden system workspace
// and renders through the standard chrome; this just resolves + redirects
// to its /w/:ws/t/:tab route (see pages/CeoRedirect.tsx).
const ceoRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/ceo',
  component: CeoRedirect,
});

// Document surface — a note where AI conversations are collapsible blocks.
// Outside the app layout (its own full-screen chrome); theme vars still apply
// since they live on :root in styles.css.
const docRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/doc',
  component: DocView,
});

const routeTree = rootRoute.addChildren([
  appLayoutRoute.addChildren([rootRedirectRoute, workspaceLayoutRoute.addChildren([tabRoute])]),
  popoutPaneRoute,
  ceoRoute,
  docRoute,
]);

export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
