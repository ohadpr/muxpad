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
