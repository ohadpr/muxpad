import { type Tab, collectLayoutLeaves } from '@muxpad/shared';
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { api } from '../api';
import type { WorkspaceTabs } from './nav-search';

/**
 * FINISHED HISTORY, ASKED FOR WHEN SOMEBODY GOES LOOKING — never shipped whole.
 *
 * The live corpus (`/api/tabs/all`, lib/all-tabs) is being narrowed to the
 * chats that are still live (or still unread). That was 1,605 of 1,628 rows,
 * almost all of them finished, on every device and every corpus fetch. Two
 * readers still need the finished rows, and both need only a few:
 *
 *   · ⌘K and the `@` picker, matching a NAME you type — a chat archived last
 *     month is still a place you might go or point work at.
 *   · an archive hit (`/api/search`) whose pane belongs to a finished chat. It
 *     used to resolve against the full corpus; with the corpus narrowed it would
 *     be silently dropped as "a pane that no longer exists".
 *
 * Both go through `GET /api/tabs/lookup`, which is bounded on the server
 * (`q`, or at most 60 `paneIds` → at most 60 rows, report prose stripped). This
 * module is its client: one shared cache for every surface, so the palette and
 * five open chat panes asking about the same pane cost one request.
 *
 * WHAT IT IS NOT: a second corpus. It holds only rows somebody asked for, it is
 * capped, and a reader MERGES it under the live corpus (`mergeTabGroups`) — the
 * live row always wins, so a looked-up row can be stale only for a chat that is
 * not in the live corpus at all, which is the finished one, which barely moves.
 */

/** Mirrors the server's caps. Asking for more can only earn a refusal. */
export const LOOKUP_MAX_PANE_IDS = 60;
/** Single-character chat names must remain searchable after retirement. */
export const LOOKUP_MIN_CHARS = 1;
/** A name is short; past this it is a sentence, and a sentence is not a lookup. */
export const LOOKUP_MAX_QUERY_CHARS = 128;
/** Historical names land after the instant tier, never in front of it. */
export const LOOKUP_DEBOUNCE_MS = 200;
/** How long a query's answer is reused (backspace, reopen) before it is asked again. */
const QUERY_TTL_MS = 30_000;
const MAX_QUERIES = 40;
/** Rows held, total. Each surface shows ≤12; this is generous and still bounded. */
export const LOOKUP_MAX_ROWS = 600;
/**
 * Rows a MOUNTED CONSUMER still points at are exempt from eviction, up to
 * this many. A review found the failure that needs it: a historical chat is
 * picked into a draft, other transcripts and searches fill the 600-row cache
 * and evict it, and `mentionedChats` then resolves that pick to nothing — so
 * SENDING silently omitted the chat's context, with the chip still on screen.
 * The cap keeps the exemption from becoming its own unbounded cache; picks in
 * open drafts are a handful, not hundreds.
 */
const MAX_RETAINED = 200;
/** A pane id the server did not know is not asked about again for this long. */
const PANE_MISS_TTL_MS = 60_000;
const MAX_PANE_MISSES = 2_000;

interface GroupMeta {
  id: string;
  slug: string;
  name: string;
}
interface Held {
  group: GroupMeta;
  tab: Tab;
}

const rows = new Map<string, Held>();
const paneToTab = new Map<string, string>();
const paneMisses = new Map<string, number>();
const queries = new Map<string, { tabIds: string[]; at: number }>();
const queriesInFlight = new Set<string>();
const panesPending = new Set<string>();
const panesInFlight = new Set<string>();
let paneTimer: ReturnType<typeof setTimeout> | null = null;
/** tab id → how many mounted consumers are pointing at it. */
const retained = new Map<string, number>();
const tabMisses = new Map<string, number>();
const tabsPending = new Set<string>();
const tabsInFlight = new Set<string>();
let tabTimer: ReturnType<typeof setTimeout> | null = null;
/** Latched on the first 404 — an older server without the route. */
let unsupported = false;
let version = 0;
const listeners = new Set<() => void>();

function changed(): void {
  version++;
  for (const fn of listeners) fn();
}

/** The cache key for a query. Matching is case-insensitive on the server. */
export function lookupKey(q: string): string {
  return q.trim().toLowerCase();
}

/** Would `q` be sent at all? */
export function lookupAskable(q: string): boolean {
  const t = q.trim();
  return t.length >= LOOKUP_MIN_CHARS && t.length <= LOOKUP_MAX_QUERY_CHARS;
}

