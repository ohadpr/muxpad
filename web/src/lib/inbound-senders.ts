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
        const res = await req<SendersResponse>(`/api/tabs/${encodeURIComponent(tabId)}/inbound-senders`);
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
 * ─── One row, one bubble ─────────────────────────────────────────────────────
 * A coordinator that asks "status?" twice produces two rows and two bubbles, and
 * the second must not claim the first's row. Rows arrive NEWEST first and events
 * are oldest first, so walking the events backwards hands each repeat the row it
 * belongs to. When there are fewer rows than repeats — the cap dropped one, or
 * the older message predates the feature — the NEWEST bubbles keep their cards
 * and the rest render as today, which is the right way round: the card that
 * matters is on the brief that just landed.
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
  // Rows by key, newest first within each key — `listByTab` already orders the
  // whole list that way, so pushing in order preserves it per key.
  const byKey = new Map<string, InboundSender[]>();
  for (const s of senders) {
    const list = byKey.get(s.key);
    if (list) list.push(s);
    else byKey.set(s.key, [s]);
  }
  const out = new Map<string, string>();
  // BACKWARDS, so the newest bubble takes the newest row. See above.
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i] as ChatEvent;
    if (e.kind !== 'user') continue;
    const list = byKey.get(inboundTextKey(e.text));
    if (!list?.length) continue;
    // Consumed whether or not it names a chat: an unattributable send still
    // accounts for one of the repeats, and letting it fall through would hand
    // this bubble a DIFFERENT send's sender.
    const claimed = list.shift() as InboundSender;
    if (claimed.from_tab_id) out.set(e.id, claimed.from_tab_id);
  }
  return out;
}

/** Test seam — drops the module cache and the older-server latch. */
export function resetInboundSendersCache(): void {
  cache.clear();
  dirty.clear();
  inFlight.clear();
  unsupported = false;
}
