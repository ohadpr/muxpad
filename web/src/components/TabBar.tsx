import type { Tab } from '@muxpad/shared';
import { Link, useNavigate, useRouterState } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import type { DragEvent as ReactDragEvent } from 'react';
import { api } from '../api';
import { refreshTabs, useTabs } from '../tabs';
import { openInNewTab, useLongPress } from '../use-long-press';
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

  const { ref: tabsRef, overflowing } = useHorizontalOverflow<HTMLElement>([tabs.length]);

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
    const side: 'before' | 'after' = e.clientX < rect.left + rect.width / 2 ? 'before' : 'after';
    setDropTargetId(id);
    setDropSide(side);
  };

  const onDragEnd = () => {
    setDragId(null);
    setDropTargetId(null);
  };

  const onDrop = async (e: ReactDragEvent<HTMLAnchorElement>, targetId: string) => {
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
            <TabItem
              key={t.id}
              tab={t}
              workspaceSlug={workspaceSlug}
              isActive={isActive}
              dropSide={dropTargetId === t.id ? dropSide : undefined}
              onDragStart={(e) => onDragStart(e, t.id)}
              onDragOver={(e) => onDragOver(e, t.id)}
              onDragEnd={onDragEnd}
              onDrop={(e) => void onDrop(e, t.id)}
              onStartEdit={() => startEdit(t)}
            />
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

interface TabItemProps {
  tab: Tab;
  workspaceSlug: string;
  isActive: boolean;
  dropSide: 'before' | 'after' | undefined;
  onDragStart: (e: ReactDragEvent<HTMLAnchorElement>) => void;
  onDragOver: (e: ReactDragEvent<HTMLAnchorElement>) => void;
  onDragEnd: () => void;
  onDrop: (e: ReactDragEvent<HTMLAnchorElement>) => void;
  onStartEdit: () => void;
}

function TabItem({
  tab,
  workspaceSlug,
  isActive,
  dropSide,
  onDragStart,
  onDragOver,
  onDragEnd,
  onDrop,
  onStartEdit,
}: TabItemProps) {
  const { pressing, handlers } = useLongPress({
    onLongPress: () =>
      openInNewTab(`/w/${encodeURIComponent(workspaceSlug)}/t/${encodeURIComponent(tab.slug)}`),
  });
  return (
    <Link
      to="/w/$wsSlug/t/$tabSlug"
      params={{ wsSlug: workspaceSlug, tabSlug: tab.slug }}
      className="ws-tab"
      data-active={isActive}
      data-drop={dropSide}
      data-pressing={pressing ? 'true' : undefined}
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDrop={onDrop}
      onDoubleClick={isActive ? onStartEdit : undefined}
      {...handlers}
      title={
        tab.attention && !isActive
          ? `${tab.name}: needs attention`
          : isActive
            ? 'Double-click to rename'
            : tab.name
      }
    >
      <span className="ws-tab-label">{tab.name}</span>
      {!isActive && tab.attention && (
        <span className="badge-dot" aria-label="needs attention" />
      )}
    </Link>
  );
}
