import { Link } from '@tanstack/react-router';
import { type ReactNode, useEffect, useState } from 'react';
import { type TabPreview, api } from '../api';
import { shortAgo } from '../lib/chat-sections';
import type { SearchableTab } from '../lib/nav-search';
import { StatusMark } from './StatusMark';
// The row's styles live with the phone list that introduced them; the desktop
// Activity page re-scales them under its own root (ActivityView.css) rather
// than keeping a second copy of every rule.
import './MobileNav.css';

/**
 * A LIST OF CHATS, each with THE LAST MESSAGE IT HAD — the line Slack's DM
 * list puts under every name. Two hosts: the phone's Unread and Activity tabs
 * (MobileNav), and the desktop Activity destination (pages/ActivityView).
 *
 * Previews come from `GET /api/tabs/previews` (server chat/last-message),
 * fetched for these rows only, only while the list is showing, and again only
 * when one of them moves (the key is ids + last activity).
 */
/**
 * How long the rows must stop moving before their previews are asked for. A
 * burst of pushes (a fan-out reporting, an agent streaming) is one request.
 */
const PREVIEW_SETTLE_MS = 250;

/**
 * HOW MANY ROWS THE FIRST PAINT CARRIES — a screenful, then the rest.
 *
 * "Clicking activity in unread can take multiple seconds… it still takes
 * between 500 and 900 ms." Measured at 10× CPU throttling, a switch into a
 * 17-row Activity list costs 124–168 ms HERE, and the mechanism barely
 * matters: revealing the section with `visibility` instead of `display` saved
 * a quarter of it. What costs is laying out and painting every row, and a
 * 390×844 screen shows ten of them (measured: rows are 85–87 px tall).
 *
 * So the first paint gets a screenful and the remainder arrives on the next
 * idle callback. Nothing is hidden from the reader — the rows below the fold
 * are, by definition, below the fold — and scrolling to them is a frame away.
 * This is NOT windowing: every row is in the DOM a moment later, so find-in-
 * page, the scroll height and the screen reader see the whole list.
 */
const FIRST_PAINT_ROWS = 10;

/**
 * EVERY PREVIEW THIS TAB HAS LEARNED, and the activity it learned it at.
 *
 * Module-level, not component state, because the lists showing these rows are
 * SIBLINGS that unmount each other: the phone's Unread and Activity are two
 * PreviewLists, and so are the desktop rail's. Held per component, every
 * switch threw the text away, re-fetched it, and re-flowed every row when it
 * came back — "when clicking icons and switching views on desktop the lists
 * load and then like 200-500ms later they add text descriptions which make
 * each chat taller". Shared, the second view already has the words.
 */
const PREVIEWS = new Map<string, TabPreview | null>();
const FETCHED_AT = new Map<string, number>();

/** Test seam — forget every held preview. */
export function resetPreviewCache(): void {
  PREVIEWS.clear();
  FETCHED_AT.clear();
}

export function PreviewList({
  rows,
  active,
  empty,
  explainAbsent = false,
  activeTabId = null,
}: {
  rows: SearchableTab[];
  active: boolean;
  empty: ReactNode;
  /**
   * Say WHY a row has no preview when the reason is by design — a chat on
   * another machine, whose transcript this server cannot read. Off, such a row
   * falls back to the chat's headline like any other row without one.
   */
  explainAbsent?: boolean;
  /** The chat you are on, marked as the rail marks it (the desktop rail). */
  activeTabId?: string | null;
}) {
  // The cache is module-level (see PREVIEWS); this is only how a landing
  // reaches the screen.
  const [, landed] = useState(0);
  /** Rows this render may paint. Reset on every activation — each switch pays
   *  for a screenful, not for the whole list. */
  const [budget, setBudget] = useState(FIRST_PAINT_ROWS);
  useEffect(() => {
    if (!active) {
      setBudget(FIRST_PAINT_ROWS);
      return;
    }
    if (rows.length <= FIRST_PAINT_ROWS) return;
    // After the paint the reader is waiting for, not during it.
    const idle = (window.requestIdleCallback ?? ((fn: () => void) => window.setTimeout(fn, 32)))(
      () => setBudget(Number.POSITIVE_INFINITY),
    );
    return () => {
      (window.cancelIdleCallback ?? window.clearTimeout)(idle as number);
    };
  }, [active, rows.length]);
  const key = rows.map((r) => `${r.tabId}:${r.lastActivityAt ?? ''}`).join(',');
  // ─── ASK FOR WHAT MOVED, NOT FOR EVERYTHING, AND NOT ON EVERY EDGE ───────
  //
  // This re-fetched EVERY row's preview whenever ANY row's activity changed,
  // because the key carries all of them. Activity is the whole corpus by
  // recency, so on a phone watching a working agent that is one request for
  // ~18 chats every time a single one of them says anything — the rows are
  // already on screen and only one of them has new words.
  //
  // Now: only the rows whose activity has moved since their held preview (or
  // that have none), and after a short quiet period, so a burst of pushes
  // costs one request rather than one each. A row still renders immediately
  // with its headline; this only decides when the second line arrives.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on `key` — the ids and their activity — not on the array's identity, which changes every corpus publish.
  useEffect(() => {
    if (!active || rows.length === 0) return;
    const stale = rows.filter((r) => FETCHED_AT.get(r.tabId) !== (r.lastActivityAt ?? 0));
    if (stale.length === 0) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      api
        .tabPreviews(stale.map((r) => r.tabId))
        .then((res) => {
          if (cancelled) return;
          for (const r of stale) FETCHED_AT.set(r.tabId, r.lastActivityAt ?? 0);
          for (const [id, p] of Object.entries(res.previews)) PREVIEWS.set(id, p);
          landed((n) => n + 1);
        })
        // An older server has no such route: the rows keep their headline.
        .catch(() => {});
    }, PREVIEW_SETTLE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [key, active]);
  return (
    <div className="mcl-scroll">
      {rows.length === 0
        ? empty
        : rows
            .slice(0, budget)
            .map((t) => (
              <ChatRow
                key={t.tabId}
                tab={t}
                preview={PREVIEWS.get(t.tabId) ?? null}
                explainAbsent={explainAbsent}
                active={t.tabId === activeTabId}
              />
            ))}
    </div>
  );
}

