import { useEffect, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { api } from '../api';
import { refreshWorkspaces, useWorkspaces } from '../workspaces';
import { useDocumentTitle } from '../use-document-title';
import './dashboard.css';

/**
 * The '/' page. Two modes:
 *  - If there are no workspaces yet → show the welcome / explanation card
 *    with a single 'Create your first workspace' button.
 *  - If there's at least one workspace → redirect to the first one. The user
 *    then navigates between workspaces via the tab bar; '/' is rarely visited
 *    after first run.
 */
export function Dashboard() {
  useDocumentTitle('muxpad');
  const { workspaces } = useWorkspaces();
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();

  // Initial fetch so we know whether to redirect or show welcome.
  useEffect(() => {
    void refreshWorkspaces().finally(() => setLoading(false));
  }, []);

  // If we have any workspaces, route the user to the first one.
  useEffect(() => {
    if (loading) return;
    if (workspaces.length > 0) {
      const target = workspaces[0]!;
      void navigate({ to: '/w/$slug', params: { slug: target.slug } });
    }
  }, [loading, workspaces, navigate]);

  const create = async () => {
    setCreating(true);
    try {
      const w = await api.createWorkspace();
      const pane = await api.createPane(w.id, {});
      await api.patchWorkspace(w.id, { layout: pane.id });
      await refreshWorkspaces();
      void navigate({ to: '/w/$slug', params: { slug: w.slug } });
    } finally {
      setCreating(false);
    }
  };

  // While we don't yet know whether to redirect, render nothing to avoid a
  // flash of welcome content for returning users.
  if (loading || workspaces.length > 0) {
    return <div className="dashboard-loader" aria-hidden />;
  }

  return (
    <div className="dashboard-root">
      <main className="welcome">
        <div className="welcome-card">
          <h1 className="welcome-title">Welcome to muxpad.</h1>
          <p className="welcome-lede">
            A self-hosted PTY host that lives on a machine you keep running. Each
            browser tab is a workspace with split panes; sessions outlive the tab,
            mirror across every device you open them on, and pick up where you
            left off when you reattach.
          </p>

          <ul className="welcome-points">
            <li>
              <strong>Tabs are your multiplexer.</strong> Each browser tab is a
              workspace. Inside, panes split horizontally and vertically — drag
              the dividers, pop a pane out, pull it back in.
            </li>
            <li>
              <strong>Sessions outlive tabs.</strong> Close the tab, switch
              devices, come back tomorrow — your shells, Claude Code session,
              dev servers and log tails are all still running.
            </li>
            <li>
              <strong>Mirror across machines.</strong> Open the same workspace
              from your laptop, your home box, your phone. Everyone sees the
              same output. Image paste works on every device.
            </li>
          </ul>

          <button
            className="btn btn-primary welcome-cta"
            onClick={() => void create()}
            disabled={creating}
          >
            {creating ? 'Creating…' : 'Create your first workspace'}
          </button>
        </div>
      </main>
    </div>
  );
}
