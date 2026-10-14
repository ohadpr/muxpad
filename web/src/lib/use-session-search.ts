import { useNavigate } from '@tanstack/react-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type ArchiveSearchHit, api } from '../api';
import { cachedAllTabs, loadAllTabs, subscribeAllTabs } from '../lib/all-tabs';
import { type MentionSearchState, NO_MENTION_SEARCH, hitsFor } from '../lib/chat-mention';
import { setLastPaneId } from '../lib/last-visited';
import {
  type SearchableTab,
  type TabMatch,
  type WorkspaceTabs,
  paneIndex,
  rankTabs,
  toSearchableTabs,
} from '../lib/nav-search';
import { requestSearchJump } from '../lib/search-jump';
import { cachedTabsFor } from '../tabs';
import { useWorkspaces, visibleWorkspaces } from '../workspaces';

/**
 * "Find any session, by its NAME or by what was SAID in it" — the engine, with
 * no opinion about where it is drawn.
 *
 * This was the sidebar box's private machinery (components/NavSearch). It
 * moved here the moment a SECOND surface needed it: the ⌘K palette, which is
 * the same question asked from a different place. Two copies of a two-tier
 * search would have been two sets of debounce, race and corpus-freshness bugs
 * to fix separately — and the subtle ones here (the superseded-ticket guard,
 * `hitsFor`, following the shared corpus rather than snapshotting it) are
 * exactly the kind that get fixed in one copy and not the other.
 *
 * TWO TIERS, and the split is the whole design:
 *
 *   1. INSTANT — local, zero network, recomputed on every keystroke. Tab name
 *      → headline → workspace name across every visible workspace
 *      (lib/nav-search.rankTabs). The common case ("get me to the Investing
 *      chat") lands on the same frame as the character: no debounce, no
 *      spinner, no layout jump.
 *   2. IN MESSAGES — what was actually said, from the archive's FTS5 index
 *      behind `GET /api/search`, debounced. Always strictly BELOW tier 1, and
 *      never allowed to reorder or delay it.
 *
 * The caller owns the query string and the rendering. This owns the corpus,
 * the request lifecycle, and the rule that a result never outlives the query
 * it answers.
 */

/** How many tab rows a result list shows before it stops being scannable. */
export const MAX_TAB_RESULTS = 12;
/** Message hits are a supplement, not a corpus browser — keep the tail short. */
export const MAX_MESSAGE_RESULTS = 6;
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

export interface MessageRow {
  hit: ArchiveSearchHit;
  tab: SearchableTab;
  paneId: string;
}

export interface SessionSearch {
  /** Tier 1, already ranked and capped. */
  tabMatches: TabMatch[];
  /** Tier 2, already de-duplicated by session and capped. */
  messageRows: MessageRow[];
  /** A request is in flight — only so an empty state can tell "nothing
   *  matched" from "not asked yet". */
  searching: boolean;
  /** Is the query non-empty, i.e. should results replace whatever is behind? */
  active: boolean;
  /** tabMatches + messageRows, for cursor clamping. */
  rowCount: number;
  /** Fetch the full tab corpus. Call on focus/open — the corpus is lazy. */
  loadCorpus: () => void;
}

