import { fallbackTabIcon } from '@muxpad/shared';
import { useNavigate } from '@tanstack/react-router';
import { Fragment, type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react';
import { type ArchiveSearchHit, api } from '../api';
import { cachedAllTabs, loadAllTabs } from '../lib/all-tabs';
import { setLastPaneId } from '../lib/last-visited';
import type { NavTreeVariantName } from '../lib/nav-row-affordances';
import {
  type SearchableTab,
  type TabMatch,
  type WorkspaceTabs,
  paneIndex,
  rankTabs,
  snippetParts,
  splitHighlight,
  toSearchableTabs,
} from '../lib/nav-search';
import { cachedTabsFor } from '../tabs';
import { useWorkspaces, visibleWorkspaces } from '../workspaces';
import './NavSearch.css';

/**
 * The sidebar's search box — "find any session as I type and get me there".
 *
 * TWO TIERS IN ONE LIST, and the split is the whole design:
 *
 *   1. INSTANT — local, zero network, recomputed on every keystroke. Matches
 *      tab name → headline → workspace name across EVERY visible workspace
 *      (lib/nav-search.rankTabs). This is the common case ("get me to the
 *      Investing chat") and it must land on the same frame as the character:
 *      no debounce, no spinner, no layout jump.
 *   2. IN MESSAGES — what was actually SAID, from the archive's FTS5 index
 *      behind `GET /api/search`, debounced. Rendered under its own divider,
 *      strictly BELOW tier 1, and never allowed to reorder or delay it.
 *
 * Typing REPLACES the tree rather than filtering it in place: a tree that
 * loses and regains rows as you type reads as chaos, and the expansion state
 * the tree is restored to lives in localStorage (lib/nav-expansion), so
 * clearing the box brings back exactly what was open.
 *
 * Renders a fragment on purpose. `.navtree-scroll` is a flex child of
 * `.navtree` (`flex: 1; min-height: 0`), so wrapping it in a container of our
 * own would break the rail's scrolling; the box and the scroller stay
 * siblings, and this component only decides what goes INSIDE the scroller.
 */

/** How many tab rows a result list shows before it stops being scannable. */
const MAX_TAB_RESULTS = 12;
/** Message hits are a supplement, not a corpus browser — keep the tail short. */
const MAX_MESSAGE_RESULTS = 6;
/**
 * How many hits to ASK for, well above what we show.
 *
 * The archive indexes every transcript it can find, including sessions whose
 * pane is long gone — those cannot be navigated to and are dropped client-side
 * (see `messageRows`). Asking for exactly six therefore returns six rows that
 * may all be undisplayable: measured against a real archive, a common word
 * filled the whole top-20 with unresolvable sessions and the tier rendered
 * nothing at all. Over-fetching is one flat cost per query and buys the tier
 * its results back.
 */
const MESSAGE_FETCH_LIMIT = 50;
/** Long enough that the FTS5 index isn't asked to match half the alphabet. */
const MIN_MESSAGE_CHARS = 3;
/** Mirrors MAX_SEARCH_QUERY_BYTES on the server (1024) with room for
 *  multi-byte characters — past this the request can only earn a 400. */
const MAX_MESSAGE_QUERY_CHARS = 256;
const MESSAGE_DEBOUNCE_MS = 150;

interface MessageRow {
  hit: ArchiveSearchHit;
  tab: SearchableTab;
  paneId: string;
}

/** Would a keystroke here be someone typing, rather than a bare shortcut? */
function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName.toLowerCase();
  // xterm's hidden helper is a <textarea>, so a focused terminal is covered
  // by the same check that covers a rename input.
  return tag === 'input' || tag === 'textarea' || tag === 'select';
}

