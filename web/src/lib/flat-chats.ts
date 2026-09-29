import { type Tab, compareByUserTouch } from '@muxpad/shared';

/**
 * ONE list of every chat in every visible workspace — the navigator's default
 * view, and the only thing in it that is not simply the existing per-workspace
 * list with the workspace header taken off.
 *
 * Pure, and in its own file for the reason `groupChats` is in NavTree's: what
 * this returns decides what you can SEE, and the last time a grouping rule was
 * checked by eye it lost every grandchild in the sidebar (7e4ecfc) — on the
 * phone, which is the device this view is primarily for.
 *
 * ─── THE UNIT IS THE GROUP, NEVER THE ROW ────────────────────────────────────
 * This is the whole design and everything else follows from it.
 *
 * A child row is MEANINGLESS on its own. It draws its state mark inside its
 * parent's mark column and takes one indent step against its parent's leading
 * edge (NavTree.css, pinned by NavTree.spacing.test.ts) — both of which are
 * statements about the row DIRECTLY ABOVE it. Sorted into a global list on its
 * own key, a child would land next to a stranger, and what the user would see
 * is an indented line with a dot under a chat that did not spawn it. That is
 * strictly worse than the bug this codebase already fixed once, because it
 * reads as correct.
 *
 * The two alternatives were considered and both lose something real:
 *
 *   FLATTEN a child to a root — it keeps its position honest and throws away
 *     the only thing the row says beyond its name, which is whose work it is.
 *     It also un-hides delivered sub-chats: forty retired agents would come
 *     back as forty top-level rows, which is the sidebar `groupChats` exists
 *     to prevent.
 *   PROMOTE the parent by its children's keys — a working child would drag its
 *     parent up the list. Tempting, and rejected: it is the machine moving a
 *     row again, which is exactly the churn the recency key was introduced to
 *     get out of this list (see shared/tab-order `userTouchAt`).
 *
 * So a group travels whole, and it ranks on its ROOT's key alone. A child's
 * position is its parent's, entirely — the same rule the per-workspace list
 * already follows, since `groupChats` reads the server's order for tops only
 * and never consults a child's.
 *
 * ─── PARENTAGE IS STILL RESOLVED PER WORKSPACE ───────────────────────────────
 * Each workspace is grouped by `groupChats` on its own tabs, exactly as today,
 * and the results are merged here. A chat whose `spawned_by` points into
 * ANOTHER workspace therefore stays a top-level row, which is what it is today
 * in every surface.
 *
 * Resolving those links globally is now possible — this function is holding
 * every workspace's tabs — and is deliberately not done. It would make the two
 * views disagree about what is a child: the same chat would be a root in
 * 'spaces' and nested in 'recent', on one screen, with no way for the user to
 * know why. Consistency between the two views is worth more than resolving a
 * case the product has never resolved.
 */

/** Just enough of a workspace to render a row and route to it. */
export interface WorkspaceRef {
  id: string;
  slug: string;
  name: string;
}

/**
 * One group's worth of `groupChats` output. Declared structurally rather than
 * imported from NavTree so this module stays a leaf — see `ChatGroup` there for
 * the canonical version and for what `contextOnly` means.
 */
export interface ChatGroupLike {
  chat: Tab;
  children: Tab[];
  contextOnly?: boolean | undefined;
}

/** A group, plus the workspace it came from — which a flat row has to say.
 *
 *  Generic in the workspace so a caller that has the FULL `Workspace` gets it
 *  back intact: the row needs the slug to route and the name to label, but
 *  `TabRow` wants the whole record, and narrowing here would make every caller
 *  look it up again by id. */
export interface FlatChatGroup<W extends WorkspaceRef = WorkspaceRef> {
  workspace: W;
  group: ChatGroupLike;
}

export interface FlatChats<W extends WorkspaceRef = WorkspaceRef> {
  live: FlatChatGroup<W>[];
  done: FlatChatGroup<W>[];
  /** Where the pin block ends in `live` — the same seam `groupChats` reports. */
  livePinned: number;
}