/**
 * The second line a row shows, and how. Pure, so what an absent preview reads
 * as is decided in one place.
 *
 *   message      the last message — "You: …" when it was yours, as Slack writes
 *   elsewhere    the chat runs on another machine: said plainly, as a fact
 *   fallback     the chat's headline (its topic), until/unless a preview lands
 *   none         nothing at all
 */
export function previewLine(
  preview: TabPreview | null,
  headline: string | undefined,
  explainAbsent: boolean,
): { kind: 'message' | 'elsewhere' | 'fallback' | 'none'; text: string } {
  if (preview && 'text' in preview) {
    return { kind: 'message', text: preview.by === 'user' ? `You: ${preview.text}` : preview.text };
  }
  if (preview && explainAbsent) {
    return { kind: 'elsewhere', text: 'Runs on another machine — no preview here' };
  }
  if (headline) return { kind: 'fallback', text: headline };
  return { kind: 'none', text: '' };
}

/**
 * One chat: emoji, name, workspace and time on the first line; the second line
 * from {@link previewLine}.
 */
export function ChatRow({
  tab,
  preview,
  explainAbsent = false,
  active = false,
}: {
  tab: SearchableTab;
  preview: TabPreview | null;
  explainAbsent?: boolean;
  active?: boolean;
}) {
  const now = Date.now();
  const second = previewLine(preview, tab.headline, explainAbsent);
  const status = tab.status ?? 'idle';
  return (
    <Link
      to="/w/$wsSlug/t/$tabSlug"
      params={{ wsSlug: tab.workspaceSlug, tabSlug: tab.tabSlug }}
      className="mcl-row"
      data-unread={tab.unread ? 'true' : undefined}
      data-active={active ? 'true' : undefined}
    >
      <span className="mcl-row-emoji" aria-hidden="true">
        {tab.icon || '💬'}
      </span>
      <span className="mcl-row-main">
        <span className="mcl-row-top">
          <span className="mcl-row-name" dir="auto">
            {tab.tabName}
          </span>
          {(status === 'working' || status === 'blocked') && (
            <span className="mcl-row-status">
              <StatusMark status={status} />
            </span>
          )}
          <span className="mcl-row-meta">
            {tab.workspaceName} · {shortAgo(tab.lastActivityAt, now)}
          </span>
        </span>
        {second.kind !== 'none' && (
          <span
            className="mcl-row-preview"
            dir="auto"
            data-fallback={second.kind === 'fallback' ? 'true' : undefined}
            data-elsewhere={second.kind === 'elsewhere' ? 'true' : undefined}
          >
            {second.kind === 'elsewhere' && <SvgElsewhere />}
            {second.text}
          </span>
        )}
      </span>
    </Link>
  );
}

/** A small monitor — "over there", not "broken". */
function SvgElsewhere() {
  return (
    <svg
      className="mcl-row-elsewhere-icon"
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8M12 16v4" />
    </svg>
  );
}
