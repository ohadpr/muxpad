import type { Tab, Workspace } from '@muxpad/shared';
import { Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { getLastTabSlug } from '../lib/last-visited';
import { isExpanded, toggleExpanded, useNavExpansion } from '../lib/nav-expansion';
import { refreshTabs, useTabs } from '../tabs';
import { MAX_QUICK_SWITCH_TABS, useTabQuickSwitch } from '../use-tab-quickswitch';
import { refreshWorkspaces, useWorkspaces } from '../workspaces';
import { SvgClose } from './icons';
import './NavTree.css';

export type NavTreeVariant = 'sidebar' | 'sheet';

type Editing = { kind: 'workspace' | 'tab'; id: string } | null;

interface NavTreeProps {
  activeWorkspaceSlug: string;
  activeTabSlug: string | null;
  variant: NavTreeVariant;
  /** Called right before any row navigation — the sheet uses it to dismiss. */
  onNavigate?: () => void;
}

/**
 * The workspace/tab navigator tree — ONE component for both chrome homes:
 *
 *   variant="sidebar" — persistent left rail on desktop (Settings →
 *     Navigation → Sidebar). Replaces the WorkspaceSwitcher + TabBar top
 *     chrome entirely: dense file-navigator rows, hover-revealed close
 *     buttons, double-click inline rename on the active workspace/tab,
 *     Alt+1…9 quick-switch kept.
 *   variant="sheet" — content of the mobile bottom sheet. Same tree,
 *     thumb-height rows, close buttons always faintly present (touch has
 *     no hover).
 *
 * Hierarchy is carried by STRUCTURE (disclosure + indent) and STATE
 * (accent rail = "you are here", red dot = "wants you"), not type-size
 * escalation — the same grammar as the rest of muxpad's chrome.
 *
 * Every workspace is collapsible, including the active one. Expansion
 * state persists across sessions (lib/nav-expansion.ts); untouched
 * workspaces default to "expanded iff active", so the dominant flow —
 * switching tabs inside the current workspace — is always one click.
 */
export function NavTree({ activeWorkspaceSlug, activeTabSlug, variant, onNavigate }: NavTreeProps) {
  const navigate = useNavigate();
  const { workspaces } = useWorkspaces();
  const expansion = useNavExpansion();
  // Single edit slot hoisted here so only one rename can be in flight
  // across the whole tree.
  const [editing, setEditing] = useState<Editing>(null);
  const [creatingWs, setCreatingWs] = useState(false);

  const createWorkspace = async () => {
    if (creatingWs) return;
    setCreatingWs(true);
    try {
      // Bootstrap workspace + first tab + first pane in one go so the
      // user lands somewhere usable (same as WorkspaceSwitcher).
      const w = await api.createWorkspace();
      const t = await api.createTab(w.id);
      const pane = await api.createPane(t.id, {});
      await api.patchTab(t.id, { layout: pane.id });
      await refreshWorkspaces();
      onNavigate?.();
      void navigate({ to: '/w/$wsSlug/t/$tabSlug', params: { wsSlug: w.slug, tabSlug: t.slug } });
    } catch (err) {
      console.error('createWorkspace failed', err);
    } finally {
      setCreatingWs(false);
    }
  };

  return (
    <nav className="navtree" data-variant={variant} aria-label="Workspaces and tabs">
      <div className="navtree-section">
        <span className="navtree-section-label">Workspaces</span>
        <button
          type="button"
          className="navtree-section-add"
          onClick={() => void createWorkspace()}
          disabled={creatingWs}
          title="New workspace"
          aria-label="New workspace"
        >
          {creatingWs ? '…' : '+'}
        </button>
      </div>
      <div className="navtree-scroll">
        {workspaces.map((w) => (
          <WorkspaceNode
            key={w.id}
            workspace={w}
            isActive={w.slug === activeWorkspaceSlug}
            expanded={isExpanded(expansion, w.slug, activeWorkspaceSlug)}
            activeWorkspaceSlug={activeWorkspaceSlug}
            activeTabSlug={activeTabSlug}
            variant={variant}
            editing={editing}
            setEditing={setEditing}
            onNavigate={onNavigate}
          />
        ))}
      </div>
    </nav>
  );
}

interface WorkspaceNodeProps {
  workspace: Workspace;
  isActive: boolean;
  expanded: boolean;
  activeWorkspaceSlug: string;
  activeTabSlug: string | null;
  variant: NavTreeVariant;
  editing: Editing;
  setEditing: (e: Editing) => void;
  onNavigate?: (() => void) | undefined;
}

function WorkspaceNode({
  workspace,
  isActive,
  expanded,
  activeWorkspaceSlug,
  activeTabSlug,
  variant,
  editing,
  setEditing,
  onNavigate,
}: WorkspaceNodeProps) {
  const navigate = useNavigate();
  const isEditing = editing?.kind === 'workspace' && editing.id === workspace.id;

  const closeWorkspace = async (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    // Desktop keeps the confirm the old switcher had — closing cascade-
    // kills every tab and pane. The sheet stays confirm-free because
    // window.confirm is flaky in iOS PWA standalone mode (silent no-op).
    if (variant === 'sidebar') {
      const n = workspace.tab_count;
      if (
        !window.confirm(
          `Close workspace "${workspace.name}"? All ${n} ${n === 1 ? 'tab' : 'tabs'} and their panes will be killed.`,
        )
      )
        return;
    }
    try {
      await api.deleteWorkspace(workspace.id);
      await refreshWorkspaces();
      if (isActive) {
        onNavigate?.();
        void navigate({ to: '/' });
      }
    } catch (err) {
      console.error('deleteWorkspace failed', err);
      window.alert(`Failed to close workspace: ${String(err)}`);
    }
  };

  return (
    <div className="navtree-group" data-active={isActive ? 'true' : undefined}>
      <div className="navtree-ws-row" data-active={isActive ? 'true' : undefined}>
        <button
          type="button"
          className="navtree-disclosure"
          onClick={() => toggleExpanded(workspace.slug, activeWorkspaceSlug)}
          aria-expanded={expanded}
          aria-label={expanded ? `Collapse ${workspace.name}` : `Expand ${workspace.name}`}
          data-expanded={expanded ? 'true' : undefined}
        >
          <SvgChevronRight />
        </button>
        {isEditing ? (
          <RenameInput
            initial={workspace.name}
            onCommit={async (name) => {
              setEditing(null);
              if (!name || name === workspace.name) return;
              try {
                await api.patchWorkspace(workspace.id, { name });
              } catch (err) {
                console.error('rename workspace failed', err);
              }
              await refreshWorkspaces();
            }}
            onCancel={() => setEditing(null)}
          />
        ) : (
          <Link
            to="/w/$wsSlug"
            params={{ wsSlug: workspace.slug }}
            className="navtree-ws-name"
            title={variant === 'sidebar' && isActive ? 'Double-click to rename' : workspace.name}
            onDoubleClick={
              // Rename mirrors the old chrome's affordance: the ACTIVE
              // workspace only (avoids navigate-then-edit weirdness on
              // inactive rows). Sidebar only — the sheet is touch.
              variant === 'sidebar' && isActive
                ? (e) => {
                    e.preventDefault();
                    setEditing({ kind: 'workspace', id: workspace.id });
                  }
                : undefined
            }
            onClick={(e) => {
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
              onNavigate?.();
              // Jump straight to the last-visited tab in this workspace
              // if known, instead of the default first tab.
              const stored = getLastTabSlug(workspace.slug);
              if (stored) {
                e.preventDefault();
                void navigate({
                  to: '/w/$wsSlug/t/$tabSlug',
                  params: { wsSlug: workspace.slug, tabSlug: stored },
                });
              }
            }}
          >
            <span className="navtree-name-text">{workspace.name}</span>
            {workspace.attention && (
              <span className="badge-dot -inline" aria-label="needs attention" />
            )}
          </Link>
        )}
        {!expanded && workspace.tab_count > 0 && (
          // Collapsed rows surface what they're hiding — a quiet tab
          // count, file-navigator style.
          <span className="navtree-ws-count" aria-hidden="true">
            {workspace.tab_count}
          </span>
        )}
        <button
          type="button"
          className="navtree-close"
          onClick={(e) => void closeWorkspace(e)}
          title="Close workspace"
          aria-label={`Close workspace ${workspace.name}`}
        >
          <SvgClose />
        </button>
      </div>
      {expanded && (
        <TabList
          workspace={workspace}
          isActiveWorkspace={isActive}
          activeTabSlug={activeTabSlug}
          variant={variant}
          editing={editing}
          setEditing={setEditing}
          onNavigate={onNavigate}
        />
      )}
    </div>
  );
}

interface TabListProps {
  workspace: Workspace;
  isActiveWorkspace: boolean;
  activeTabSlug: string | null;
  variant: NavTreeVariant;
  editing: Editing;
  setEditing: (e: Editing) => void;
  onNavigate?: (() => void) | undefined;
}

/**
 * Mounted only while its workspace is expanded, so useTabs polls (and
 * keeps attention dots live) for exactly the workspaces you can see.
 */
function TabList({
  workspace,
  isActiveWorkspace,
  activeTabSlug,
  variant,
  editing,
  setEditing,
  onNavigate,
}: TabListProps) {
  const navigate = useNavigate();
  const { tabs } = useTabs(workspace.id);
  const [creating, setCreating] = useState(false);

  // Alt+1…9 quick-switch parity with the top-nav TabBar. Only the
  // sidebar wires it (the sheet is touch; TabBar owns it in top mode).
  // tabCount 0 disables the inactive instances without breaking the
  // rules of hooks.
  const quickEnabled = variant === 'sidebar' && isActiveWorkspace;
  const showQuickNumbers = useTabQuickSwitch({
    tabCount: quickEnabled ? tabs.length : 0,
    onSwitch: (i) => {
      const t = tabs[i];
      if (!t) return;
      void navigate({
        to: '/w/$wsSlug/t/$tabSlug',
        params: { wsSlug: workspace.slug, tabSlug: t.slug },
      });
    },
  });

  const closeTab = async (e: React.MouseEvent, tab: Tab) => {
    e.stopPropagation();
    e.preventDefault();
    // No window.confirm — flaky in iOS PWA standalone mode, and tabs are
    // lighter than workspaces. Tap = delete (same as the old mobile menu).
    try {
      await api.deleteTab(tab.id);
      await refreshTabs(workspace.id);
      await refreshWorkspaces(); // tab_count chips on collapsed rows
    } catch (err) {
      console.error('deleteTab failed', err);
      window.alert(`Failed to close tab: ${String(err)}`);
    }
  };

  const createTab = async () => {
    if (creating) return;
    setCreating(true);
    try {
      const t = await api.createTab(workspace.id);
      const pane = await api.createPane(t.id, {});
      await api.patchTab(t.id, { layout: pane.id });
      await refreshTabs(workspace.id);
      await refreshWorkspaces();
      onNavigate?.();
      void navigate({
        to: '/w/$wsSlug/t/$tabSlug',
        params: { wsSlug: workspace.slug, tabSlug: t.slug },
      });
    } catch (err) {
      console.error('createTab failed', err);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="navtree-tab-list">
      {tabs.map((t, i) => {
        const isActiveTab = isActiveWorkspace && t.slug === activeTabSlug;
        const isEditingTab = editing?.kind === 'tab' && editing.id === t.id;
        const quickNumber =
          showQuickNumbers && quickEnabled && i < MAX_QUICK_SWITCH_TABS ? i + 1 : undefined;
        return (
          <div
            key={t.id}
            className="navtree-tab-row"
            data-active={isActiveTab ? 'true' : undefined}
          >
            {isEditingTab ? (
              <RenameInput
                initial={t.name}
                onCommit={async (name) => {
                  setEditing(null);
                  if (!name || name === t.name) return;
                  try {
                    await api.patchTab(t.id, { name });
                  } catch (err) {
                    console.error('rename tab failed', err);
                  }
                  await refreshTabs(workspace.id);
                }}
                onCancel={() => setEditing(null)}
              />
            ) : (
              <Link
                to="/w/$wsSlug/t/$tabSlug"
                params={{ wsSlug: workspace.slug, tabSlug: t.slug }}
                className="navtree-tab-link"
                title={variant === 'sidebar' && isActiveTab ? 'Double-click to rename' : t.name}
                onDoubleClick={
                  variant === 'sidebar' && isActiveTab
                    ? (e) => {
                        e.preventDefault();
                        setEditing({ kind: 'tab', id: t.id });
                      }
                    : undefined
                }
                onClick={(e) => {
                  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
                  onNavigate?.();
                }}
              >
                {quickNumber !== undefined && (
                  <span className="navtree-quicknum" aria-hidden="true">
                    {quickNumber}
                  </span>
                )}
                <span className="navtree-name-text">{t.name}</span>
                {t.attention && <span className="badge-dot -inline" aria-label="needs attention" />}
              </Link>
            )}
            <button
              type="button"
              className="navtree-close"
              onClick={(e) => void closeTab(e, t)}
              title="Close tab"
              aria-label={`Close tab ${t.name}`}
            >
              <SvgClose />
            </button>
          </div>
        );
      })}
      <button
        type="button"
        className="navtree-new-tab"
        onClick={() => void createTab()}
        disabled={creating}
      >
        {creating ? 'Creating…' : '+ New tab'}
      </button>
    </div>
  );
}

function RenameInput({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const ref = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <input
      ref={ref}
      className="navtree-rename"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => onCommit(draft.trim())}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          onCommit(draft.trim());
        } else if (e.key === 'Escape') {
          e.preventDefault();
          onCancel();
        }
      }}
    />
  );
}

function SvgChevronRight() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <path
        d="M3 2 L7 5 L3 8"
        stroke="currentColor"
        strokeWidth="1.5"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
