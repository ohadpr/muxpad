import type { Tab } from '@muxpad/shared';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { openInNewTab, useLongPress } from '../use-long-press';

interface TabBarDropdownProps {
  tabs: Tab[];
  activeSlug: string | null;
  workspaceSlug: string;
}

/**
 * Collapsed-state dropdown shown when the tab bar runs out of room.
 * Mirrors the inline tab UI: lists all tabs, click any to switch.
 */
export function TabBarDropdown({ tabs, activeSlug, workspaceSlug }: TabBarDropdownProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const navigate = useNavigate();

  const active = tabs.find((t) => t.slug === activeSlug);
  // True iff any non-active tab is flagging attention. The dropdown trigger
  // gets a small dot in that case so the user knows there's something
  // pending behind the collapsed list.
  const anyOtherAttention = tabs.some((t) => t.attention && t.slug !== activeSlug);

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

  return (
    <div className="ws-tabbar-dropdown" ref={ref}>
      <button
        type="button"
        className="ws-tabbar-dropdown-trigger"
        onClick={() => setOpen((v) => !v)}
        title={anyOtherAttention ? 'Another tab needs attention' : 'Switch tab'}
      >
        <span className="ws-tabbar-dropdown-label">{active?.name ?? 'Tabs'}</span>
        <span className="ws-tabbar-dropdown-chevron">
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
            <span className="badge-dot" aria-label="another tab needs attention" />
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
  workspaceSlug: string;
  onSelect: () => void;
}

function TabDropdownItem({ tab, isActive, workspaceSlug, onSelect }: TabDropdownItemProps) {
  const { pressing, handlers } = useLongPress({
    onLongPress: () =>
      openInNewTab(`/w/${encodeURIComponent(workspaceSlug)}/t/${encodeURIComponent(tab.slug)}`),
  });
  return (
    <button
      type="button"
      className="ws-tabbar-dropdown-item"
      data-active={isActive ? 'true' : undefined}
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
        {!isActive && tab.attention && (
          <span className="badge-dot -inline" aria-label="needs attention" />
        )}
      </span>
    </button>
  );
}
