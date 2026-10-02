import type { ChatEvent, InboundSender } from '@muxpad/shared';
import { inboundTextKey } from '@muxpad/shared';
import { req } from '../api';

/**
 * WHO SENT the messages in this conversation.
 *
 * A message put into a chat by `muxpad agent send` arrives as an ordinary user
 * bubble — muxpad does not write the agent's transcript, it tails the harness's
 * file — so on the receiving side a coordinator's brief has been
 * indistinguishable from something the human typed. The server records the
 * provenance in a row of its own (see InboundMessageStore); this is the client
 * half that joins it back onto the transcript.
 *
 * The mirror of lib/spawn-rounds, and deliberately built the same way: one
 * request per CONVERSATION, cached for a short window, degrading to "no cards"
 * on every failure. A conversation must never lose its messages because one
 * request did.
 */

/** How long a fetched answer is reused. Matches lib/spawn-rounds: the reason to
 *  re-ask is a message ARRIVING, which moves the transcript anyway. */
const FRESH_MS = 4_000;

interface SendersResponse {
  senders: InboundSender[];
}

interface Entry {
  at: number;
  senders: InboundSender[];
}

const cache = new Map<string, Entry>();
const inFlight = new Map<string, Promise<InboundSender[]>>();
const dirty = new Set<string>();
/** True once the route has 404ed — an older server with no provenance table. */
let unsupported = false;

export const NO_SENDERS: InboundSender[] = [];
/** Shared empty result, so a conversation with no cards keeps every memo below
 *  it stable rather than handing out a fresh Map on every render. */
const NO_MATCHES: ReadonlyMap<string, string> = new Map();

/**
 * Fetch (or reuse) the recorded senders for one chat.
 *
 * Resolves to the previous answer — or an empty list — on any failure rather
 * than rejecting. An unattributed message renders exactly as it did before this
 * feature existed, which is the correct degradation.
 *
 * `changed` says a new user message has ARRIVED since the last ask — the one
 * event that makes the list stale, so it bypasses the freshness window. If it
 * lands while a read is in flight, that read may predate the new row, so every
 * caller awaits a trailing read as well (the same shape as lib/spawn-rounds).
 * Without this, a brief delivered within FRESH_MS of the previous fetch got the
 * old list back and stayed unattributed until some unrelated message arrived.
 */
export async function loadInboundSenders(tabId: string, changed = false): Promise<InboundSender[]> {
  if (unsupported) return NO_SENDERS;
  const running = inFlight.get(tabId);
  if (changed && running) dirty.add(tabId);
  if (running) return running;
  const hit = cache.get(tabId);
  if (!changed && hit && Date.now() - hit.at < FRESH_MS) return hit.senders;
  const p = (async () => {
    let senders = hit?.senders ?? NO_SENDERS;
    do {
      dirty.delete(tabId);
      try {
        const res = await req<SendersResponse>(
          `/api/tabs/${encodeURIComponent(tabId)}/inbound-senders`,
        );
        senders = res.senders ?? [];
        cache.set(tabId, { at: Date.now(), senders });
      } catch (err: unknown) {
        if ((err as { status?: number } | null)?.status === 404) unsupported = true;
      }
    } while (!unsupported && dirty.has(tabId));
    return senders;
  })().finally(() => {
    inFlight.delete(tabId);
    dirty.delete(tabId);
  });
  inFlight.set(tabId, p);
  return p;
}

/**
 * Which transcript events were delivered by another chat — event id → sender
 * tab id.
 *
 * ─── Why the text and not the time ───────────────────────────────────────────
 * The row and the bubble share no id. The timestamp cannot join them either: a
 * send that lands mid-turn waits in the server-side queue and reaches the
 * transcript when that turn ends, which on a long turn is many minutes after the
 * send. The TEXT survives that trip unchanged.
 *
 * ─── One row, one bubble — and never one that came BEFORE the send ─────────
 * A coordinator that asks "status?" twice produces two rows and two bubbles, and
 * the second must not claim the first's row. The time cannot JOIN them, but it
 * does BOUND them: a message cannot reach the transcript before it was sent. So
 * rows are taken OLDEST first, and each claims the earliest unclaimed bubble
 * with its text at or after its own `at` (less `SEND_SKEW_MS`: the row is
 * written just after the relay, so the harness can stamp the bubble a hair
 * earlier).
 *
 * This replaced walking the events backwards and handing each repeat the newest
 * row, which assumed every row was a bubble already in the transcript and every
 * repeat had a row. Neither holds:
 *   - a row is recorded when a send is ACCEPTED, and a queued one is not in the
 *     transcript yet (or ever, if it is cancelled) — newest-first gave it the
 *     bubble an EARLIER sender's message had produced;
 *   - a human who later types the same text leaves no row — newest-first gave
 *     the coordinator's row to the human's bubble and took the card off the
 *     coordinator's own.
 * The bound fixes both. What it cannot see is a human typing the identical text
 * in the window between a QUEUED send and its delivery; that needs provenance
 * bound to the delivery itself (server side), not a better guess here.
 *
 * When there are fewer rows than repeats — the cap dropped one, or the older
 * message predates the feature — the bubbles with no row in range render as
 * today.
 *
 * A row whose sender is null is deliberately NOT matched. muxpad recorded the
 * send and cannot name a chat behind it; a card with no name is worse than the
 * bubble it replaced, and inventing one is the thing this must never do.
 */
export function matchInboundSenders(
  events: readonly ChatEvent[],
  senders: readonly InboundSender[],
): ReadonlyMap<string, string> {
  if (senders.length === 0 || events.length === 0) return NO_MATCHES;
  // Bubbles by key, oldest first — the transcript's own order.
  const byKey = new Map<string, ChatEvent[]>();
  for (const e of events) {
    if (e.kind !== 'user') continue;
    const key = inboundTextKey(e.text);
    const list = byKey.get(key);
    if (list) list.push(e);
    else byKey.set(key, [e]);
  }
  const out = new Map<string, string>();
  // OLDEST row first. `listByTab` orders newest first, so walk it backwards.
  for (let i = senders.length - 1; i >= 0; i--) {
    const s = senders[i] as InboundSender;
    const list = byKey.get(s.key);
    if (!list?.length) continue;
    // A bubble with no timestamp cannot be ruled out, so it stays eligible.
    const at = list.findIndex((e) => e.ts === null || e.ts >= s.at - SEND_SKEW_MS);
    if (at < 0) continue;
    // Consumed whether or not it names a chat: an unattributable send still
    // accounts for one of the repeats, and letting it fall through would hand
    // this bubble a DIFFERENT send's sender.
    const [claimed] = list.splice(at, 1) as [ChatEvent];
    if (s.from_tab_id) out.set(claimed.id, s.from_tab_id);
  }
  return out;
}

/** How far before a row's `at` its bubble may be stamped. The row is written
 *  just after the relay and the harness stamps the bubble on its own read of
 *  the clock — milliseconds apart in practice; this is a margin, not a
 *  measurement. */
const SEND_SKEW_MS = 5_000;

/** Test seam — drops the module cache and the older-server latch. */
export function resetInboundSendersCache(): void {
  cache.clear();
  dirty.clear();
  inFlight.clear();
  unsupported = false;
}