export function useSessionSearch(query: string): SessionSearch {
  // ── The corpus ─────────────────────────────────────────────────────────
  // Seeded from whatever `/api/tabs/all` has already answered this session, so
  // reopening costs nothing. Until it has, the per-workspace caches stand in —
  // every workspace the user has expanded is already there, which means the
  // FIRST keystroke is never matched against an empty list even though nothing
  // has been fetched on this caller's account.
  const { workspaces: allWorkspaces } = useWorkspaces();
  const [remote, setRemote] = useState<WorkspaceTabs[] | null>(() => cachedAllTabs());
  // …and FOLLOWED, not snapshotted. This used to run only when a focus fetch
  // landed, so a chat deleted or renamed by another client while the box
  // stayed open kept being searched as it was — a dead destination still
  // selectable, a new name unfindable — although the shared corpus had already
  // patched it. `remote` outranks the workspace fallback, so nothing else
  // could repair it. Subscribing makes this one more reader of the one corpus;
  // it does not fetch, so the search stays lazy until opened.
  useEffect(() => subscribeAllTabs(setRemote), []);
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

  // STABLE, so a caller can list it as an effect dependency honestly. Recreated
  // per render it was a dependency nobody could declare without refetching the
  // whole corpus on every keystroke — which is the kind of thing that gets
  // "fixed" with a suppression comment instead.
  const loadCorpus = useCallback(() => {
    void loadAllTabs().then((groups) => {
      // An empty answer is a real answer (no workspaces), but it must not
      // REPLACE a usable fallback when it came from a failed request — see
      // loadAllTabs, which resolves to `cache ?? []` rather than rejecting.
      // A trailing refresh or push can publish before this promise callback.
      // Read the held corpus now, never roll it back to the request's answer.
      const current = cachedAllTabs();
      if (current) setRemote(current);
      else if (groups.length > 0) setRemote(groups);
    });
  }, []);

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
  // The hits AND the query they answer. The ticket below stops a late response
  // overwriting a newer one; it cannot stop hits already in state being shown —
  // and taken by Enter — under a query they have nothing to do with. Search
  // `alpha`, get a message-only hit, type `bravo`, press Enter before the new
  // answer lands: the alpha message opened with "bravo" handed to the jump.
  // Read through `hitsFor`, the rule the `@` picker already uses for the same
  // race, so a result never outlives the query it answers.
  const [found, setFound] = useState<MentionSearchState>(NO_MENTION_SEARCH);
  const hits = hitsFor(found, query);
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
      setFound(NO_MENTION_SEARCH);
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
          setFound({ query: q, limit: MESSAGE_FETCH_LIMIT, hits: res.hits });
        })
        .catch((err: unknown) => {
          if (mine !== ticket.current) return;
          if ((err as { status?: number } | null)?.status === 404) setMessagesAvailable(false);
          // Everything else (a 400 from an FTS5 expression the server could
          // not even fall back on, a dropped connection) is silent: the
          // instant tier above is the answer the user is actually reading.
          setFound(NO_MENTION_SEARCH);
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

  return {
    tabMatches,
    messageRows,
    searching,
    active: query.trim().length > 0,
    rowCount: tabMatches.length + messageRows.length,
    loadCorpus,
  };
}

/**
 * GOING THERE — the other half, and shared for the same reason as the engine.
 *
 * A message hit navigates differently from a name match: it has to select the
 * right PANE inside the tab and then ask the chat to scroll to the message, so
 * the hand-off is a persist (for a TabView that has not mounted yet), a live
 * event (for one that has), and a jump request. Getting one of those three
 * wrong lands you in the right chat at the wrong place, which is worse than
 * not navigating at all — so neither surface gets its own copy.
 */
export function useSearchResultOpener(): (
  tab: SearchableTab,
  opts?: { paneId?: string | undefined; hit?: ArchiveSearchHit | undefined; query?: string },
) => void {
  const navigate = useNavigate();
  return (tab, opts) => {
    const paneId = opts?.paneId;
    if (paneId) {
      // Same handoff the sheet's pane list uses: persist first (a not-yet-
      // mounted TabView reads it on mount), then tell a mounted one live.
      setLastPaneId(tab.tabId, paneId);
      window.dispatchEvent(
        new CustomEvent('muxpad:select-pane', { detail: { tabId: tab.tabId, paneId } }),
      );
      if (opts?.hit) {
        requestSearchJump({
          paneId,
          // The RAW query, not the trimmed-and-tokenised one: the chat splits
          // it into terms itself, and if it can't find the message it quotes
          // this back at the user, who should see what they typed.
          query: (opts.query ?? '').trim(),
          sid: opts.hit.sid,
          ts: opts.hit.ts,
        });
      }
    }
    void navigate({
      to: '/w/$wsSlug/t/$tabSlug',
      params: { wsSlug: tab.workspaceSlug, tabSlug: tab.tabSlug },
    });
  };
}