export function NavSearch({
  variant,
  onNavigate,
  children,
  box = true,
  onDismissBox,
}: {
  variant: NavTreeVariantName;
  /** Called right before any navigation — the mobile sheet uses it to dismiss. */
  onNavigate?: (() => void) | undefined;
  /** The tree, shown whenever the box is empty. */
  children: ReactNode;
  /**
   * Whether the FIELD is on screen. Always true on the desktop rail, where the
   * box is permanent chrome. The mobile sheet toggles it: search there is a
   * glyph in the one top bar, and the field takes that bar's place when you
   * tap it — so the resting rail is a bar and a column of chats, and never two
   * rows of chrome deep.
   */
  box?: boolean;
  /** Sheet only: the field asked to be put away (Escape on an empty query, or
   *  the back button). The caller owns `box`, so it does the dismissing. */
  onDismissBox?: (() => void) | undefined;
}) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  // ── The corpus ─────────────────────────────────────────────────────────
  // Seeded from whatever `/api/tabs/all` has already answered this session, so
  // reopening the box costs nothing. Until it has, the per-workspace caches
  // stand in — every workspace the user has expanded is already there, which
  // means the FIRST keystroke is never matched against an empty list even
  // though nothing has been fetched on this component's account.
  const { workspaces: allWorkspaces } = useWorkspaces();
  const [remote, setRemote] = useState<WorkspaceTabs[] | null>(() => cachedAllTabs());
  const corpus = useMemo<SearchableTab[]>(() => {
    const groups: WorkspaceTabs[] =
      remote ??
      visibleWorkspaces(allWorkspaces).map((w) => ({
        id: w.id,
        slug: w.slug,
        name: w.name,
        tabs: cachedTabsFor(w.id),
      }));
    return toSearchableTabs(groups);
  }, [remote, allWorkspaces]);

  const loadCorpus = () => {
    void loadAllTabs().then((groups) => {
      // An empty answer is a real answer (no workspaces), but it must not
      // REPLACE a usable fallback when it came from a failed request — see
      // loadAllTabs, which resolves to `cache ?? []` rather than rejecting.
      if (groups.length > 0 || cachedAllTabs()) setRemote(groups);
    });
  };

  // ── Tier 1 ─────────────────────────────────────────────────────────────
  const tabMatches = useMemo(
    () => rankTabs(corpus, query, { limit: MAX_TAB_RESULTS }),
    [corpus, query],
  );

  // ── Tier 2 ─────────────────────────────────────────────────────────────
  // `available` latches false on the first 404: /api/search is mounted only
  // when the archive exists, so its absence is a supported configuration and
  // must cost exactly one request to discover, not one per keystroke.
  const [messagesAvailable, setMessagesAvailable] = useState(true);
  const [hits, setHits] = useState<ArchiveSearchHit[]>([]);
  // Only so the empty state can tell "nothing matched" from "not asked yet".
  // Without it a query that only exists in MESSAGES shows a flat "no matches"
  // for the debounce plus a round trip, and then contradicts itself.
  const [searching, setSearching] = useState(false);
  // Bumped by every keystroke. A response whose ticket has been superseded is
  // discarded — otherwise a slow answer for "inv" lands after a fast one for
  // "investing" and the list silently describes the wrong query.
  const ticket = useRef(0);
  useEffect(() => {
    const q = query.trim();
    ticket.current += 1;
    // The server rejects an oversize `q` with a 400 (FTS5 MATCH is synchronous
    // on its main thread), so don't spend the round trip to be told.
    const askable =
      messagesAvailable && q.length >= MIN_MESSAGE_CHARS && q.length <= MAX_MESSAGE_QUERY_CHARS;
    if (!askable) {
      setHits([]);
      setSearching(false);
      return;
    }
    const mine = ticket.current;
    setSearching(true);
    const timer = window.setTimeout(() => {
      api
        .searchMessages(q, MESSAGE_FETCH_LIMIT)
        .then((res) => {
          if (mine !== ticket.current) return;
          setHits(res.hits);
        })
        .catch((err: unknown) => {
          if (mine !== ticket.current) return;
          if ((err as { status?: number } | null)?.status === 404) setMessagesAvailable(false);
          // Everything else (a 400 from an FTS5 expression the server could
          // not even fall back on, a dropped connection) is silent: the
          // instant tier above is the answer the user is actually reading.
          setHits([]);
        })
        .finally(() => {
          if (mine === ticket.current) setSearching(false);
        });
    }, MESSAGE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query, messagesAvailable]);

  const panes = useMemo(() => paneIndex(corpus), [corpus]);
  const messageRows = useMemo<MessageRow[]>(() => {
    const out: MessageRow[] = [];
    const seenSid = new Set<string>();
    for (const hit of hits) {
      const paneId = hit.session?.pane_id;
      if (!paneId) continue;
      const tab = panes.get(paneId);
      // A hit whose pane is gone (closed chat, archived session) has nowhere
      // to navigate. Drop it rather than offer a row that does nothing.
      if (!tab) continue;
      // One row per SESSION: ten hits inside the same long chat is one place
      // to go, and ten identical rows is not a result list.
      if (seenSid.has(hit.sid)) continue;
      seenSid.add(hit.sid);
      out.push({ hit, tab, paneId });
      if (out.length >= MAX_MESSAGE_RESULTS) break;
    }
    return out;
  }, [hits, panes]);

  const active = query.trim().length > 0;
  const rowCount = tabMatches.length + messageRows.length;
  // Clamp rather than reset: the list shrinks under the cursor whenever a
  // keystroke narrows it, and an out-of-range cursor makes Enter a no-op.
  const safeCursor = rowCount === 0 ? 0 : Math.min(cursor, rowCount - 1);

  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed to the cursor MOVING, not to the row list identity — re-running on every keystroke would fight the natural scroll position.
  useEffect(() => {
    listRef.current?.querySelector('[data-cursor="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [safeCursor]);

  const focusBox = () => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  };

  // `/` and ⌘K (Ctrl+K off macOS) from anywhere. Sidebar only: the sheet is a
  // touch surface, and registering the same handler from both variants would
  // double-handle the key on the one layout that can mount both.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `focusBox` only touches a ref — listing it would re-register the window listener on every render for no behavioural difference.
  useEffect(() => {
    if (variant !== 'sidebar') return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        focusBox();
        return;
      }
      // A bare `/` is a character in every text field on the page — including
      // the terminal's helper textarea — so it only becomes a shortcut when
      // nothing is being typed into.
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      e.preventDefault();
      focusBox();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [variant]);

  // A field that has been put away must not keep filtering the list behind it.
  // The query is state in here, so the collapse has to reach in and reset it —
  // otherwise reopening the box would show yesterday's results, and (worse) a
  // collapsed box would leave the scroller showing a result list with no
  // visible field explaining why.
  //
  // Seeded from `box` rather than from `false`, which is the whole subtlety:
  // this effect must focus the field when it is REVEALED and never on mount.
  // The desktop rail's box is permanent chrome (`box` is true from the first
  // render), and a plain `if (box) focus()` here put the caret in the search
  // field — accent ring and all — every time the app loaded. Measured: it was
  // the ONLY pixel that moved on the desktop rail in this whole pass.
  const wasOpen = useRef(box);
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed to the box OPENING/CLOSING; `query` is what this resets, so depending on it would clear the field on every keystroke.
  useEffect(() => {
    if (box) {
      if (!wasOpen.current) inputRef.current?.focus();
      wasOpen.current = true;
      return;
    }
    wasOpen.current = false;
    if (query) {
      setQuery('');
      setCursor(0);
      setHits([]);
    }
  }, [box]);

  const clear = () => {
    setQuery('');
    setCursor(0);
    setHits([]);
  };

  const openTab = (tab: SearchableTab, paneId?: string) => {
    if (paneId) {
      // Same handoff the sheet's pane list uses: persist first (a not-yet-
      // mounted TabView reads it on mount), then tell a mounted one live.
      setLastPaneId(tab.tabId, paneId);
      window.dispatchEvent(
        new CustomEvent('muxpad:select-pane', { detail: { tabId: tab.tabId, paneId } }),
      );
    }
    clear();
    inputRef.current?.blur();
    onNavigate?.();
    void navigate({
      to: '/w/$wsSlug/t/$tabSlug',
      params: { wsSlug: tab.workspaceSlug, tabSlug: tab.tabSlug },
    });
  };

  const openRow = (i: number) => {
    const tabRow = tabMatches[i];
    if (tabRow) {
      openTab(tabRow.tab);
      return;
    }
    const msgRow = messageRows[i - tabMatches.length];
    if (msgRow) openTab(msgRow.tab, msgRow.paneId);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // Mid-composition an IME owns Enter and the arrows (choosing a candidate),
    // and stealing them there makes the box unusable in Japanese/Chinese input.
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (rowCount > 0) setCursor((c) => (Math.min(c, rowCount - 1) + 1) % rowCount);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (rowCount > 0) setCursor((c) => (Math.min(c, rowCount - 1) + rowCount - 1) % rowCount);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (rowCount > 0) openRow(safeCursor);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      // Clear first, blur second — one Esc to abandon the query, another to
      // give the keyboard back to whatever you were doing. On a collapsible
      // box the second Esc also puts the field away, since there is nowhere
      // else for focus to sensibly go on a sheet.
      if (query) clear();
      else {
        inputRef.current?.blur();
        onDismissBox?.();
      }
    }
  };

  return (
    <>
      {box ? (
        <div className="navsearch" data-variant={variant}>
          <SvgSearch />
          <input
            ref={inputRef}
            className="navsearch-input"
            // NOT type="search": WebKit's native clear affordance and its own
            // Escape handling both sit on top of the keyboard contract above.
            type="text"
            inputMode="search"
            enterKeyHint="go"
            placeholder="Search chats"
            aria-label="Search chats"
            role="combobox"
            aria-expanded={active}
            aria-autocomplete="list"
            // `aria-controls` is required of the role and so is stated
            // unconditionally, even though the listbox only exists while there is
            // a query — `aria-expanded={false}` is what tells the reader so.
            // The ACTIVE DESCENDANT is not: pointing it at a row id that is not
            // in the document is a reader announcing nothing at all.
            aria-controls={listId}
            {...(active && rowCount > 0
              ? { 'aria-activedescendant': `${listId}-${safeCursor}` }
              : {})}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            value={query}
            onFocus={loadCorpus}
            onChange={(e) => {
              setQuery(e.target.value);
              setCursor(0);
            }}
            onKeyDown={onKeyDown}
          />
          {query ? (
            <button
              type="button"
              className="navsearch-clear"
              aria-label="Clear search"
              onClick={() => {
                clear();
                focusBox();
              }}
            >
              ×
            </button>
          ) : null}
          {/* Only on a collapsible box: the way back out. The desktop rail's box
            is permanent chrome and has nothing to dismiss to. */}
          {onDismissBox ? (
            <button
              type="button"
              className="navsearch-done"
              onClick={() => {
                clear();
                onDismissBox();
              }}
            >
              Done
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="navtree-scroll">
        {active ? (
          // The combobox pattern: the INPUT keeps focus and points at the
          // active row through aria-activedescendant, so the list and its
          // options are deliberately not tab stops (tabIndex -1 makes that
          // explicit rather than merely true).
          <div
            className="navsearch-results"
            id={listId}
            ref={listRef}
            // biome-ignore lint/a11y/useSemanticElements: a <select> cannot host two labelled tiers, a highlighted substring, or a snippet.
            role="listbox"
            tabIndex={-1}
            aria-label="Search results"
          >
            {rowCount === 0 ? (
              <div className="navsearch-empty">
                {searching ? 'Searching messages…' : 'No matches'}
              </div>
            ) : null}
            {tabMatches.map((m, i) => (
              <TabResult
                key={m.tab.tabId}
                match={m}
                id={`${listId}-${i}`}
                selected={i === safeCursor}
                onHover={() => setCursor(i)}
                onPick={() => openTab(m.tab)}
              />
            ))}
            {messageRows.length > 0 ? (
              <div className="navsearch-divider" aria-hidden="true">
                In messages
              </div>
            ) : null}
            {messageRows.map((row, i) => {
              const idx = tabMatches.length + i;
              return (
                <MessageResult
                  key={`${row.hit.sid}:${row.hit.ts}`}
                  row={row}
                  id={`${listId}-${idx}`}
                  selected={idx === safeCursor}
                  onHover={() => setCursor(idx)}
                  onPick={() => openTab(row.tab, row.paneId)}
                />
              );
            })}
          </div>
        ) : (
          children
        )}
      </div>
    </>
  );
}

/** The matched run, bolded in place. `splitHighlight` degrades to plain text
 *  when the range no longer fits the string (a poll renamed the tab between
 *  the ranking and this render), so this can never slice mid-word garbage. */
function Highlight({
  text,
  range,
}: { text: string; range?: readonly [number, number] | undefined }) {
  const [before, hit, after] = splitHighlight(text, range);
  if (!hit) return <>{text}</>;
  return (
    <>
      {before}
      <mark className="navsearch-hit">{hit}</mark>
      {after}
    </>
  );
}

function TabResult({
  match,
  id,
  selected,
  onHover,
  onPick,
}: {
  match: TabMatch;
  id: string;
  selected: boolean;
  onHover: () => void;
  onPick: () => void;
}) {
  const { tab, field, range } = match;
  // Second line: where it lives, then what it is about. The headline is the
  // same one-liner the tree's rows carry, so a result and its row read alike.
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the keyboard path is the combobox above (aria-activedescendant); these rows are never tab stops.
    <div
      className="navsearch-row"
      id={id}
      // biome-ignore lint/a11y/useSemanticElements: an <option> cannot hold two lines, an icon and a highlighted run.
      role="option"
      tabIndex={-1}
      aria-selected={selected}
      data-cursor={selected ? 'true' : undefined}
      onMouseMove={onHover}
      onClick={onPick}
    >
      <span className="navsearch-row-icon" aria-hidden="true">
        {tab.icon ?? fallbackTabIcon(tab.tabId)}
      </span>
      <span className="navsearch-row-text">
        <span className="navsearch-row-title" dir="auto">
          <Highlight text={tab.tabName} range={field === 'name' ? range : undefined} />
        </span>
        <span className="navsearch-row-sub" dir="auto">
          <span className="navsearch-row-ws">
            <Highlight text={tab.workspaceName} range={field === 'workspace' ? range : undefined} />
          </span>
          {tab.headline ? (
            <>
              <span className="navsearch-row-dot" aria-hidden="true">
                ·
              </span>
              <Highlight text={tab.headline} range={field === 'headline' ? range : undefined} />
            </>
          ) : null}
        </span>
      </span>
      {/* Status as a bare dot, not a StateChip: the chip carries
          visually-hidden words, and inside an `option` those join the row's
          ACCESSIBLE NAME — the exact mistake NavTree's pane rows made once.
          A dot says "this one is blocked" to the eye and nothing to the
          screen reader, which is the right split for a transient list. */}
      {tab.status && tab.status !== 'idle' ? (
        <span className="navsearch-row-state" data-state={tab.status} aria-hidden="true" />
      ) : null}
    </div>
  );
}

function MessageResult({
  row,
  id,
  selected,
  onHover,
  onPick,
}: {
  row: MessageRow;
  id: string;
  selected: boolean;
  onHover: () => void;
  onPick: () => void;
}) {
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: same combobox keyboard path as the tab rows above.
    <div
      className="navsearch-row navsearch-row-message"
      id={id}
      // biome-ignore lint/a11y/useSemanticElements: same two-line row shape as TabResult.
      role="option"
      tabIndex={-1}
      aria-selected={selected}
      data-cursor={selected ? 'true' : undefined}
      onMouseMove={onHover}
      onClick={onPick}
    >
      <span className="navsearch-row-icon" aria-hidden="true">
        {row.tab.icon ?? fallbackTabIcon(row.tab.tabId)}
      </span>
      <span className="navsearch-row-text">
        {/* The SNIPPET leads, because it is the thing you recognised; the chat
            it came from is the answer to "where", and goes underneath. FTS5
            already marked the matched terms in it (see snippetParts). */}
        <span className="navsearch-row-snippet" dir="auto">
          {snippetParts(row.hit.snippet).map((part, i) =>
            part.hit ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: the parts have no identity of their own and the whole row is rebuilt per response.
              <mark className="navsearch-hit" key={i}>
                {part.text}
              </mark>
            ) : (
              // biome-ignore lint/suspicious/noArrayIndexKey: see above.
              <Fragment key={i}>{part.text}</Fragment>
            ),
          )}
        </span>
        <span className="navsearch-row-sub" dir="auto">
          {row.tab.tabName}
        </span>
      </span>
    </div>
  );
}

/** Magnifier, same 1.8px lucide-ish geometry as the rest of the nav's glyphs. */
function SvgSearch() {
  return (
    <svg
      className="navsearch-glyph"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
    </svg>
  );
}
