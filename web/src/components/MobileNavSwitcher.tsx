import { Link, useNavigate, useRouterState } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { Tab } from '@muxpad/shared';
import { refreshTabs, useTabs } from '../tabs';
import { refreshWorkspaces, useWorkspaces } from '../workspaces';
import { getLastTabSlug } from '../lib/last-visited';
import { SvgClose } from './icons';
import './MobileNavSwitcher.css';

interface Props {
  activeWorkspaceSlug: string;
}

/**
 * Mobile-only chrome trigger that replaces the desktop's separate
 * WorkspaceSwitcher + TabBar with a single breadcrumb-style trigger
 * and a TREE dropdown.
 *
 * Trigger: `Workspace ▸ Tab ▾` — at-a-glance hierarchy without two
 * pills competing for thumbspace.
 *
 * Menu: workspaces listed; the active workspace's tabs are
 * auto-expanded so the dominant flow (switch tabs inside the current
 * workspace) is one tap from the open menu. Other workspaces collapse
 * to a single row with a disclosure chevron — tapping the chevron
 * lazy-loads + reveals that workspace's tabs; tapping the workspace
 * name navigates to its last-visited tab (uses `last-visited.ts`).
 *
 * 4-tap cross-workspace switches drop to 2 taps; in-workspace switches
 * stay at 2 taps (open menu, tap target). Tabs and workspaces both
 * still carry per-row close affordances + attention dots, same shape
 * the desktop dropdowns use.
 */
