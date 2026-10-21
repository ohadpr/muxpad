import type { PaneStatus, Tab } from '@muxpad/shared';
import { rollupStatus } from '@muxpad/shared';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { noticeFromError } from '../lib/notice-store';
import { useArmed } from '../lib/use-armed';
import { useDismissable } from '../lib/use-dismissable';
import { refreshTabs } from '../tabs';
import { openInNewTab, useLongPress } from '../use-long-press';
import { StatusMark } from './StatusMark';
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
  // What the COLLAPSED trigger has to say about the tabs it is hiding. It
  // carried exactly one bit before — "some other tab rang BEL" — so the
  // overflow chrome could not tell you anything was WORKING, which is the
  // state you spend most of your day in (D10).
  //
  // The trigger shows the same rail as every other surface, rolled up over the
  // OTHER tabs only: a mark on the label you're already reading would read as
  // "the active tab needs attention". The count says how many rows are in that
  // state so the number means something ("3 waiting", not "3 tabs exist").
  //
  // FIVE states, not three: the hand-rolled blocked/working test dropped `dead`
  // and `ready` on the floor, so a crashed runner or a finished-but-unread turn
  // behind the overflow was indistinguishable from an empty tab bar. Fold
  // through the shared rollup so precedence lives in exactly one place.
  const others = tabs.filter((t) => t.slug !== activeSlug);
  // `attention` is the raw BEL bit an older server sends without `status`.
  const statusOf = (t: Tab): PaneStatus => (t.attention ? 'blocked' : (t.status ?? 'idle'));
  const triggerStatus = rollupStatus(others.map(statusOf));
  const triggerCount = others.filter((t) => statusOf(t) === triggerStatus).length;
  const plural = (n: number) => (n === 1 ? 'tab is' : 'tabs are');
  const triggerTitle =
    triggerStatus === 'blocked'
      ? `${triggerCount} other ${plural(triggerCount)} waiting on you`
      : triggerStatus === 'working'
        ? `${triggerCount} other ${plural(triggerCount)} working`
        : triggerStatus === 'dead'
          ? `${triggerCount} other ${plural(triggerCount)} stopped`
          : triggerStatus === 'ready'
            ? `${triggerCount} other ${plural(triggerCount)} ready for you`
            : 'Switch tab';

  useDismissable(open, ref, () => setOpen(false));

  return (
    <div className="ws-tabbar-dropdown" ref={ref}>
      <button
        type="button"
        className="ws-tabbar-dropdown-trigger"
        onClick={() => setOpen((v) => !v)}
        title={triggerTitle}
      >
        <span className="ws-tabbar-dropdown-label">{active?.name ?? 'Tabs'}</span>
        {triggerStatus !== 'idle' && (
          <span className="ws-tabbar-dropdown-rollup" role="img" aria-label={triggerTitle}>
            <StatusMark status={triggerStatus} />
            {triggerCount > 1 && <span className="ws-tabbar-dropdown-count">{triggerCount}</span>}
          </span>
        )}
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
  // ASKED IN PLACE, not in a system dialog. Closing a tab kills its running
  // panes, so it still asks — but the question is the × itself going red and
  // saying so, which costs no modal, matches the sidebar's × exactly, and
  // works on the one surface where `window.confirm` silently does nothing (an
  // installed iOS PWA). Disarms on a timer and on leaving the row.
  const { armed, press, disarm } = useArmed();
  const onClose = async (e: React.MouseEvent | React.KeyboardEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (!press()) return;
    try {
      await api.deleteTab(tab.id);
      await refreshTabs(workspaceId);
    } catch (err) {
      console.error('deleteTab failed', err);
      noticeFromError(`Couldn't close "${tab.name}".`, err);
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
        {/* Same rail as the navigator, right down to the fixed column — the
            overflow list had no working signal at all before (D10). Rendered on
            the active row too: visiting a tab doesn't auto-clear pane-level
            state, so its own mark is a real signal. */}
        <StatusMark status={tab.status} />
      </span>
      {/* The close affordance is rendered as a sibling visual (a <span>
          with click) to avoid nested-button HTML. stopPropagation in
          onClose keeps the row's onClick from also firing. */}
      {/* biome-ignore lint/a11y/useSemanticElements: an <option> cannot hold an icon, a name and a state mark. */}
      <span
        role="button"
        tabIndex={0}
        className={`ws-tabbar-dropdown-item-close${armed ? ' -armed' : ''}`}
        onClick={(e) => void onClose(e)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') void onClose(e);
        }}
        onMouseLeave={disarm}
        onBlur={disarm}
        aria-pressed={armed}
        title={armed ? 'Click again — running panes will be killed' : 'Close tab'}
        aria-label={armed ? `Click again to close ${tab.name}` : `Close tab ${tab.name}`}
      >
        <SvgClose />
      </span>
    </button>
  );
}
