import { useEffect, useRef, useState } from 'react';
import type { DragEvent as ReactDragEvent } from 'react';
import { Link, useNavigate, useRouterState } from '@tanstack/react-router';
import { api } from '../api';
import { Brand } from './Brand';
import { SettingsMenu } from './SettingsMenu';
import { GitHubLink } from './GitHubLink';
import { refreshWorkspaces, useWorkspaces } from '../workspaces';
import { useWindowAttention } from '../use-window-attention';
import { useHorizontalOverflow } from '../use-overflow';
import { WorkspaceDropdown } from './WorkspaceDropdown';
import './WorkspaceTabBar.css';

const DRAG_MIME = 'application/x-muxpad-workspace-id';

export function WorkspaceTabBar() {
  const { workspaces } = useWorkspaces();
  useWindowAttention(workspaces);
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const editInputRef = useRef<HTMLInputElement | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [dropSide, setDropSide] = useState<'before' | 'after'>('before');

  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const activeSlug = matchActiveSlug(pathname);
  const isHome = pathname === '/';

  // Tabs collapse to a dropdown when the bar is too narrow to show them
  // all. The nav element is always rendered for measurement; we hide it
  // (visibility, not display) when overflowing so the next measurement
  // still has something to compare against. See use-overflow.ts.
  const { ref: tabsRef, overflowing } = useHorizontalOverflow<HTMLElement>([
    workspaces.length,
    isHome,
  ]);

  useEffect(() => {
    if (editingId) {
      editInputRef.current?.focus();
      editInputRef.current?.select();
    }
  }, [editingId]);

  const startEdit = (w: { id: string; name: string }) => {
    setEditingId(w.id);
    setDraft(w.name);
  };

  const commitRename = async () => {
    const id = editingId;
    if (!id) return;
    const trimmed = draft.trim();
    setEditingId(null);
    if (!trimmed) return;
    const target = workspaces.find((w) => w.id === id);
    if (!target || trimmed === target.name) return;
    try {
      await api.patchWorkspace(id, { name: trimmed });
    } catch (err) {
      console.error('rename failed', err);
    }
    await refreshWorkspaces();
  };

  const cancelRename = () => setEditingId(null);

  const create = async () => {
    if (creating) return;
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

  // ── Drag-to-reorder ────────────────────────────────────────────────────

  const onDragStart = (e: ReactDragEvent<HTMLAnchorElement>, id: string) => {
    e.dataTransfer.setData(DRAG_MIME, id);
    e.dataTransfer.effectAllowed = 'move';
    setDragId(id);
  };

  const onDragOver = (e: ReactDragEvent<HTMLAnchorElement>, id: string) => {
    if (!dragId || dragId === id) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = e.currentTarget.getBoundingClientRect();
    const side: 'before' | 'after' =
      e.clientX < rect.left + rect.width / 2 ? 'before' : 'after';
    setDropTargetId(id);
    setDropSide(side);
  };

  const onDragEnd = () => {
    setDragId(null);
    setDropTargetId(null);
  };

  const onDrop = async (
    e: ReactDragEvent<HTMLAnchorElement>,
    targetId: string,
  ) => {
    e.preventDefault();
    const sourceId = e.dataTransfer.getData(DRAG_MIME) || dragId;
    const side = dropSide;
    setDragId(null);
    setDropTargetId(null);
    if (!sourceId || sourceId === targetId) return;
    const ids = workspaces.map((w) => w.id);
    const sourceIdx = ids.indexOf(sourceId);
    if (sourceIdx === -1) return;
    ids.splice(sourceIdx, 1);
    let insertAt = ids.indexOf(targetId);
    if (insertAt === -1) return;
    if (side === 'after') insertAt += 1;
    ids.splice(insertAt, 0, sourceId);
    try {
      await api.reorderWorkspaces(ids);
    } catch (err) {
      console.error('reorder failed', err);
    }
    await refreshWorkspaces();
  };

  return (
    <header className="ws-tabbar">
      <Brand asLink={true} responsive={true} />
      {!isHome && <span className="ws-tabbar-divider" aria-hidden />}

      {!isHome && (
      <div className="ws-tabbar-tabs-wrap">
      <nav
        className="ws-tabbar-tabs"
        aria-label="Workspaces"
        data-collapsed={overflowing ? 'true' : undefined}
        ref={tabsRef as React.RefObject<HTMLElement>}
      >
        {workspaces.map((w) => {
          const isActive = w.slug === activeSlug;
          if (isActive && editingId === w.id) {
            return (
              <div key={w.id} className="ws-tab ws-tab-editing" data-active="true">
                <input
                  ref={editInputRef}
                  className="ws-tab-input"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={() => void commitRename()}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void commitRename();
                    } else if (e.key === 'Escape') {
                      e.preventDefault();
                      cancelRename();
                    }
                  }}
                  size={Math.max(8, draft.length + 1)}
                />
              </div>
            );
          }
          return (
            <Link
              key={w.id}
              to="/w/$slug"
              params={{ slug: w.slug }}
              className="ws-tab"
              data-active={isActive}
              data-attention={!isActive && w.attention ? 'true' : undefined}
              data-drop={dropTargetId === w.id ? dropSide : undefined}
              draggable
              onDragStart={(e) => onDragStart(e, w.id)}
              onDragOver={(e) => onDragOver(e, w.id)}
              onDragEnd={onDragEnd}
              onDrop={(e) => void onDrop(e, w.id)}
              onDoubleClick={isActive ? () => startEdit(w) : undefined}
              title={
                w.attention && !isActive
                  ? `${w.name}: needs attention`
                  : isActive
                  ? 'Double-click to rename'
                  : w.name
              }
            >
              <span className="ws-tab-label">{w.name}</span>
            </Link>
          );
        })}
        <button
          type="button"
          className="ws-tab-add"
          onClick={() => void create()}
          disabled={creating}
          title="New workspace"
          aria-label="New workspace"
        >
          {creating ? '…' : '+'}
        </button>
      </nav>
      {overflowing && (
        <WorkspaceDropdown workspaces={workspaces} activeSlug={activeSlug} />
      )}
      </div>
      )}

      {/* When tabs are present, they take flex:1 and push the action
          buttons to the right. The spacer is only needed on the home
          page (no tabs). */}
      {isHome && <span className="ws-tabbar-spacer" />}
      {/* When the dropdown is in collapsed mode, expose a + button next
          to it so creating a new workspace is still one click. */}
      {!isHome && overflowing && (
        <button
          type="button"
          className="ws-tab-add ws-tab-add-floating"
          onClick={() => void create()}
          disabled={creating}
          title="New workspace"
          aria-label="New workspace"
        >
          {creating ? '…' : '+'}
        </button>
      )}
      <GitHubLink />
      <SettingsMenu />
    </header>
  );
}

function matchActiveSlug(pathname: string): string | null {
  const m = pathname.match(/^\/w\/([^/]+)/);
  return m?.[1] ? decodeURIComponent(m[1]) : null;
}