export function MobileNavSwitcher({ activeWorkspaceSlug }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const navigate = useNavigate();

  const { workspaces } = useWorkspaces();
  const activeWorkspace = workspaces.find((w) => w.slug === activeWorkspaceSlug);
  const { tabs: activeWorkspaceTabs } = useTabs(activeWorkspace?.id ?? '');

  // Resolve the active tab slug from the route so the trigger label
  // can show the breadcrumb's right side.
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const tabMatch = pathname.match(/^\/w\/[^/]+\/t\/([^/]+)/);
  const activeTabSlug = tabMatch?.[1] ?? null;
  const activeTab = activeWorkspaceTabs.find((t) => t.slug === activeTabSlug);

  // Track which non-active workspaces the user has expanded in the
  // menu, plus a cache of their lazily-fetched tabs.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [otherTabs, setOtherTabs] = useState<Record<string, Tab[]>>({});

  // Close menu on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
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

  const isExpanded = (slug: string) => slug === activeWorkspaceSlug || expanded.has(slug);

  const toggleExpand = async (wsId: string, wsSlug: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(wsSlug)) next.delete(wsSlug);
      else next.add(wsSlug);
      return next;
    });
    if (!otherTabs[wsId]) {
      try {
        const tabs = await api.listTabs(wsId);
        setOtherTabs((prev) => ({ ...prev, [wsId]: tabs }));
      } catch {
        // best-effort; user can retry by collapsing/re-expanding
      }
    }
  };

  const tabsFor = (wsId: string, wsSlug: string): Tab[] => {
    if (wsSlug === activeWorkspaceSlug) return activeWorkspaceTabs;
    return otherTabs[wsId] ?? [];
  };

  const anyOtherWorkspaceAttention = workspaces.some(
    (w) => w.attention && w.slug !== activeWorkspaceSlug,
  );

  const onCloseTab = async (e: React.MouseEvent, tab: Tab, wsId: string) => {
    e.stopPropagation();
    e.preventDefault();
    // No window.confirm here — it's flaky in iOS PWA standalone mode
    // (sometimes silently no-ops, leaving the user confused "why didn't
    // close work"). Tap = delete. If you need undo, add a toast.
    try {
      await api.deleteTab(tab.id);
      await refreshTabs(wsId);
      if (otherTabs[wsId]) {
        const tabs = await api.listTabs(wsId);
        setOtherTabs((prev) => ({ ...prev, [wsId]: tabs }));
      }
    } catch (err) {
      console.error('deleteTab failed', err);
      window.alert(`Failed to close tab: ${String(err)}`);
    }
  };

  const onCloseWorkspace = async (
    e: React.MouseEvent,
    ws: { id: string; name: string; tab_count: number },
  ) => {
    e.stopPropagation();
    e.preventDefault();
    // Server cascades tabs + panes before dropping the workspace, so
    // this is now a single call.
    try {
      await api.deleteWorkspace(ws.id);
      await refreshWorkspaces();
      if (ws.id === activeWorkspace?.id) {
        setOpen(false);
        void navigate({ to: '/' });
      }
    } catch (err) {
      console.error('deleteWorkspace failed', err);
      window.alert(`Failed to close workspace: ${String(err)}`);
    }
  };

  const createTab = async (wsId: string, wsSlug: string) => {
    try {
      const t = await api.createTab(wsId);
      const pane = await api.createPane(t.id, {});
      await api.patchTab(t.id, { layout: pane.id });
      await refreshTabs(wsId);
      setOpen(false);
      void navigate({
        to: '/w/$wsSlug/t/$tabSlug',
        params: { wsSlug, tabSlug: t.slug },
      });
    } catch (err) {
      console.error('createTab failed', err);
    }
  };

  const createWorkspace = async () => {
    try {
      const w = await api.createWorkspace();
      const t = await api.createTab(w.id);
      const pane = await api.createPane(t.id, {});
      await api.patchTab(t.id, { layout: pane.id });
      await refreshWorkspaces();
      setOpen(false);
      void navigate({
        to: '/w/$wsSlug/t/$tabSlug',
        params: { wsSlug: w.slug, tabSlug: t.slug },
      });
    } catch (err) {
      console.error('createWorkspace failed', err);
    }
  };

  const triggerLabel = activeWorkspace ? (
    <>
      <span className="mns-trigger-ws">{activeWorkspace.name}</span>
      <span className="mns-trigger-sep" aria-hidden="true">
        ›
      </span>
      <span className="mns-trigger-tab">{activeTab?.name ?? '—'}</span>
    </>
  ) : (
    'Workspaces'
  );

  return (
    <div className="mns" ref={rootRef}>
      <button
        type="button"
        className="mns-trigger"
        onClick={() => setOpen((v) => !v)}
        data-attention={anyOtherWorkspaceAttention ? 'true' : undefined}
        title="Switch workspace / tab"
      >
        <span className="mns-trigger-label">{triggerLabel}</span>
        <span className="mns-trigger-chevron">
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
        </span>
      </button>
      {open && (
        <div className="mns-menu" role="menu">
          {workspaces.map((w) => {
            const isActive = w.slug === activeWorkspaceSlug;
            const expandedNow = isExpanded(w.slug);
            const tabs = tabsFor(w.id, w.slug);
            return (
              <div key={w.id} className="mns-ws-group">
                <div className="mns-ws-row" data-active={isActive ? 'true' : undefined}>
                  {/* Disclosure column — reserves space even when there's
                      no chevron so workspace names align across all rows.
                      Active workspace's tabs are always shown; we render
                      a blank slot instead of an inert "disabled chevron". */}
                  {isActive ? (
                    <span className="mns-disclosure mns-disclosure-empty" aria-hidden="true" />
                  ) : (
                    <button
                      type="button"
                      className="mns-disclosure"
                      onClick={() => void toggleExpand(w.id, w.slug)}
                      aria-label={expandedNow ? `Collapse ${w.name}` : `Expand ${w.name}`}
                      data-expanded={expandedNow ? 'true' : undefined}
                    >
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
                    </button>
                  )}
                  <Link
                    to="/w/$wsSlug"
                    params={{ wsSlug: w.slug }}
                    className="mns-ws-name"
                    onClick={(e) => {
                      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
                      setOpen(false);
                      // Override the default Link nav: jump straight to
                      // the last-visited tab in this workspace if known.
                      const stored = getLastTabSlug(w.slug);
                      if (stored) {
                        e.preventDefault();
                        void navigate({
                          to: '/w/$wsSlug/t/$tabSlug',
                          params: { wsSlug: w.slug, tabSlug: stored },
                        });
                      }
                    }}
                  >
                    <span className="mns-ws-name-text">{w.name}</span>
                    {w.attention && (
                      <span className="badge-dot -inline" aria-label="needs attention" />
                    )}
                  </Link>
                  <button
                    type="button"
                    className="mns-close"
                    onClick={(e) => void onCloseWorkspace(e, w)}
                    title="Close workspace"
                    aria-label={`Close workspace ${w.name}`}
                  >
                    <SvgClose />
                  </button>
                </div>
                {expandedNow && (
                  <div className="mns-tab-list">
                    {tabs.map((t) => {
                      const isActiveTab = isActive && t.slug === activeTabSlug;
                      // Close button now sits OUTSIDE the <Link> as a
                      // sibling — nesting a clickable span inside an <a>
                      // can let the link swallow the tap on some browsers
                      // even with stopPropagation. The row is a plain div
                      // so we can have both a real <button> and an <a>
                      // as direct children without nested-interactive HTML.
                      return (
                        <div
                          key={t.id}
                          className="mns-tab-row"
                          data-active={isActiveTab ? 'true' : undefined}
                        >
                          <Link
                            to="/w/$wsSlug/t/$tabSlug"
                            params={{ wsSlug: w.slug, tabSlug: t.slug }}
                            className="mns-tab-link"
                            onClick={(e) => {
                              if (
                                e.metaKey ||
                                e.ctrlKey ||
                                e.shiftKey ||
                                e.altKey ||
                                e.button !== 0
                              )
                                return;
                              setOpen(false);
                            }}
                          >
                            <span className="mns-tab-name">
                              <span className="mns-tab-name-text">{t.name}</span>
                              {t.attention && (
                                <span className="badge-dot -inline" aria-label="needs attention" />
                              )}
                            </span>
                          </Link>
                          <button
                            type="button"
                            className="mns-close"
                            onClick={(e) => void onCloseTab(e, t, w.id)}
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
                      className="mns-new-tab"
                      onClick={() => void createTab(w.id, w.slug)}
                    >
                      + New tab
                    </button>
                  </div>
                )}
              </div>
            );
          })}
          <button type="button" className="mns-new-workspace" onClick={() => void createWorkspace()}>
            + New workspace
          </button>
        </div>
      )}
    </div>
  );
}