function touch<K, V>(m: Map<K, V>, k: K, v: V, max: number): void {
  // Insertion order is the LRU order: re-set moves a key to the back.
  m.delete(k);
  m.set(k, v);
  while (m.size > max) {
    const oldest = m.keys().next().value as K;
    m.delete(oldest);
  }
}

/** Forget a held row's panes — the pane index is only as big as the rows. */
function dropPanesOf(held: Held): void {
  for (const p of collectLayoutLeaves(held.tab.layout))
    if (paneToTab.get(p) === held.tab.id) paneToTab.delete(p);
}

/**
 * Hold one row, LRU-bounded at {@link LOOKUP_MAX_ROWS} — and the pane index
 * with it. An evicted row takes its pane entries along, and a re-held row
 * drops the panes its old layout had, so `paneToTab` can never outgrow the
 * rows it points into (nor answer a pane with a row that is gone).
 */
function holdRow(held: Held): void {
  const before = rows.get(held.tab.id);
  if (before) dropPanesOf(before);
  rows.delete(held.tab.id);
  rows.set(held.tab.id, held);
  // Oldest first, SKIPPING retained rows — see MAX_RETAINED. If everything
  // left is retained there is nothing to evict and the loop has to stop, or
  // it spins; the cap is what keeps that bounded.
  while (rows.size > LOOKUP_MAX_ROWS) {
    let victim: Held | null = null;
    for (const [id, row] of rows) {
      if (!retained.has(id)) {
        victim = row;
        break;
      }
    }
    if (!victim) break;
    rows.delete(victim.tab.id);
    dropPanesOf(victim);
  }
  for (const p of collectLayoutLeaves(held.tab.layout)) {
    paneToTab.set(p, held.tab.id);
    paneMisses.delete(p);
  }
}

function take(groups: readonly WorkspaceTabs[]): string[] {
  const ids: string[] = [];
  for (const g of groups) {
    const meta = { id: g.id, slug: g.slug, name: g.name };
    for (const t of g.tabs) {
      ids.push(t.id);
      holdRow({ group: meta, tab: t });
    }
  }
  return ids;
}

/**
 * Keep these rows while the caller is mounted. Returns the release.
 *
 * Idempotent per call, refcounted across callers: two drafts picking the same
 * chat retain it once each, and it becomes evictable again when both let go.
 * Beyond MAX_RETAINED the request is simply not honoured — the row stays
 * evictable, which is the pre-existing behaviour, rather than the cache
 * growing without a bound.
 */
export function retainTabIds(ids: readonly string[]): () => void {
  const held = ids.filter((id) => id && (retained.has(id) || retained.size < MAX_RETAINED));
  for (const id of held) retained.set(id, (retained.get(id) ?? 0) + 1);
  return () => {
    for (const id of held) {
      const n = (retained.get(id) ?? 1) - 1;
      if (n > 0) retained.set(id, n);
      else retained.delete(id);
    }
  };
}

/** Test seam — how much the cache holds. Both are bounded by the rows. */
export function lookupCacheSizes(): { rows: number; panes: number } {
  return { rows: rows.size, panes: paneToTab.size };
}

/** The request, as a promise that cannot throw synchronously — a lookup is
 *  always a supplement, and nothing about asking for one may break the caller. */
function ask(by: { q: string } | { paneIds: readonly string[] } | { tabIds: readonly string[] }) {
  return Promise.resolve().then(() => api.lookupTabs(by));
}

function failed(err: unknown): void {
  if ((err as { status?: number } | null)?.status === 404) unsupported = true;
}

/**
 * Ask the server for chats matching `q`, unless a fresh answer is held or the
 * same question is already travelling. Never rejects; the instant tier is the
 * answer being read, and this only ever adds rows under it.
 */
export function requestLookupQuery(q: string): void {
  if (unsupported || !lookupAskable(q)) return;
  const key = lookupKey(q);
  const held = queries.get(key);
  // A FRESH RECORD WHOSE ROWS ARE GONE IS NOT AN ANSWER. The record outlives
  // the rows it names — different maps, different LRUs — so reopening a query
  // whose rows had been evicted returned zero rows, made zero requests and
  // reported `searching: false`: a search that confidently answered nothing.
  if (held && Date.now() - held.at < QUERY_TTL_MS && held.tabIds.every((id) => rows.has(id))) {
    return;
  }
  if (queriesInFlight.has(key)) return;
  queriesInFlight.add(key);
  changed();
  ask({ q: q.trim() })
    .then((res) => {
      touch(queries, key, { tabIds: take(res.workspaces), at: Date.now() }, MAX_QUERIES);
    })
    .catch((err: unknown) => {
      failed(err);
      // An answer, empty, FOR THIS QUERY — so "searching" ends and nothing
      // retries it on every render. It ages out like any other answer.
      touch(queries, key, { tabIds: [], at: Date.now() }, MAX_QUERIES);
    })
    .finally(() => {
      queriesInFlight.delete(key);
      changed();
    });
}

