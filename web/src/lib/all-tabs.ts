import { CHAT_DECAY_DAYS, type Tab } from '@muxpad/shared';
import { api } from '../api';
import { subscribe, subscribeResync } from '../events';
import type { WorkspaceTabs } from './nav-search';

/**
 * The cross-workspace tab corpus behind the sidebar search box and the `@`
 * picker.
 *
 * LAZY BY CONSTRUCTION. Nothing here runs until the box is focused for the
 * first time — the user has complained about mobile load time, and a corpus
 * fetch on mount would put a request the first paint doesn't need in front of
 * the one it does. Until then the box falls back to whatever the per-workspace
 * caches already hold (see NavSearch), so the FIRST keystroke is never empty
 * even though nothing has been fetched for it.
 *
 * There is no poll. A search session is seconds long; the corpus is refreshed
 * on focus when it has gone stale and otherwise left alone, which keeps the
 * cost of the feature at "one request per time you go looking for something".
 *
 * ─── …but it is LIVE, because it outlived the search session ─────────────────
 * That reasoning was written for a search box: open it, type, choose, done. The
 * `@` picker put the same corpus behind things that stay on screen for hours —
 * the chip inside a sent message, and the card for work directed to another
 * chat. Those resolve a chat every render and had no way to hear that it had
 * been renamed, archived, retired or revived: a `ChatPane` took its own snapshot
 * on first use and nothing ever refreshed it. The sidebar moved; the chip in the
 * conversation next to it did not.
 *
 * So the cache follows the same server pushes the tab cache does (`tab.updated`
 * / `.added` / `.removed`) and notifies its readers. Same trade as `tabs.ts`
 * `applyTabRow`: the event already carries the whole decorated row, so a patch
 * is a round trip saved and cannot drift from what the sidebar is showing —
 * because it IS what the sidebar is showing. No poll was added; there is still
 * exactly one request per time you go looking for something.
 *
 * ─── …and the two things a push CANNOT carry ────────────────────────────────
 * Both were observed on the live cockpit, and neither is a bug in the patching
 * above — they are the edges where no `tab.updated` exists to patch WITH.
 *
 * 1. `status` MOVES WITHOUT A `tab.updated`. A pane going working → idle emits
 *    `pane.updated` and nothing else (server/src/index.ts `cache.on('paneChange')`
 *    is the only emitter on that edge). The tab row's rolled-up `status` is what
 *    `childIsRunning` reads, so a corpus that listens only for `tab.updated`
 *    freezes that field at whatever the last fetch said — FOREVER, on a socket
 *    that never dropped. `tabs.ts` never had this problem because it answers a
 *    status-signature change by refetching the workspace; this module had no
 *    such path, which is why finished agents went on spinning as cards while
 *    the sidebar rows beside them had already moved to the done drawer.
 *
 * 2. A MISSED PUSH WAS PERMANENT. Events are not replayed across a reconnect
 *    (see events.ts), and with no poll and no resync there was nothing left to
 *    heal a gap. A phone whose socket died held its last snapshot until reload:
 *    two finished agents spinning, "2 agents" in the status bar, indefinitely.
 *
 * The answer to both is the same one, and it is NOT a poll:
 *
 *   · `mergeWorkspaceTabs` lets the per-workspace cache hand this one its
 *     freshly-landed list (`tabs.ts` `publishTabs`). That cache already refetches
 *     on a status edge, on its 5s visible poll and on reconnect, so the corpus
 *     inherits all three for every workspace the sidebar has loaded — at the
 *     cost of ZERO extra requests, because it is re-using an answer that was
 *     fetched anyway. This is what makes the cards and the rows agree: they are
 *     now literally the same bytes.
 *   · `subscribeResync` refetches the corpus on reconnect and on
 *     document-visible, which is the backstop for the workspaces the sidebar has
 *     NOT loaded — and only when a corpus is already held.
 *
 * THE LAZINESS IS INTACT. Nothing here fetches for a workspace nobody has asked
 * about: with `cache === null` the merge is a no-op and the resync declines to
 * fetch. The rule the header opens with — "one request per time you go looking
 * for something" — still holds; what changed is that the answer stays true
 * afterwards.
 */

