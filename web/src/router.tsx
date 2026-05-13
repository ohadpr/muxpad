import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from '@tanstack/react-router';
import { RootRedirect } from './pages/RootRedirect';
import { TabView } from './pages/TabView';
import { PopoutView } from './pages/PopoutView';
import { AppLayout } from './components/AppLayout';
import { WorkspaceLayout } from './components/WorkspaceLayout';

const rootRoute = createRootRoute({
  component: () => <Outlet />,
});

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

// /w/$wsSlug/t/$tabSlug — the actual tab view (panes etc.).
const tabRoute = createRoute({
  getParentRoute: () => workspaceLayoutRoute,
  path: 't/$tabSlug',
  component: TabView,
});

// Pane popout — outside the app layout, renders chromeless.
const popoutPaneRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/p/$paneId',
  component: PopoutView,
});

const routeTree = rootRoute.addChildren([
  appLayoutRoute.addChildren([
    rootRedirectRoute,
    workspaceLayoutRoute.addChildren([tabRoute]),
  ]),
  popoutPaneRoute,
]);

export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