/** Is a pane already resolved, known missing, or on its way? */
function paneSettled(p: string, now: number): boolean {
  const tabId = paneToTab.get(p);
  if (tabId && rows.has(tabId)) return true;
  const missAt = paneMisses.get(p);
  if (missAt !== undefined && now - missAt < PANE_MISS_TTL_MS) return true;
  return panesPending.has(p) || panesInFlight.has(p);
}

/**
 * Resolve pane ids to their chats. Batched: everything asked within one tick
 * goes out together, at most {@link LOOKUP_MAX_PANE_IDS} per request, one
 * request at a time. A pane the server does not know is remembered as a miss,
 * so a dead archive session is asked about once, not on every keystroke.
 */
export function requestLookupPanes(paneIds: readonly string[]): void {
  if (unsupported) return;
  const now = Date.now();
  let added = false;
  for (const p of paneIds) {
    if (!p || paneSettled(p, now)) continue;
    panesPending.add(p);
    added = true;
  }
  if (added) schedulePanes();
}

function schedulePanes(): void {
  if (paneTimer !== null || panesInFlight.size > 0 || panesPending.size === 0) return;
  paneTimer = setTimeout(flushPanes, 0);
}

function flushPanes(): void {
  paneTimer = null;
  if (unsupported) {
    panesPending.clear();
    return;
  }
  const batch = [...panesPending].slice(0, LOOKUP_MAX_PANE_IDS);
  if (batch.length === 0) return;
  for (const p of batch) {
    panesPending.delete(p);
    panesInFlight.add(p);
  }
  changed();
  ask({ paneIds: batch })
    .then((res) => {
      take(res.workspaces);
      const at = Date.now();
      for (const p of batch) if (!paneToTab.has(p)) touch(paneMisses, p, at, MAX_PANE_MISSES);
    })
    .catch((err: unknown) => {
      failed(err);
      // Not a miss: the server did not say these panes are gone, the request
      // failed. They are simply eligible again on the next ask.
    })
    .finally(() => {
      for (const p of batch) panesInFlight.delete(p);
      changed();
      schedulePanes();
    });
}

/** Is a tab already held, known missing, or on its way? */
function tabSettled(id: string, now: number): boolean {
  if (rows.has(id)) return true;
  const missAt = tabMisses.get(id);
  if (missAt !== undefined && now - missAt < PANE_MISS_TTL_MS) return true;
  return tabsPending.has(id) || tabsInFlight.has(id);
}

/**
 * Fetch chats by EXACT tab id — a reference somebody recorded (a pick, a sent
 * mention's context block, an inbound sender, a directed card). Same batching
 * and miss rules as {@link requestLookupPanes}; a name is never involved, so
 * two chats called "Main" cannot be confused.
 */
export function requestLookupTabIds(tabIds: readonly string[]): void {
  if (unsupported) return;
  const now = Date.now();
  let added = false;
  for (const id of tabIds) {
    if (!id || tabSettled(id, now)) continue;
    tabsPending.add(id);
    added = true;
  }
  if (added) scheduleTabs();
}

function scheduleTabs(): void {
  if (tabTimer !== null || tabsInFlight.size > 0 || tabsPending.size === 0) return;
  tabTimer = setTimeout(flushTabs, 0);
}

function flushTabs(): void {
  tabTimer = null;
  if (unsupported) {
    tabsPending.clear();
    return;
  }
  const batch = [...tabsPending].slice(0, LOOKUP_MAX_PANE_IDS);
  if (batch.length === 0) return;
  for (const id of batch) {
    tabsPending.delete(id);
    tabsInFlight.add(id);
  }
  changed();
  ask({ tabIds: batch })
    .then((res) => {
      take(res.workspaces);
      const at = Date.now();
      for (const id of batch) if (!rows.has(id)) touch(tabMisses, id, at, MAX_PANE_MISSES);
    })
    .catch((err: unknown) => {
      failed(err);
    })
    .finally(() => {
      for (const id of batch) tabsInFlight.delete(id);
      changed();
      scheduleTabs();
    });
}

