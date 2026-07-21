import type { Tab } from '@muxpad/shared';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useDismissable } from '../lib/use-dismissable';
import { refreshTabs } from '../tabs';
import { openInNewTab, useLongPress } from '../use-long-press';
import { SvgClose } from './icons';
import './TabBarDropdown.css';

interface TabBarDropdownProps {
  tabs: Tab[];
  activeSlug: string | null;
  workspaceId: string;
  workspaceSlug: string;
}

/**
 * Collapsed-state dropdown shown when the tab bar runs out of room.
 * Mirrors the inline tab UI: lists all tabs, click any to switch.
 * Desktop-only — mobile uses MobileNavSwitcher.
 */
export function TabBarDropdown({
  tabs,
  activeSlug,
  workspaceId,
  workspaceSlug,
}: TabBarDropdownProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const navigate = useNavigate();

  const active = tabs.find((t) => t.slug === activeSlug);
  // How many *other* tabs are flagging attention. Surfaced on the
  // dropdown chevron (which is the only part of the trigger whose
  // semantics are "more inside, not this label") — colored accent to
  // signal "look here," and a small count to say how many. Sticking the
  // signal on the chevron and not on the trigger label avoids the
  // "looks like the active tab needs attention" misread.
  const otherAttentionCount = tabs.reduce(
    (n, t) => (t.attention && t.slug !== activeSlug ? n + 1 : n),
    0,
  );

  useDismissable(open, ref, () => setOpen(false));

  return (
    <div className="ws-tabbar-dropdown" ref={ref}>
      <button
        type="button"
        className="ws-tabbar-dropdown-trigger"
        onClick={() => setOpen((v) => !v)}
        title={
          otherAttentionCount > 0
            ? `${otherAttentionCount} other ${otherAttentionCount === 1 ? 'tab needs' : 'tabs need'} attention`
            : 'Switch tab'
        }
      >
        <span className="ws-tabbar-dropdown-label">{active?.name ?? 'Tabs'}</span>
        <span
          className="ws-tabbar-dropdown-chevron"
          data-attention={otherAttentionCount > 0 ? 'true' : undefined}
        >
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
          {otherAttentionCount > 0 && (
            <span
              className="ws-tabbar-dropdown-count"
              aria-label={`${otherAttentionCount} other ${otherAttentionCount === 1 ? 'tab needs' : 'tabs need'} attention`}
            >
              {otherAttentionCount}
            </span>
          )}
        </span>
      </button>
      {open && (
        <div className="ws-tabbar-dropdown-menu" role="menu">
          {tabs.map((t) => (
            <TabDropdownItem
              key={t.id}
              tab={t}
              isActive={t.slug === activeSlug}
              workspaceId={workspaceId}
              workspaceSlug={workspaceSlug}
              onSelect={() => {
                setOpen(false);
                if (t.slug !== activeSlug) {
                  void navigate({
                    to: '/w/$wsSlug/t/$tabSlug',
                    params: { wsSlug: workspaceSlug, tabSlug: t.slug },
                  });
                }
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface TabDropdownItemProps {
  tab: Tab;
  isActive: boolean;
  workspaceId: string;
  workspaceSlug: string;
  onSelect: () => void;
}

function TabDropdownItem({
  tab,
  isActive,
  workspaceId,
  workspaceSlug,
  onSelect,
}: TabDropdownItemProps) {
  const { pressing, handlers } = useLongPress({
    onLongPress: () =>
      openInNewTab(`/w/${encodeURIComponent(workspaceSlug)}/t/${encodeURIComponent(tab.slug)}`),
  });
  const onClose = async (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    // Confirm because closing a tab kills its running panes and any
    // unsaved work in them. cheap window.confirm is enough — personal
    // tool, single user.
    if (!window.confirm(`Close tab "${tab.name}"? Any running panes will be killed.`)) return;
    try {
      await api.deleteTab(tab.id);
      await refreshTabs(workspaceId);
    } catch (err) {
      console.error('deleteTab failed', err);
    }
  };
  return (
    <button
      type="button"
      className="ws-tabbar-dropdown-item"
      data-active={isActive ? 'true' : undefined}
      data-unread={tab.unread ? 'true' : undefined}
      data-pressing={pressing ? 'true' : undefined}
      {...handlers}
      onClick={(e) => {
        handlers.onClick(e);
        if (e.defaultPrevented) return;
        onSelect();
      }}
    >
      <span className="ws-tabbar-dropdown-item-label">
        <span className="ws-tabbar-dropdown-item-label-text">{tab.name}</span>
        {tab.attention && (
          // Render on the active row too — visiting a tab doesn't auto-
          // clear pane-level attention, so the active row's own dot is
          // a real signal that something inside still wants you.
          <span className="badge-dot -inline" aria-label="needs attention" />
        )}
      </span>
      {/* The close affordance is rendered as a sibling visual (a <span>
          with click) to avoid nested-button HTML. stopPropagation in
          onClose keeps the row's onClick from also firing. */}
      <span
        role="button"
        tabIndex={0}
        className="ws-tabbar-dropdown-item-close"
        onClick={onClose}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') void onClose(e as unknown as React.MouseEvent);
        }}
        title="Close tab"
        aria-label={`Close tab ${tab.name}`}
      >
        <SvgClose />
      </span>
    </button>
  );
}
