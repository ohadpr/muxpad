import type { ChatChipChat } from '../components/ChatChip';

/**
 * Work this chat has DIRECTED at another chat — the cards in the log.
 *
 * ── Why this is device-local storage and not a server table ──────────────────
 * muxpad never writes an agent's transcript; it tails the file the harness owns.
 * So the only durable rows a conversation can gain are REAL DELIVERED MESSAGES,
 * and a directed request is deliberately not delivered here — it is delivered to
 * the OTHER chat. Nothing would therefore appear in this chat at all, and the
 * user would have typed a sentence and watched it vanish.
 *
 * The honest cheap fix is a local echo, which is what this is: the same class of
 * state as the composer draft next door (`muxpad.chatDraft.<paneId>`), kept in
 * localStorage so a reload does not lose the card, and keyed per pane. The
 * REPORT that comes back is a real message and needs none of this — it arrives
 * in the transcript like anything else.
 *
 * The right long-term home is the `spawn_notes`-shaped table the primitives note
 * describes (muxpad-owned non-transcript rows merged into the chat socket's
 * replay, next to the pending send queue): durable, cross-device, and invisible
 * to the model. That is a server change, so it is not this territory's to make —
 * see the report.
 */

export interface DirectedWork {
  /** Correlates with the `<muxpad-report id>` that comes back. */
  id: string;
  /** Epoch ms the request went out. */
  at: number;
  /** Where the card navigates to. */
  tabId: string;
  tabSlug: string;
  workspaceSlug: string;
  /** What was asked, verbatim — the card's second line. */
  body: string;
  /**
   * Chip material frozen at send time.
   *
   * A snapshot rather than a live lookup on purpose: the card must draw on the
   * first paint after a reload, before `/api/tabs/all` has answered, and a card
   * that appears blank and then fills in is worse than one whose clock is a few
   * minutes stale. The corpus refreshes it when it arrives.
   */
  chip: ChatChipChat & { headline?: string | null };
  /** Epoch ms the report came back, if it has. */
  reportedAt?: number;
}

/** Per-pane, like the draft next to it. A directed card is not shared state. */
const KEY = (paneId: string) => `muxpad.directed.${paneId}`;

/**
 * How many cards one chat keeps, and for how long.
 *
 * A cap AND an age, because the two failure modes are different: a chat used as
 * a dispatcher would otherwise accumulate cards forever, and a single old card
 * at the foot of a conversation you have moved on from is clutter that never
 * earns its place back.
 */
const MAX_CARDS = 12;
const MAX_AGE_MS = 7 * 86_400_000;

export function loadDirected(paneId: string, now: number = Date.now()): DirectedWork[] {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY(paneId));
  } catch {
    return []; // storage unavailable (private mode / quota) — cards just don't persist
  }
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((x): x is DirectedWork => {
      if (!x || typeof x !== 'object') return false;
      const d = x as Partial<DirectedWork>;
      return typeof d.id === 'string' && typeof d.at === 'number' && typeof d.tabId === 'string';
    })
    .filter((d) => now - d.at < MAX_AGE_MS)
    .sort((a, b) => a.at - b.at)
    .slice(-MAX_CARDS);
}

function save(paneId: string, list: readonly DirectedWork[]): void {
  try {
    localStorage.setItem(KEY(paneId), JSON.stringify(list.slice(-MAX_CARDS)));
  } catch {
    // Same as the draft next door: persistence is a nicety, not a contract.
  }
}

/** Append a card. Returns the new list so the caller can render it at once. */
export function addDirected(paneId: string, item: DirectedWork): DirectedWork[] {
  const next = [...loadDirected(paneId), item];
  save(paneId, next);
  return next;
}

/** Drop a card whose request never left (a refused or unreachable target). */
export function removeDirected(paneId: string, id: string): DirectedWork[] {
  const next = loadDirected(paneId).filter((d) => d.id !== id);
  save(paneId, next);
  return next;
}

/**
 * Mark the cards whose reports have landed.
 *
 * Takes the WHOLE set of reported ids in one call, from the ids present in the
 * transcript: a report can arrive while this pane was closed, so "which cards
 * are answered" has to be recomputed from the transcript on every load rather
 * than observed as an event.
 */
export function syncReported(
  paneId: string,
  reportedIds: ReadonlySet<string>,
  now: number = Date.now(),
): DirectedWork[] {
  const list = loadDirected(paneId);
  let changed = false;
  const next = list.map((d) => {
    if (d.reportedAt || !reportedIds.has(d.id)) return d;
    changed = true;
    return { ...d, reportedAt: now };
  });
  if (changed) save(paneId, next);
  return changed ? next : list;
}
