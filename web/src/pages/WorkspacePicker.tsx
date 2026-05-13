import { useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { api } from '../api';
import { refreshWorkspaces, useWorkspaces } from '../workspaces';
import { useDocumentTitle } from '../use-document-title';
import './WorkspacePicker.css';

/**
 * Root page at `/`. Lists the user's workspaces, click one to enter.
 * Empty state offers a single "Create your first workspace" CTA.
 */
export function WorkspacePicker() {
  useDocumentTitle('muxpad');
  const { workspaces } = useWorkspaces();
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();

  const create = async () => {
    if (creating) return;
    setCreating(true);
    try {
      const w = await api.createWorkspace();
      await refreshWorkspaces();
      void navigate({ to: '/w/$wsSlug', params: { wsSlug: w.slug } });
    } finally {
      setCreating(false);
    }
  };

  if (workspaces.length === 0) {
    return (
      <div className="picker-root">
        <main className="picker-empty">
          <h1>Welcome to muxpad.</h1>
          <p>Create your first workspace to get started.</p>
          <button
            className="btn btn-primary"
            onClick={() => void create()}
            disabled={creating}
          >
            {creating ? 'Creating…' : '+ New workspace'}
          </button>
        </main>
      </div>
    );
  }

  return (
    <div className="picker-root">
      <main className="picker">
        <header className="picker-header">
          <h1>Workspaces</h1>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void create()}
            disabled={creating}
          >
            {creating ? 'Creating…' : '+ New workspace'}
          </button>
        </header>
        <ul className="picker-list">
          {workspaces.map((w) => (
            <li key={w.id} className="picker-item">
              <Link
                to="/w/$wsSlug"
                params={{ wsSlug: w.slug }}
                className="picker-card"
              >
                <span className="picker-card-name">{w.name}</span>
                <span className="picker-card-meta">
                  {w.tab_count} {w.tab_count === 1 ? 'tab' : 'tabs'}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </main>
    </div>
  );
}
