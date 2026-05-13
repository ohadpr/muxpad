import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from '@tanstack/react-router';
import { WorkspacePicker } from './pages/WorkspacePicker';
import { TabView } from './pages/TabView';
import { TabPopout } from './pages/TabPopout';
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

// Root → workspace picker.
const pickerRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: '/',
  component: WorkspacePicker,
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

// Popout routes — outside the app layout, so they render chromeless.
const popoutPaneRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/p/$paneId',
  component: PopoutView,
});

const popoutTabRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/popout/t/$tabSlug',
  component: TabPopout,
});

const routeTree = rootRoute.addChildren([
  appLayoutRoute.addChildren([
    pickerRoute,
    workspaceLayoutRoute.addChildren([tabRoute]),
  ]),
  popoutPaneRoute,
  popoutTabRoute,
]);

export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
