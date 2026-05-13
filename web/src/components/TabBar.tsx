import { useEffect, useRef, useState } from 'react';
import type { DragEvent as ReactDragEvent } from 'react';
import { Link, useNavigate, useRouterState } from '@tanstack/react-router';
import { api } from '../api';
import { refreshTabs, useTabs } from '../tabs';
import { useWindowAttention } from '../use-window-attention';
import { useHorizontalOverflow } from '../use-overflow';
import { TabBarDropdown } from './TabBarDropdown';
import './TabBar.css';

const DRAG_MIME = 'application/x-muxpad-tab-id';

interface TabBarProps {
  workspaceId: string;
  workspaceSlug: string;
}

/**
 * The horizontal bar of tabs for a single workspace. Renders the list,
 * supports inline rename (double-click active), drag-to-reorder, and
 * collapses to a single dropdown when too narrow.
 */
export function TabBar({ workspaceId, workspaceSlug }: TabBarProps) {
  const { tabs } = useTabs(workspaceId);
  useWindowAttention(tabs);
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const editInputRef = useRef<HTMLInputElement | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [dropSide, setDropSide] = useState<'before' | 'after'>('before');

  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const activeSlug = matchActiveTabSlug(pathname);

  const { ref: tabsRef, overflowing } = useHorizontalOverflow<HTMLElement>([
    tabs.length,
  ]);

  useEffect(() => {
    if (editingId) {
      editInputRef.current?.focus();
      editInputRef.current?.select();
    }
  }, [editingId]);

  const startEdit = (t: { id: string; name: string }) => {
    setEditingId(t.id);
    setDraft(t.name);
  };

  const commitRename = async () => {
    const id = editingId;
    if (!id) return;
    const trimmed = draft.trim();
    setEditingId(null);
    if (!trimmed) return;
    const target = tabs.find((t) => t.id === id);
    if (!target || trimmed === target.name) return;
    try {
      await api.patchTab(id, { name: trimmed });
    } catch (err) {
      console.error('rename failed', err);
    }
    await refreshTabs(workspaceId);
  };

  const cancelRename = () => setEditingId(null);

  const create = async () => {
    if (creating) return;
    setCreating(true);
    try {
      const t = await api.createTab(workspaceId);
      const pane = await api.createPane(t.id, {});
      await api.patchTab(t.id, { layout: pane.id });
      await refreshTabs(workspaceId);
      void navigate({
        to: '/w/$wsSlug/t/$tabSlug',
        params: { wsSlug: workspaceSlug, tabSlug: t.slug },
      });
    } finally {
      setCreating(false);
    }
  };

  // ── Drag-to-reorder ──────────────────────────────────────────────────

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
    const ids = tabs.map((t) => t.id);
    const sourceIdx = ids.indexOf(sourceId);
    if (sourceIdx === -1) return;
    ids.splice(sourceIdx, 1);
    let insertAt = ids.indexOf(targetId);
    if (insertAt === -1) return;
    if (side === 'after') insertAt += 1;
    ids.splice(insertAt, 0, sourceId);
    try {
      await api.reorderTabs(ids);
    } catch (err) {
      console.error('reorder failed', err);
    }
    await refreshTabs(workspaceId);
  };

  return (
    <div className="ws-tabbar-tabs-wrap">
      <nav
        className="ws-tabbar-tabs"
        aria-label="Tabs"
        data-collapsed={overflowing ? 'true' : undefined}
        ref={tabsRef as React.RefObject<HTMLElement>}
      >
        {tabs.map((t) => {
          const isActive = t.slug === activeSlug;
          if (isActive && editingId === t.id) {
            return (
              <div key={t.id} className="ws-tab ws-tab-editing" data-active="true">
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
              key={t.id}
              to="/w/$wsSlug/t/$tabSlug"
              params={{ wsSlug: workspaceSlug, tabSlug: t.slug }}
              className="ws-tab"
              data-active={isActive}
              data-attention={!isActive && t.attention ? 'true' : undefined}
              data-drop={dropTargetId === t.id ? dropSide : undefined}
              draggable
              onDragStart={(e) => onDragStart(e, t.id)}
              onDragOver={(e) => onDragOver(e, t.id)}
              onDragEnd={onDragEnd}
              onDrop={(e) => void onDrop(e, t.id)}
              onDoubleClick={isActive ? () => startEdit(t) : undefined}
              title={
                t.attention && !isActive
                  ? `${t.name}: needs attention`
                  : isActive
                  ? 'Double-click to rename'
                  : t.name
              }
            >
              <span className="ws-tab-label">{t.name}</span>
            </Link>
          );
        })}
        <button
          type="button"
          className="ws-tab-add"
          onClick={() => void create()}
          disabled={creating}
          title="New tab"
          aria-label="New tab"
        >
          {creating ? '…' : '+'}
        </button>
      </nav>
      {overflowing && (
        <TabBarDropdown tabs={tabs} activeSlug={activeSlug} workspaceSlug={workspaceSlug} />
      )}
      {overflowing && (
        <button
          type="button"
          className="ws-tab-add ws-tab-add-floating"
          onClick={() => void create()}
          disabled={creating}
          title="New tab"
          aria-label="New tab"
        >
          {creating ? '…' : '+'}
        </button>
      )}
    </div>
  );
}

function matchActiveTabSlug(pathname: string): string | null {
  const m = pathname.match(/^\/w\/[^/]+\/t\/([^/]+)/);
  return m?.[1] ? decodeURIComponent(m[1]) : null;
}
