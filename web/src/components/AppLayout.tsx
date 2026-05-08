import { Outlet } from '@tanstack/react-router';
import { WorkspaceTabBar } from './WorkspaceTabBar';

/**
 * Persistent application chrome. Used for everything except popout panes
 * (which intentionally render fullscreen with no chrome).
 */
export function AppLayout() {
  return (
    <div className="app-layout">
      <WorkspaceTabBar />
      <Outlet />
    </div>
  );
}