/** Are any of these tab ids still being fetched? */
export function lookupTabsPending(tabIds: readonly string[]): boolean {
  return tabIds.some((id) => tabsPending.has(id) || tabsInFlight.has(id));
}

/** Is an answer for `q` still to come — debounce aside? */
export function lookupQueryPending(q: string): boolean {
  if (unsupported || !lookupAskable(q)) return false;
  const key = lookupKey(q);
  return queriesInFlight.has(key) || !queries.has(key);
}

/** Are any of these panes still being resolved? */
export function lookupPanesPending(paneIds: readonly string[]): boolean {
  return paneIds.some((p) => panesPending.has(p) || panesInFlight.has(p));
}

/**
 * The rows held for `query`. The exact answer when it has landed; until then
 * the answer for the LONGEST HELD PREFIX of it, which is a superset of the
 * eventual answer under substring matching. Safe because every reader re-ranks
 * against the query on screen (rankTabs / rankMentions) — a row from `inv` that
 * does not match `invoice` is filtered out there, never offered.
 */
function queryTabIds(query: string): readonly string[] {
  if (!lookupAskable(query)) return [];
  const key = lookupKey(query);
  const exact = queries.get(key);
  if (exact) return exact.tabIds;
  for (let n = key.length - 1; n >= LOOKUP_MIN_CHARS; n--) {
    const prefix = queries.get(key.slice(0, n));
    if (prefix) return prefix.tabIds;
  }
  return [];
}

const NO_GROUPS: WorkspaceTabs[] = [];

/**
 * Held rows, grouped by workspace, for the given query / panes / tab ids.
 * Pure over the cache: it never fetches.
 */
export function lookupGroups(want: {
  query?: string;
  /** Several name queries at once — a transcript's plain `@name` fallback. */
  queries?: readonly string[];
  paneIds?: readonly string[];
  tabIds?: readonly string[];
}): WorkspaceTabs[] {
  const ids = new Set<string>(want.query ? queryTabIds(want.query) : []);
  for (const q of want.queries ?? []) for (const id of queryTabIds(q)) ids.add(id);
  for (const p of want.paneIds ?? []) {
    const id = paneToTab.get(p);
    if (id) ids.add(id);
  }
  for (const id of want.tabIds ?? []) ids.add(id);
  const out = new Map<string, WorkspaceTabs>();
  for (const id of ids) {
    const held = rows.get(id);
    if (!held) continue;
    let g = out.get(held.group.id);
    if (!g) {
      g = { ...held.group, tabs: [] };
      out.set(held.group.id, g);
    }
    g.tabs.push(held.tab);
  }
  return out.size === 0 ? NO_GROUPS : [...out.values()];
}

/**
 * The live corpus, with looked-up rows it does not hold folded in.
 *
 * THE LIVE ROW WINS. A chat in both is live, and the live copy follows the
 * server's pushes; the looked-up copy is a snapshot. Returns `primary` ITSELF
 * when there is nothing to add, so a memo downstream does not churn on an
 * empty lookup — which is the state every surface is in nearly all the time.
 */
export function mergeTabGroups(
  primary: readonly WorkspaceTabs[],
  extra: readonly WorkspaceTabs[],
): WorkspaceTabs[] {
  if (extra.length === 0) return primary as WorkspaceTabs[];
  const have = new Set<string>();
  for (const g of primary) for (const t of g.tabs) have.add(t.id);
  const add = new Map<string, Tab[]>();
  const meta = new Map<string, WorkspaceTabs>();
  for (const g of extra) {
    for (const t of g.tabs) {
      if (have.has(t.id)) continue;
      have.add(t.id);
      const list = add.get(g.id) ?? [];
      list.push(t);
      add.set(g.id, list);
      meta.set(g.id, g);
    }
  }
  if (add.size === 0) return primary as WorkspaceTabs[];
  const out = primary.map((g) => {
    const more = add.get(g.id);
    if (!more) return g;
    add.delete(g.id);
    return { ...g, tabs: [...g.tabs, ...more] };
  });
  for (const [id, tabs] of add) {
    const g = meta.get(id);
    if (g) out.push({ id: g.id, slug: g.slug, name: g.name, tabs });
  }
  return out;
}

