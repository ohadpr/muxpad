import type { ChatAction } from '@muxpad/shared';
import type { MentionChat } from './chat-mention';

/**
 * WHAT A CHAT HAS GOING ON BESIDE ITSELF — the drawer's two lists.
 *
 * Pure, and separate from the panel that draws them, for the usual reason:
 * what is IN a list decides what you can find, and that is worth testing
 * against three rows rather than against a mounted component.
 *
 * ── WHY THIS IS NOT `groupChats` ─────────────────────────────────────────
 * The sidebar's grouping answers "what should the rail show", and its answer
 * is shaped by that: it flattens arbitrary depth to one level, hides delivered
 * sub-chats behind a second disclosure, and splits live from done because the
 * rail is a place you navigate FROM. The drawer answers a different question —
 * "what did THIS conversation set in motion" — where the complete list is the
 * point and a worker that finished is as interesting as one still going.
 */

/** One row of the sub-chats list. */
export interface SubChat {
  chat: MentionChat;
  /** The pane to mount when this row is opened, or null for a chat whose pane
   *  is gone — the row is still worth showing, it just cannot be opened. */
  paneId: string | null;
}

/**
 * Every chat this one spawned, oldest first.
 *
 * ── ONE HOP, NOT THE WHOLE TREE ──────────────────────────────────────────
 * Deliberately `parentId === me`, where the sidebar resolves to the ROOT. A
 * drawer is read while looking at one conversation, and "what this chat
 * started" is a fact about this chat; a grandchild belongs in ITS parent's
 * drawer, one click away, and flattening the tree here would show a chat work
 * it never asked for.
 *
 * Oldest first, because the list reads as a record of what happened — which is
 * also the order the cards appear in the log it sits beside. Rows with no
 * `createdAt` (a server predating the field) sort last rather than at the
 * epoch, so a missing stamp cannot shove a row to the top of a history.
 */
export function subChatsOf(corpus: readonly MentionChat[], parentTabId: string): SubChat[] {
  if (!parentTabId) return [];
  return corpus
    .filter((c) => c.parentId === parentTabId && c.tabId !== parentTabId)
    .sort(
      (a, b) => (a.createdAt ?? Number.MAX_SAFE_INTEGER) - (b.createdAt ?? Number.MAX_SAFE_INTEGER),
    )
    .map((chat) => ({ chat, paneId: chat.paneIds[0] ?? null }));
}

/**
 * Is this worker still going?
 *
 * `done` is the server's own retirement flag, and a sub-chat retires the
 * moment it delivers — so this is "has it reported", not "is its process
 * alive". That is the question the list is answering, and it is why a crashed
 * worker reads as finished here: it is not coming back, and its card in the
 * log is where the crash is said out loud.
 */
export function subChatIsOpen(s: SubChat): boolean {
  return !s.chat.done;
}

/** One row of the artifacts list. */
export interface ChatArtifact {
  id: string;
  /** `Published weekly-report` — the producer's own line. */
  title: string;
  url: string;
  at: number;
  /** `3 files`, when the producer said. */
  detail: string | null;
}

/**
 * What this chat put on the internet, newest first.
 *
 * Read off the chat's ACTIONS (shared/src/chat-actions.ts) rather than from the
 * publish store, because the publish store has never known who published a
 * slug — it is keyed by slug and so is the expiry file. The action is the only
 * record that ties an artifact to a conversation.
 *
 * Newest first, unlike the sub-chats: an artifact list is a place you go to
 * FETCH a link, and the one you want is almost always the last one you made.
 *
 * A republish under the same name produces a second action with the same url;
 * both are kept. They are two events, the older one is what somebody may
 * already have pasted somewhere, and collapsing them would hide that the thing
 * was updated.
 */
export function artifactsOf(actions: readonly ChatAction[]): ChatArtifact[] {
  return actions
    .filter((a) => a.kind.startsWith('publish.') && !!a.url)
    .map((a) => ({
      id: a.id,
      title: a.title,
      url: a.url as string,
      at: a.at,
      detail: a.detail ?? null,
    }))
    .sort((a, b) => b.at - a.at);
}

/**
 * THE DRAWER'S BLOCKS — the shape a list of twenty workers needs.
 *
 * Reported with a screenshot: twenty-one rows, twenty-one identical dots,
 * and the same four characters of age repeated down the right edge. "No
 * accent, no information architecture, no nothing." All true, and the cause is
 * that every row was drawn as though it carried news when twenty of them
 * carried the same news: finished, a while ago.
 *
 * So the list is grouped, and the groups are the information:
 *
 *   · RUNNING first, and only this block gets the accent — it is the one thing
 *     on screen that is still happening. A mark on every row cannot say
 *     "this one" when every row has it.
 *   · TODAY / YESTERDAY / EARLIER for the rest, each tinted one step cooler
 *     than the last, so the list fades as it ages and you can see which end is
 *     fresh before reading a word.
 *
 * EVERY ROW CARRIES ITS AGE. An earlier pass showed it only in `Earlier`, on
 * the grounds that the heading already said "today" — true, and not what was
 * wanted: "all chats should show how long ago". Within a block the ages still
 * differ, and a list of work is read by when as much as by what.
 *
 * Empty blocks are dropped rather than rendered empty, and a single block is
 * still labelled here — unlike the first attempt at this, where one unlabelled
 * block looked like the old flat list and taught the reader nothing about why
 * the next one would have a heading.
 */
export interface SubChatGroup {
  key: 'running' | 'today' | 'yesterday' | 'earlier';
  label: string;
  /**
   * How strongly this block is tinted — 3 is now, 0 is old.
   *
   * The accent is not decoration here: it is the SECOND rendering of the one
   * fact this panel is about, which is how long ago. A column of sixteen
   * identically tinted marks said "these are all the same thing", which is
   * true and useless; a column that fades down the list says which end is
   * fresh before you have read a word.
   */
  heat: 0 | 1 | 2 | 3;
  subs: SubChat[];
}

const DAY = 86_400_000;

/** Midnight before `now`, in the reader's own timezone — "today" is a calendar
 *  word, and a worker that reported at 23:50 is not "yesterday" at 00:10. */
function startOfDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function subChatGroups(subs: readonly SubChat[], now: number = Date.now()): SubChatGroup[] {
  const midnight = startOfDay(now);
  const running: SubChat[] = [];
  const today: SubChat[] = [];
  const yesterday: SubChat[] = [];
  const earlier: SubChat[] = [];
  for (const s of subs) {
    if (subChatIsOpen(s)) {
      running.push(s);
      continue;
    }
    const at = s.chat.createdAt ?? 0;
    if (at >= midnight) today.push(s);
    else if (at >= midnight - DAY) yesterday.push(s);
    else earlier.push(s);
  }
  // Newest first inside the finished blocks: the answer you want from a worker
  // that has reported is the last one. Running keeps its spawn order so the
  // list does not reshuffle under the cursor as they finish.
  const newest = (a: SubChat, b: SubChat) => (b.chat.createdAt ?? 0) - (a.chat.createdAt ?? 0);
  return (
    [
      { key: 'running', label: 'Running', heat: 3, subs: running },
      { key: 'today', label: 'Today', heat: 2, subs: [...today].sort(newest) },
      { key: 'yesterday', label: 'Yesterday', heat: 1, subs: [...yesterday].sort(newest) },
      { key: 'earlier', label: 'Earlier', heat: 0, subs: [...earlier].sort(newest) },
    ] as SubChatGroup[]
  ).filter((g) => g.subs.length > 0);
}
