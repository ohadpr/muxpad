import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from '@tanstack/react-router';
import { Dashboard } from './pages/Dashboard';
import { WorkspaceView } from './pages/WorkspaceView';
import { PopoutView } from './pages/PopoutView';
import { AppLayout } from './components/AppLayout';

const rootRoute = createRootRoute({
  component: () => <Outlet />,
});

// Pathless layout — children inherit it. The persistent workspace tab strip
// lives here so it doesn't remount on navigation between workspaces.
const appLayoutRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: '_app',
  component: AppLayout,
});

const dashboardRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: '/',
  component: Dashboard,
});

const workspaceRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: '/w/$slug',
  component: WorkspaceView,
});

// Popout pages are intentionally chromeless — outside the app layout.
const popoutRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/p/$paneId',
  component: PopoutView,
});

const routeTree = rootRoute.addChildren([
  appLayoutRoute.addChildren([dashboardRoute, workspaceRoute]),
  popoutRoute,
]);

export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
