import { Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { openInNewTab, useLongPress } from '../use-long-press';
import { refreshWorkspaces, useWorkspaces } from '../workspaces';
import './WorkspaceSwitcher.css';

interface WorkspaceSwitcherProps {
  activeWorkspaceSlug: string;
}

/**
 * Dropdown next to the brand showing the current workspace name with a
 * chevron. Click to open a menu listing all workspaces; click any to
 * switch. "+ New workspace" at the bottom creates one and navigates in.
 * Double-click the trigger to inline-rename the active workspace.
 */
export function WorkspaceSwitcher({ activeWorkspaceSlug }: WorkspaceSwitcherProps) {
  const { workspaces } = useWorkspaces();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [creating, setCreating] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const navigate = useNavigate();

  const active = workspaces.find((w) => w.slug === activeWorkspaceSlug);
  // Dot on the trigger when any *other* workspace has attention.
  const anyOtherAttention = workspaces.some((w) => w.attention && w.slug !== activeWorkspaceSlug);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const startEdit = () => {
    if (!active) return;
    setOpen(false);
    setDraft(active.name);
    setEditing(true);
  };

  const commitRename = async () => {
    if (!active) return;
    const trimmed = draft.trim();
    setEditing(false);
    if (!trimmed || trimmed === active.name) return;
    try {
      await api.patchWorkspace(active.id, { name: trimmed });
    } catch (err) {
      console.error('rename workspace failed', err);
    }
    await refreshWorkspaces();
  };

  const create = async () => {
    if (creating) return;
    setCreating(true);
    setOpen(false);
    try {
      // Bootstrap a workspace + first tab + first pane in one go so the
      // user lands somewhere usable. Without the tab, WorkspaceLayout's
      // auto-close-empty would immediately delete the new workspace.
      const w = await api.createWorkspace();
      const t = await api.createTab(w.id);
      const pane = await api.createPane(t.id, {});
      await api.patchTab(t.id, { layout: pane.id });
      await refreshWorkspaces();
      void navigate({
        to: '/w/$wsSlug/t/$tabSlug',
        params: { wsSlug: w.slug, tabSlug: t.slug },
      });
    } finally {
      setCreating(false);
    }
  };

  if (editing && active) {
    return (
      <div className="ws-switcher ws-switcher-editing" ref={ref}>
        <input
          ref={inputRef}
          className="ws-switcher-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => void commitRename()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void commitRename();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              setEditing(false);
            }
          }}
          size={Math.max(8, draft.length + 1)}
        />
      </div>
    );
  }

  return (
    <div className="ws-switcher" ref={ref}>
      <button
        type="button"
        className="ws-switcher-trigger"
        data-open={open ? 'true' : undefined}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        onDoubleClick={startEdit}
        title={
          anyOtherAttention
            ? 'Another workspace needs attention'
            : active
              ? 'Double-click to rename'
              : 'Switch workspace'
        }
      >
        <span className="ws-switcher-label">{active?.name ?? 'Workspaces'}</span>
        <span className="ws-switcher-chevron">
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path
              d="M2 4 L5 7 L8 4"
              stroke="currentColor"
              strokeWidth="1.5"
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          {anyOtherAttention && (
            <span className="badge-dot" aria-label="another workspace needs attention" />
          )}
        </span>
      </button>
      {open && (
        <div className="ws-switcher-menu" role="menu">
          <div className="ws-switcher-section-label">Workspaces</div>
          {workspaces.map((w) => (
            <WorkspaceItem
              key={w.id}
              slug={w.slug}
              name={w.name}
              tabCount={w.tab_count}
              isActive={w.slug === activeWorkspaceSlug}
              attention={Boolean(w.attention)}
              onPlainClick={() => setOpen(false)}
            />
          ))}
          <div className="ws-switcher-divider" />
          <button
            type="button"
            className="ws-switcher-item ws-switcher-item-add"
            onClick={() => void create()}
            disabled={creating}
          >
            {creating ? 'Creating…' : '+ New workspace'}
          </button>
        </div>
      )}
    </div>
  );
}

interface WorkspaceItemProps {
  slug: string;
  name: string;
  tabCount: number;
  isActive: boolean;
  attention: boolean;
  onPlainClick: () => void;
}

function WorkspaceItem({
  slug,
  name,
  tabCount,
  isActive,
  attention,
  onPlainClick,
}: WorkspaceItemProps) {
  const { pressing, handlers } = useLongPress({
    onLongPress: () => openInNewTab(`/w/${slug}`),
  });
  return (
    <Link
      to="/w/$wsSlug"
      params={{ wsSlug: slug }}
      className="ws-switcher-item"
      data-active={isActive ? 'true' : undefined}
      data-pressing={pressing ? 'true' : undefined}
      {...handlers}
      onClick={(e) => {
        handlers.onClick(e);
        if (e.defaultPrevented) return;
        // Let cmd/ctrl-click + middle-click fall through to the browser's
        // "open in new tab" behavior. Only intercept plain click to close
        // the menu.
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        onPlainClick();
      }}
    >
      <span className="ws-switcher-item-label">
        <span className="ws-switcher-item-label-text">{name}</span>
        {!isActive && attention && (
          <span className="badge-dot -inline" aria-label="needs attention" />
        )}
      </span>
      <span className="ws-switcher-item-meta">
        {tabCount} {tabCount === 1 ? 'tab' : 'tabs'}
      </span>
    </Link>
  );
}