/**
 * LIVE MATCHES FIRST, HISTORY STRICTLY UNDER THEM — one row per chat, capped.
 *
 * Ranked as two pools rather than one merged pool, on purpose: a single ranking
 * lets a finished chat with a better name match land ABOVE a live one, and the
 * debounced lookup answer would then reorder rows the user is already reading.
 * `rank` is the surface's own ranker (rankTabs, rankMentions), so this decides
 * only the ORDER of the two tiers, never what matches.
 */
export function rankLiveThenHistory<P extends { tabId: string }, R>(
  live: readonly P[],
  history: readonly P[],
  rank: (pool: readonly P[]) => R[],
  idOf: (row: R) => string,
  limit: number,
): R[] {
  const first = rank(live).slice(0, limit);
  if (first.length >= limit || history.length === 0) return first;
  const seen = new Set(first.map(idOf));
  const liveIds = new Set(live.map((t) => t.tabId));
  const rest = rank(history.filter((t) => !liveIds.has(t.tabId))).filter((r) => !seen.has(idOf(r)));
  return [...first, ...rest].slice(0, limit);
}

export function subscribeLookup(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function getVersion(): number {
  return version;
}

/**
 * The hook. `query` is debounced here; `paneIds` and `tabIds` are batched
 * immediately (what produces them — an archive answer, a transcript — is not
 * typing). Rows come back for exactly what was asked: the query's matches, the
 * chats owning those panes, and those tab ids. `tabIds` is how a RECORDED
 * reference is kept resolvable — an `@` pick across its query closing and
 * across a reload, a transcript's references — by id, never by name.
 */
export function useTabLookup(opts: {
  query: string;
  /** Name queries asked at once, NOT debounced — there is no typing to wait
   *  out. The caller bounds them (lib/transcript-mentions). */
  queries?: readonly string[];
  paneIds?: readonly string[];
  tabIds?: readonly string[];
}): { groups: WorkspaceTabs[]; searching: boolean } {
  const v = useSyncExternalStore(subscribeLookup, getVersion, getVersion);
  const query = opts.query;
  const paneKey = (opts.paneIds ?? []).join(',');
  const tabKey = (opts.tabIds ?? []).join(',');
  const queriesKey = (opts.queries ?? []).join('\n');

  useEffect(() => {
    if (!lookupAskable(query)) return;
    const timer = setTimeout(() => requestLookupQuery(query), LOOKUP_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `v` is the cache version — an eviction is the event this must re-ask after
  useEffect(() => {
    if (paneKey) requestLookupPanes(paneKey.split(','));
  }, [paneKey, v]);

  // RETAINED WHILE THIS HOOK IS MOUNTED, and re-asked if a row goes missing
  // anyway (a cold reload, or more retained references than the cap allows).
  // `v` is in the deps for exactly that: the eviction that used to be
  // invisible here is a version bump, and `requestLookupTabIds` skips every
  // id it already holds, so the cost of looking is one map lookup per id.
  useEffect(() => retainTabIds(tabKey ? tabKey.split(',') : []), [tabKey]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: same — `v` changing is how this hook learns a held row is gone
  useEffect(() => {
    if (tabKey) requestLookupTabIds(tabKey.split(','));
  }, [tabKey, v]);

  useEffect(() => {
    if (queriesKey) for (const q of queriesKey.split('\n')) requestLookupQuery(q);
  }, [queriesKey]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `v` is the cache's version; the keys are the inputs' identity
  return useMemo(() => {
    const paneIds = paneKey ? paneKey.split(',') : [];
    const tabIds = tabKey ? tabKey.split(',') : [];
    const queries = queriesKey ? queriesKey.split('\n') : [];
    return {
      groups: lookupGroups({ query, queries, paneIds, tabIds }),
      searching:
        lookupQueryPending(query) ||
        queries.some(lookupQueryPending) ||
        lookupPanesPending(paneIds) ||
        lookupTabsPending(tabIds),
    };
  }, [v, query, queriesKey, paneKey, tabKey]);
}

/** Test seam — drop every held row, answer, latch and listener. */
export function resetTabLookup(): void {
  rows.clear();
  paneToTab.clear();
  paneMisses.clear();
  queries.clear();
  queriesInFlight.clear();
  panesPending.clear();
  panesInFlight.clear();
  if (paneTimer !== null) clearTimeout(paneTimer);
  paneTimer = null;
  retained.clear();
  tabMisses.clear();
  tabsPending.clear();
  tabsInFlight.clear();
  if (tabTimer !== null) clearTimeout(tabTimer);
  tabTimer = null;
  unsupported = false;
  version = 0;
  listeners.clear();
}
