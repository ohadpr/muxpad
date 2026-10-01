import type { SpawnRound } from '@muxpad/shared';
import { req } from '../api';
import type { SpawnRoundsByChild } from './chat-mention';

/**
 * THE ROUNDS of every child of one conversation.
 *
 * A sub-chat is not one job. `muxpad agent send` revives a retired worker and
 * hands it the next one, and both of its cards were anchored to `created_at`
 * and `retired_at` — one pair per TAB. Measured on the real database: five
 * handovers against one pair, so four rounds left no card at all.
 *
 * ─── One request per CONVERSATION, not per card ──────────────────────────────
 * `GET /api/tabs/:id/spawn-rounds` answers for every child at once. A parent
 * with thirty children is the case this is shaped for, and thirty round trips to
 * draw one log is the problem lib/all-tabs already solved once.
 *
 * ─── …and not on the tab row ─────────────────────────────────────────────────
 * The row rides every five-second sidebar poll. A report is up to 800 characters
 * × every round × every child, which is the same arithmetic that kept the full
 * transcript off the row.
 *
 * Cached per parent for a short window, because the reason to re-ask is a round
 * STARTING or ENDING — both of which also move the child's tab row, so the
 * conversation is already re-rendering when it matters.
 */

/** How long a fetched answer is reused. Short: a handover is a thing you watch
 *  for, and the cost of asking again is one small query. */
const FRESH_MS = 4_000;

interface RoundsResponse {
  rounds: Record<string, SpawnRound[]>;
}

interface Entry {
  at: number;
  rounds: SpawnRoundsByChild;
}

const cache = new Map<string, Entry>();
const inFlight = new Map<string, Promise<SpawnRoundsByChild>>();
const dirty = new Set<string>();
/** False once the route has 404ed — an older server with no rounds table. */
let unsupported = false;

export const NO_ROUNDS: SpawnRoundsByChild = new Map();

/**
 * Fetch (or reuse) the rounds for one parent.
 *
 * Resolves to the previous answer — or an empty map — on any failure rather than
 * rejecting: `spawnCards` falls back to the tab-level pair when it gets nothing,
 * which is exactly what shipped before rounds existed. A conversation must never
 * lose its cards because one request did.
 */
export async function loadSpawnRounds(parentTabId: string, changed = false): Promise<SpawnRoundsByChild> {
  if (unsupported) return NO_ROUNDS;
  const running = inFlight.get(parentTabId);
  if (changed) {
    // A corpus update is evidence of staleness, regardless of the TTL. If it
    // arrives during a read, all callers await a trailing read as well.
    if (running) dirty.add(parentTabId);
  }
  if (running) return running;
  const hit = cache.get(parentTabId);
  if (!changed && hit && Date.now() - hit.at < FRESH_MS) return hit.rounds;
  const p = (async () => {
    let rounds = hit?.rounds ?? NO_ROUNDS;
    do {
      dirty.delete(parentTabId);
      try {
        const res = await req<RoundsResponse>(`/api/tabs/${encodeURIComponent(parentTabId)}/spawn-rounds`);
        rounds = new Map(Object.entries(res.rounds ?? {}));
        cache.set(parentTabId, { at: Date.now(), rounds });
      } catch (err: unknown) {
        if ((err as { status?: number } | null)?.status === 404) unsupported = true;
      }
    } while (!unsupported && dirty.has(parentTabId));
    return rounds;
  })().finally(() => {
    inFlight.delete(parentTabId);
    dirty.delete(parentTabId);
  });
  inFlight.set(parentTabId, p);
  return p;
}

/** Test seam — drops the module cache and the older-server latch. */
export function resetSpawnRoundsCache(): void {
  cache.clear();
  dirty.clear();
  inFlight.clear();
  unsupported = false;
}