let cache: WorkspaceTabs[] | null = null;
let settledAt = 0;
let inFlight: Promise<WorkspaceTabs[]> | null = null;
/**
 * Bumped by everything that knows something NEWER than a request already in
 * flight: a push, a merged workspace list, a status edge. (A resync has its own
 * queue below and needs none of this.)
 *
 * ─── AN OLDER ANSWER MUST NOT OVERWRITE A NEWER ONE ──────────────────────────
 * `/tabs/all` issued before a push can land after it, carrying the pre-push row.
 * `loadAllTabs` used to publish it regardless and call the corpus fresh — the
 * renamed chat got its old name back, a retired one went back to `working`, on
 * every chip and card, and nothing healed it (no poll; and a status-edge fetch
 * fired meanwhile simply JOINED the stale request). The per-workspace cache in
 * `tabs.ts` guards its fetches with versions for exactly this; the corpus had no
 * equivalent. So a request remembers the generation it was issued at, and a
 * landing that finds it moved is not published — the next fetch is, instead.
 */
let generation = 0;
const listeners = new Set<(groups: WorkspaceTabs[]) => void>();

function publish(next: WorkspaceTabs[]): void {
  cache = next;
  for (const fn of listeners) fn(next);
}

/**
 * Hear about the corpus changing — a fetch landing, or a server push.
 *
 * Returns the unsubscribe, and does NOT fetch: a caller that wants a corpus asks
 * for one with `loadAllTabs`. Subscribing is how you stop holding a stale copy,
 * not how you get a first one.
 */
