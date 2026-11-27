import {
  type LayoutNode,
  type MentionedChat,
  collectLayoutLeaves,
  parseMentionContext,
} from '@muxpad/shared';
import { LOOKUP_MAX_PANE_IDS, LOOKUP_MIN_CHARS } from './tab-lookup';

/**
 * WHICH CHATS A TRANSCRIPT REFERS TO — read from what was sent, not guessed.
 *
 * A sent message that mentioned other chats carries a `<muxpad-context>` block
 * (shared/chat-context `withMentionContext`) listing each one by NAME, `tabId`
 * and `paneId`s. The log draws a mention as a chip by resolving `@Name` against
 * a corpus — and the shared corpus now holds live chats only, so every mention
 * of a chat that has since finished would fall back to plain text.
 *
 * This reads those handles back out so the pane can ask `/api/tabs/lookup` for
 * exactly the chats its transcript references — bounded, and scoped: a chip
 * comes from the transcript's own references, never from whatever a search box
 * happened to look up.
 */
/** One reference a sent message recorded — shared/chat-context's shape. */
export type TranscriptRef = MentionedChat;

/**
 * The references in ONE raw message's context block; [] when it has none.
 * The SHARED parser, not a copy: the block's writer and reader live together
 * there (`withMentionContext` / `parseMentionContext`). Only raw text reaches
 * this — the optimistic echo and the queued preview; a normalized transcript
 * event has already had its block turned into `mentions`.
 */
export const parseContextRefs = parseMentionContext;

/** A transcript row as this reads it: its shown text, and the exact
 *  references the normalizer kept when it stripped the context block
 *  (shared/chat-events `forDisplay` → `mentions`). */
export interface TranscriptMessage {
  text: string;
  mentions?: readonly { tabId: string }[] | undefined;
}

/** Plain `@name` fallbacks are one name query EACH, so they get a small budget. */
export const MAX_NAME_QUERIES = 5;
/** Shorter than this, a token is not a name worth a query. */
const MIN_TOKEN_CHARS = LOOKUP_MIN_CHARS;
// `@` at the start or after whitespace, then the first word of a name.
const TOKEN = /(?:^|\s)@([^\s@<>]+)/g;

/** The first word of every plain `@mention` in a text, lower-cased. */
export function mentionTokens(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(TOKEN)) {
    const t = m[1]?.replace(/[.,;:!?)\]]+$/, '').toLowerCase();
    if (t && t.length >= MIN_TOKEN_CHARS) out.push(t);
  }
  return out;
}

/**
 * Every chat ONE open transcript refers to, NEWEST FIRST (what is on screen is
 * usually the end of the log), bounded by the lookup's caps
 * ({@link LOOKUP_MAX_PANE_IDS} each). exact handles first:
 *
 *   tabIds   a message's `mentions` (the normalizer keeps them when it strips
 *            the context block — shared/chat-events `forDisplay`), a raw
 *            context block (the optimistic echo and queued preview still carry
 *            one), then an inbound message's sender and a directed card's
 *            target as `extraTabIds`, in the order the caller holds them.
 *   paneIds  a report / directive marker, which records the other chat's pane.
 *
 *   names    FALLBACK, for a message with no exact record (written before
 *            references were preserved, or typed with no pick): the first word
 *            of each plain `@token`, at most {@link MAX_NAME_QUERIES}, newest
 *            first — skipped only when the message names a LIVE chat in full.
 *            Answers are kept only for a chat whose FULL name the transcript
 *            mentions ({@link onlyReferenced}).
 *
 * `known` drops what the live corpus already holds.
 */
export function transcriptRefs(
  input: {
    messages: readonly TranscriptMessage[];
    extraTabIds?: readonly string[];
    markerPane?: (text: string) => string | null;
  },
  known: {
    tab: (tabId: string) => boolean;
    pane: (paneId: string) => boolean;
    /** Does this message (lower-cased) already mention a LIVE chat in full,
     *  as `@<its whole name>`, starting with this token? Then the token is
     *  that live chat, and no query is needed. */
    fullLiveName: (token: string, lowerText: string) => boolean;
  },
): { tabIds: string[]; paneIds: string[]; names: string[] } {
  const tabIds: string[] = [];
  const paneIds: string[] = [];
  const names: string[] = [];
  const seenTab = new Set<string>();
  const seenPane = new Set<string>();
  const addTab = (id: string | null | undefined) => {
    if (!id || seenTab.has(id) || known.tab(id) || tabIds.length >= LOOKUP_MAX_PANE_IDS) return;
    seenTab.add(id);
    tabIds.push(id);
  };
  for (let i = input.messages.length - 1; i >= 0; i--) {
    const msg = input.messages[i];
    if (!msg) continue;
    const raw = parseContextRefs(msg.text);
    for (const ref of msg.mentions ?? []) addTab(ref.tabId);
    for (const ref of raw) addTab(ref.tabId);
    const pane = input.markerPane?.(msg.text);
    if (pane && !seenPane.has(pane) && !known.pane(pane) && paneIds.length < LOOKUP_MAX_PANE_IDS) {
      seenPane.add(pane);
      paneIds.push(pane);
    }
    // FALLBACK only for a message with NO exact record — one written before
    // references were preserved, or typed with no pick. An exact reference
    // already says which chat the `@` meant.
    if ((msg.mentions?.length ?? 0) > 0 || raw.length > 0) continue;
    const lower = msg.text.toLowerCase();
    for (const token of mentionTokens(msg.text)) {
      if (names.length >= MAX_NAME_QUERIES) break;
      if (names.includes(token) || known.fullLiveName(token, lower)) continue;
      names.push(token);
    }
  }
  for (const id of input.extraTabIds ?? []) addTab(id);
  return { tabIds, paneIds, names };
}

/**
 * Only the referenced chats, out of whatever the lookup holds: these tab ids
 * and the chats owning these panes, and — for the name fallback — chats whose
 * FULL name appears as `@name` in `nameText`. Anything else the shared cache
 * holds (a search's results, a name query's other matches) is not this
 * transcript's.
 */
export function onlyReferenced<
  G extends { tabs: readonly { id: string; name: string; layout: LayoutNode }[] },
>(
  groups: readonly G[],
  refs: { tabIds: readonly string[]; paneIds: readonly string[]; nameText?: string },
): G[] {
  if (groups.length === 0) return groups as G[];
  const tabs = new Set(refs.tabIds);
  const panes = new Set(refs.paneIds);
  const text = refs.nameText?.toLowerCase() ?? '';
  const out: G[] = [];
  for (const g of groups) {
    const kept = g.tabs.filter(
      (t) =>
        tabs.has(t.id) ||
        collectLayoutLeaves(t.layout).some((p) => panes.has(p)) ||
        // The name fallback: only a chat whose FULL name is mentioned.
        (text !== '' && !!t.name && text.includes(`@${t.name.toLowerCase()}`)),
    );
    if (kept.length > 0) out.push({ ...g, tabs: kept });
  }
  return out;
}
