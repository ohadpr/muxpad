import type { Workspace } from '@muxpad/shared';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { unreadByWorkspace, workspaceMark } from '../lib/chat-sections';
import { useChatCorpus } from '../lib/use-all-chats';
import { useWorkspaces, visibleWorkspaces } from '../workspaces';
import { createWorkspaceAndGo } from './NavTree';
import './WorkspaceRail.css';

/**
 * THE LEFT STRIP — workspaces, and nothing else.
 *
 * The desktop rail used to answer "which workspace" and "which chat" in one
 * long scroll of collapsible sections. This strip takes the first question:
 * one icon per workspace, the current one marked, a click switches. The chat
 * rail beside it lists the current workspace's chats only.
 *
 * Switching is a navigation to `/w/:slug` — the workspace's own redirect lands
 * on its last-visited chat — and AppLayout keeps every visited workspace's
 * hosts MOUNTED AND HIDDEN across it, so no terminal re-attaches.
 *
 * ─── What the split costs, and the badge that pays it back ────────────────
 * You used to see every workspace's chats in one scroll; now you see one
 * workspace's. So an icon whose workspace holds unread chats carries their
 * count (lib/chat-sections `unreadByWorkspace`), Slack's own answer — without
 * it the restructure would hide exactly the chats that want reading.
 */
export function WorkspaceRail({ currentSlug }: { currentSlug: string | null }) {
  const navigate = useNavigate();
  const { workspaces: all } = useWorkspaces();
  const workspaces = visibleWorkspaces(all);
  const unread = unreadByWorkspace(useChatCorpus());
  const [creating, setCreating] = useState(false);

  const create = async () => {
    if (creating) return;
    setCreating(true);
    try {
      await createWorkspaceAndGo(navigate);
    } catch (err) {
      console.error('createWorkspace failed', err);
    } finally {
      setCreating(false);
    }
  };

  return (
    <nav className="ws-rail" aria-label="Workspaces">
      {workspaces.map((w) => (
        <WorkspaceIcon
          key={w.id}
          workspace={w}
          current={w.slug === currentSlug}
          unread={unread.get(w.id) ?? 0}
        />
      ))}
      <button
        type="button"
        className="ws-rail-icon ws-rail-add"
        onClick={() => void create()}
        disabled={creating}
        aria-label="New workspace"
        title="New workspace"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </button>
    </nav>
  );
}

function WorkspaceIcon({
  workspace,
  current,
  unread,
}: {
  workspace: Workspace;
  current: boolean;
  unread: number;
}) {
  const label = unread > 0 ? `${workspace.name} — ${unread} unread` : workspace.name;
  return (
    <Link
      to="/w/$wsSlug"
      params={{ wsSlug: workspace.slug }}
      className="ws-rail-icon"
      data-current={current ? 'true' : undefined}
      aria-current={current ? 'page' : undefined}
      aria-label={label}
      title={label}
      // Already here: a click on the current workspace must not bounce the
      // URL off `/w/:slug` and back onto the chat you are reading.
      onClick={(e) => {
        if (current && !e.metaKey && !e.ctrlKey && !e.shiftKey) e.preventDefault();
      }}
    >
      <span className="ws-rail-mark" aria-hidden="true">
        {workspaceMark(workspace.name)}
      </span>
      {unread > 0 && (
        <span className="ws-rail-badge" aria-hidden="true">
          {unread > 99 ? '99+' : unread}
        </span>
      )}
    </Link>
  );
}