export function subscribeAllTabs(fn: (groups: WorkspaceTabs[]) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * Splice a server-pushed row into the corpus, if we are holding one.
 *
 * Nothing is FETCHED here, by design: the corpus is lazy, and a `tab.updated`
 * for a workspace nobody has asked about must not turn into a request. A row we
 * do not hold is simply not our business yet — the next `loadAllTabs` gets it.
 */
const unsubscribeLive = subscribe((e) => {
  if (!cache) {
    // Nothing to patch — but a FIRST fetch may be travelling, and it was asked
    // before this event happened. Mark it superseded so its answer is not
    // served as current (see `generation`). Still no fetch of our own.
    if (
      inFlight &&
      (e.type === 'tab.updated' || e.type === 'tab.added' || e.type === 'tab.removed')
    )
      generation++;
    return;
  }
  if (e.type === 'tab.updated') {
    let hit = false;
    const next = cache.map((g) => {
      const i = g.tabs.findIndex((t) => t.id === e.tab.id);
      if (i < 0) return g;
      hit = true;
      const tabs = [...g.tabs];
      tabs[i] = e.tab;
      return { ...g, tabs };
    });
    // Order is NOT touched. This corpus is ranked per query (rankMentions /
    // rankTabs) rather than displayed in its stored order, so re-sorting it
    // would be work with no reader — and `sortSidebarTabs` is the sidebar's
    // business, applied to the sidebar's own cache.
    if (hit) {
      generation++;
      publish(next);
    }
    return;
  }
  if (e.type === 'tab.added') {
    const has = cache.some((g) => g.tabs.some((t) => t.id === e.tab.id));
    if (has) return;
    let hit = false;
    const next = cache.map((g) => {
      if (g.id !== e.workspace_id) return g;
      hit = true;
      return { ...g, tabs: [...g.tabs, e.tab] };
    });
    // A workspace we are not holding: leave it to the next fetch rather than
    // inventing a group out of an id and no name. But STOP CALLING THE CORPUS
    // FRESH — we have just been told, by the server, about a chat that is not
    // in it, so the next `loadAllTabs` must actually ask instead of being
    // short-circuited by FRESH_MS. This costs no request of its own; it only
    // declines to serve a known-incomplete answer as a current one. (Reachable
    // whenever a workspace is created after the corpus was fetched.)
    generation++;
    if (hit) publish(next);
    else settledAt = 0;
    return;
  }
  if (e.type === 'tab.removed') {
    let hit = false;
    const next = cache.map((g) => {
      if (!g.tabs.some((t) => t.id === e.tab_id)) return g;
      hit = true;
      return { ...g, tabs: g.tabs.filter((t) => t.id !== e.tab_id) };
    });
    if (hit) {
      generation++;
      publish(next);
    }
  }
});

/**
 * A workspace's rows, reduced to what its readers can actually SEE change.
 *
 * ─── `clock.fill` IS NOT A VALUE, IT IS A STOPWATCH ──────────────────────────
 * Measured on the live cockpit: two reads of the same workspace six seconds
 * apart, with nothing happening, differed on 31 of 72 rows — every one of them
 * by `clock.fill` alone and by nothing else. The server derives it from
 * wall-clock time at serialization (`clockSnapshot`), so it is a different float
 * on every single read, forever.
 *
 * A raw `JSON.stringify` compare therefore NEVER holds on a real workspace, and
 * the dedupe it was supposed to power silently does nothing: the 5s poll
 * republishes the group every 5s and repaints every corpus reader with it.
 * A transcript re-rendering on a timer is exactly the cost this module's
 * laziness exists to prevent, so the comparison has to know what `fill` is.
 *
 * ─── QUANTISED BY THE RENDERER'S OWN FUNCTION, not by a guess ────────────────
 * `ChatChip` draws the clock as `Math.floor(fill * CHAT_DECAY_DAYS)` — four
 * rungs over the chat's whole life, "the value is A's; only its resolution is
 * ours". Using that same expression here makes the dedupe exactly lossless: the
 * corpus repaints precisely when the chip would move a rung, and never for a
 * drift too small to draw. Not a tolerance, and not a field dropped — the
 * renderer's resolution, borrowed.
 *
 * Everything else is compared verbatim, so any OTHER field that starts churning
 * shows up as a repaint (today's behaviour) rather than as a missed update. The
 * failure direction is the safe one.
 */
function signatureReplacer(key: string, value: unknown): unknown {
  return key === 'fill' && typeof value === 'number'
    ? Math.floor(Math.max(0, Math.min(1, value)) * CHAT_DECAY_DAYS)
    : value;
}

function rowsSignature(tabs: readonly Tab[]): string {
  return JSON.stringify(tabs, signatureReplacer);
}

/**
 * Publish a freshly-FETCHED corpus, but only if a reader could tell.
 *
 * `subscribeResync` fires on every document-visible — on a desktop, every time
 * the user switches away and comes back. Going to look is right, and is how a
 * gap heals. Handing the answer to every subscriber unconditionally is not:
 * with nothing changed it repaints the flat list, the cards and `ChatPane` on
 * each switch, for bytes identical to the ones already on screen.
 *
 * Returns the array actually held, so an unchanged refetch keeps the PREVIOUS
 * object. Identity is the point — a `useMemo`, a `useState` set, or a props
 * compare can then short-circuit instead of re-rendering. Deep-equal is not
 * enough; React compares by reference.
 */
function publishFetched(next: WorkspaceTabs[]): WorkspaceTabs[] {
  if (cache && JSON.stringify(cache, signatureReplacer) === JSON.stringify(next, signatureReplacer))
    return cache;
  publish(next);
  return next;
}

/**
 * Take a workspace's freshly-landed tab list into the corpus.
 *
 * Called from ONE place — `tabs.ts` `refreshTabs`, where a list LANDS from the
 * server. That covers the 5s visible poll, the reconnect refetch, and the
 * refetch scheduled off a pane status edge, because all three land through it.
 * That cache is the sidebar's, so this is the seam that makes the rail and the
 * cards one surface rather than two clocks: the rows and the corpus are fed
 * from the same array, in the same tick.
 *
 * NOT from `applyTabRow`, and not from the optimistic local patches
 * (`applyTabOrder` / `applyTabUnread`). The first would double-publish — this
 * module subscribes to `tab.updated` itself and has already patched that row
 * from the same event. The other two move only `position` and `unread`, which
 * no corpus reader renders, and each is followed by a refetch that lands here
 * anyway.
 *
 * Both routes decorate through `orderedForWorkspace` (server/src/routes/tabs.ts),
 * so a group spliced in here is what `/api/tabs/all` would have returned for it.
 *
 * NO FETCH, and no group invented — same rule as the push handlers above. A
 * corpus nobody has asked for stays unasked-for.
 */
export function mergeWorkspaceTabs(workspaceId: string, tabs: readonly Tab[]): void {
  if (!cache) {
    // A list that landed while the first corpus fetch travels is newer than it.
    if (inFlight) generation++;
    return;
  }
  const group = cache.find((g) => g.id === workspaceId);
  // A workspace outside the corpus we hold — nothing to merge into. Same
  // reasoning as `tab.added` above: an id with no name is not a group.
  if (!group) return;
  // THE DEDUPE IS LOAD-BEARING, not an optimization. Without it the 5s
  // per-workspace poll would publish a new array every 5s whether or not
  // anything moved, and every corpus reader would re-render on that interval —
  // including `ChatPane`, which is a transcript. That is exactly the poll-on-
  // everything this module exists to avoid, arriving through the back door.
  if (rowsSignature(group.tabs) === rowsSignature(tabs)) return;
  generation++;
  publish(cache.map((g) => (g.id === workspaceId ? { ...g, tabs: [...tabs] } : g)));
}

/** Coalesce a burst of status edges into one corpus refetch. Matches the 250ms
 *  `scheduleLiveRefresh` uses for the same job on the per-workspace caches. */
const CORPUS_EDGE_MS = 250;
/**
 * …and never more often than this, however fast the edges keep arriving.
 *
 * The 250ms window coalesces a BURST and says nothing about a sustained stream.
 * A busy workspace the sidebar has not loaded can produce genuine status edges
 * several times a second, and every window would then spend a full
 * `/api/tabs/all` — measured at 40 KB against the live cockpit. Four of those a
 * second is not "not a poll", it is worse than the poll this module refuses to
 * have. The floor bounds the edge path to one fetch per two seconds while
 * leaving it 250ms-responsive when things are quiet, which is the case that
 * actually shows on screen.
 */
const CORPUS_EDGE_MIN_GAP_MS = 2000;
let edgeTimer: ReturnType<typeof setTimeout> | null = null;
let lastEdgeFetchAt = 0;

/**
 * A pane status edge for a tab the SIDEBAR'S cache does not hold.
 *
 * The last cell of the table that read "not at all". `mergeWorkspaceTabs` gives
 * the corpus the sidebar's clock, but only for workspaces the sidebar has
 * actually loaded — the expanded ones, and the one you are in. The corpus is
 * WIDER than that: the flat 'recent' list renders every visible workspace's
 * chats, and a card can point at work directed to another workspace entirely.
 * For those rows a `pane.updated` reached nobody, so their `status` sat at
 * fetch-time truth until a resync happened along — the same frozen spinner,
 * one workspace over.
 *
 * `tabs.ts` calls this only when NO cache slot holds the tab, so this never
 * duplicates the refetch it is already scheduling for itself.
 *
 * NOT A POLL, and three guards keep it that way: it fires only on a real status
 * change (`tabs.ts` gates on its per-pane signature), only for a row the corpus
 * actually holds, and only while something is actually rendering from the
 * corpus. A cockpit where nothing is happening sends nothing.
 */
export function refreshCorpusForTab(tabId: string): void {
  if (!cache) return;
  // No mounted reader means no pixels to correct; the next `loadAllTabs` on
  // mount will fetch anyway. This is what keeps an idle page silent.
  if (listeners.size === 0) return;
  if (!cache.some((g) => g.tabs.some((t) => t.id === tabId))) return;
  if (edgeTimer !== null) return;
  // Held rather than dropped: a stream of edges still gets its refetch, just on
  // the floor's schedule instead of its own.
  const since = Date.now() - lastEdgeFetchAt;
  edgeTimer = setTimeout(
    () => {
      edgeTimer = null;
      lastEdgeFetchAt = Date.now();
      settledAt = 0;
      // A request already travelling was asked before this edge; joining it
      // would hand back the pre-edge status. Superseding it makes its landing
      // queue the fetch this edge needs (see `loadAllTabs`).
      if (inFlight) generation++;
      void loadAllTabs();
    },
    Math.max(CORPUS_EDGE_MS, CORPUS_EDGE_MIN_GAP_MS - since),
  );
}

/**
 * A resync refetch is queued behind an in-flight request, so a burst of
 * reconnect + visibility events cannot stack a fetch each.
 */
let refetchQueued = false;

/**
 * Superseded landings in a row. A cockpit pushing continuously could otherwise
 * supersede every retry; past this many the corpus keeps the pushes it holds,
 * stays NOT-fresh (`settledAt` untouched), and the next `loadAllTabs` asks again.
 */
const MAX_SUPERSEDED_RETRIES = 3;
let supersededRetries = 0;

/**
 * Reconnect, and document-visible — the backstop for everything the pushes
 * missed while the socket was down, and for the workspaces `mergeWorkspaceTabs`
 * never hears about because the sidebar has not loaded them.
 *
 * Guarded on `cache`: with no corpus held, nobody has asked for one and a
 * reconnect is not a reason to start. That guard IS the laziness.
 */
const unsubscribeResync = subscribeResync(() => {
  if (!cache) return;
  // Not merely "allowed to refetch" — REQUIRED to. `loadAllTabs` short-circuits
  // on FRESH_MS, and a corpus that landed 4 seconds before the gap is fresh by
  // that clock and stale by the only one that matters.
  settledAt = 0;
  const pending = inFlight;
  if (!pending) {
    void loadAllTabs();
    return;
  }
  // A request issued BEFORE the gap can answer with pre-gap truth, and
  // `loadAllTabs` would hand that to every subscriber as the new corpus. Let it
  // settle — `inFlight` clears in its own `finally` — then ask again.
  if (refetchQueued) return;
  refetchQueued = true;
  void pending.then(() => {
    refetchQueued = false;
    settledAt = 0;
    void loadAllTabs();
  });
});

// Vite HMR: same reasoning as tabs.ts — editing this module in dev must not
// stack duplicate handlers. No-op in production.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    unsubscribeLive();
    unsubscribeResync();
    if (edgeTimer !== null) clearTimeout(edgeTimer);
    listeners.clear();
  });
}

