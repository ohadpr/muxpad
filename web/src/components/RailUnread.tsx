import { useEffect, useRef } from 'react';
import { unreadCount, unreadFilterActive } from '../lib/chat-sections';
import { setRailUnreadFilter, useRailUnreadFilter } from '../lib/rail-filter';
import { useChatCorpus } from '../lib/use-all-chats';
import './RailUnread.css';

/**
 * THE RAIL'S UNREAD CHIP — how many chats have something unread, and the
 * switch that filters the rail down to them (NavTree SidebarTree honours it).
 *
 * In the brand row's right-hand slot, the one that was an empty spacer
 * balancing the search button on the left — so it costs the rail no row, and
 * the wordmark stays centred.
 *
 * READS AS OFF WHEN THERE ARE NONE: no number, nothing to press. And when the
 * last unread chat is read with the filter on, the filter switches itself off
 * rather than leaving the rail showing nothing — the next unread chat to
 * arrive must not silently collapse the rail again.
 */
export function RailUnreadChip() {
  const count = unreadCount(useChatCorpus());
  const wanted = useRailUnreadFilter();
  const on = unreadFilterActive(wanted, count);
  // Off on the TRANSITION to zero, not on a zero seen at mount: on a cold load
  // the corpus has not arrived yet, and a zero there is "don't know", not
  // "all read".
  const prev = useRef(count);
  useEffect(() => {
    if (wanted && prev.current > 0 && count === 0) setRailUnreadFilter(false);
    prev.current = count;
  }, [wanted, count]);

  const label =
    count === 0
      ? 'Nothing unread'
      : on
        ? `Showing ${count} unread — show all chats`
        : `${count} unread — show only those`;
  return (
    <button
      type="button"
      className="sidenav-brand-spacer rail-unread"
      data-on={on ? 'true' : undefined}
      aria-pressed={on}
      aria-label={label}
      title={label}
      disabled={count === 0}
      onClick={() => setRailUnreadFilter(!on)}
    >
      {count > 0 && <span className="rail-unread-count">{count > 99 ? '99+' : count}</span>}
    </button>
  );
}