/**
 * Merge every workspace's grouped chats into one ordered list.
 *
 * ─── PINS COME FIRST, GLOBALLY, AND THEY ARE RE-SORTED ───────────────────────
 * Pinning is a deliberate "keep this at the top" act, and a view that silently
 * demoted the rows the user promoted would be taking something away rather than
 * offering an alternative. So the pin block survives the flattening.
 *
 * What CANNOT survive is its manual order. Drag order is stored as `position`
 * WITHIN a workspace, so two workspaces both have a first pinned tab and there
 * is no fact anywhere that says which of them outranks the other. Inventing one
 * (workspace order, say) would present an arrangement the user never made. The
 * pin block is therefore ordered by the same recency key as everything else —
 * pinning still means "always at the top", it just stops meaning "in this exact
 * sequence" once the list spans workspaces. The per-workspace view, where the
 * manual order does exist, is untouched.
 *
 * ─── ONE DONE DRAWER, NOT ONE PER WORKSPACE ──────────────────────────────────
 * Per-workspace drawers would put workspace structure back into the one view
 * whose point is that it has none, and n drawers over three workspaces is more
 * chrome than the rows it hides. Dropping `done` entirely is the other obvious
 * option and is the bug the sheet already shipped once: with nothing filing
 * chats away, every decayed chat and every retired agent stays in the live list
 * forever. So: one drawer, everything in it, same key.
 *
 * `contextOnly` groups ride along unchanged. Their label is the parent's name,
 * which in a flat list is the only thing left saying where the retired workers
 * under it came from — it earns its place here more than it does at home.
 */
export function flattenChats<W extends WorkspaceRef>(
  input: readonly {
    workspace: W;
    live: readonly ChatGroupLike[];
    done: readonly ChatGroupLike[];
  }[],
): FlatChats<W> {
  const live: FlatChatGroup<W>[] = [];
  const done: FlatChatGroup<W>[] = [];
  for (const { workspace, live: liveGroups, done: doneGroups } of input) {
    for (const group of liveGroups) live.push({ workspace, group });
    for (const group of doneGroups) done.push({ workspace, group });
  }
  // The ROOT's key, never a child's — see the file comment.
  const byRoot = (a: FlatChatGroup<W>, b: FlatChatGroup<W>) =>
    compareByUserTouch(a.group.chat, b.group.chat);
  const pinned = live.filter((g) => g.group.chat.pinned).sort(byRoot);
  const rest = live.filter((g) => !g.group.chat.pinned).sort(byRoot);
  return {
    live: [...pinned, ...rest],
    // Most recently touched first, so the chat you just archived is at the top
    // of the drawer you would go looking for it in.
    done: done.sort(byRoot),
    livePinned: pinned.length,
  };
}

/**
 * Does this row need to say which workspace it is in?
 *
 * Only when it is NOT the one the surface already names. A flat row leaves the
 * workspace the sheet's bar (or the rail's tree) is about, so it has to say
 * where it goes — but on the live corpus 28 of 38 live chats are in the ONE
 * workspace you are already in, and a label on those is a word repeated down
 * three quarters of the list saying nothing.
 *
 * It is also a width question, and that is why this is a function rather than
 * a prop the caller works out. The sheet's name cell is 336px of a 390px row;
 * a trailing label can cost up to 84px of it. Charging that to the rows that
 * genuinely change destination, and to no others, is what keeps the label
 * affordable at all.
 */
export function needsWorkspaceLabel(
  row: FlatChatGroup<WorkspaceRef>,
  activeWorkspaceSlug: string,
): boolean {
  return row.workspace.slug !== activeWorkspaceSlug;
}

/** How many CHATS the flat done drawer holds — the number in its header.
 *
 *  The same arithmetic `doneChatCount` does per workspace, and it has to be
 *  the same arithmetic: a `contextOnly` group's parent is a label for a chat
 *  that is still LIVE above, so counting it over-counts, while its retired
 *  sub-chats are real done chats, so counting the group as one under-counts.
 *  The header's number has to be what you find when you open it. */
export function flatDoneCount(rows: readonly FlatChatGroup<WorkspaceRef>[]): number {
  return rows.reduce((n, r) => n + r.group.children.length + (r.group.contextOnly ? 0 : 1), 0);
}