/**
 * A corpus younger than this is reused as-is. Sized to cover a focus →
 * type → focus-again cycle (the box is refocused by every Esc-and-retry)
 * without going back to the server, while staying under the 5s tab poll so
 * search never shows a list that is older than the tree beside it.
 */
const FRESH_MS = 4000;

/**
 * Set once `/api/tabs/all` has answered 404 — an older server that predates
 * the route. Sticky for the page's lifetime: retrying it on every focus would
 * spend a request per keystroke session to learn the same thing again.
 */
let unsupported = false;

/** Whatever corpus we already have, without asking for one. */
export function cachedAllTabs(): WorkspaceTabs[] | null {
  return cache;
}

/**
 * Fetch the corpus, coalescing concurrent callers and skipping the round trip
 * entirely while the cached answer is fresh. Resolves to the previous corpus
 * (or an empty list) on failure rather than rejecting — the caller has a
 * usable fallback and a search box that throws on focus is worse than one that
 * matches slightly less.
 */
export async function loadAllTabs(): Promise<WorkspaceTabs[]> {
  if (unsupported) return cache ?? [];
  if (cache && Date.now() - settledAt < FRESH_MS) return cache;
  if (inFlight) return inFlight;
  const issuedAt = generation;
  let superseded = false;
  inFlight = api
    .listAllTabs()
    .then((res) => {
      if (generation !== issuedAt) {
        // Something newer than this answer arrived while it travelled (see
        // `generation`). Keep what we hold, do NOT mark it fresh, and go again
        // once this request has cleared. With nothing held (a first fetch), an
        // old answer beats none — the retry corrects it.
        superseded = true;
        return cache ?? publishFetched(res.workspaces);
      }
      supersededRetries = 0;
      settledAt = Date.now();
      // Landing is what makes the corpus fresh; publishing is only what tells
      // the readers, and an answer identical to the one they hold is not news.
      return publishFetched(res.workspaces);
    })
    .catch((err: unknown) => {
      // 404 = the route isn't there (older server). Anything else is a blip
      // worth retrying on the next focus.
      if ((err as { status?: number } | null)?.status === 404) unsupported = true;
      return cache ?? [];
    })
    .finally(() => {
      inFlight = null;
      if (superseded && supersededRetries < MAX_SUPERSEDED_RETRIES) {
        supersededRetries++;
        void loadAllTabs();
      }
    });
  return inFlight;
}

/** Test seam — drops the module cache, the latch, and every subscriber. */
export function resetAllTabsCache(): void {
  cache = null;
  settledAt = 0;
  inFlight = null;
  unsupported = false;
  refetchQueued = false;
  generation = 0;
  supersededRetries = 0;
  if (edgeTimer !== null) {
    clearTimeout(edgeTimer);
    edgeTimer = null;
  }
  lastEdgeFetchAt = 0;
  listeners.clear();
}
