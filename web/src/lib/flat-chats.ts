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

/** Invisible characters: the bidi marks and embeddings, and the zero-width
 *  spaces. `\s` covers U+FEFF and the exotic blanks but stops at U+200A, one
 *  code point short of the zero-width space, so not one of these counts as
 *  whitespace as far as a regex is concerned. */
const INVISIBLE = /[\u200B-\u200F\u061C\u2066-\u2069]/g;

/**
 * A chat's name as a HUMAN sees it, reduced to a key two rows compare on.
 *
 * Case is folded because 'Main' and 'main' are the same word on a screen, and
 * whitespace is collapsed because a trailing space is not a distinction anyone
 * can point at. Both use the locale-INDEPENDENT operations deliberately:
 * `toLocaleLowerCase` would hand the browser's locale a say in whether two rows
 * collide — under tr-TR it lowercases 'I' to 'ı' — so one list would label
 * differently on a phone than on the laptop beside it.
 *
 * NFC first, and the invisible characters dropped, because this list holds
 * Hebrew names: a name typed in place and a name pasted from elsewhere can be
 * the same glyphs built from different code points (U+FB2E is alef-with-patah
 * as one character; U+05D0 U+05B7 is the letter plus its mark), and pasted
 * text routinely carries bidi marks that draw nothing at all. Anything the eye
 * cannot see must not decide what the eye is told.
 */
export function displayedNameKey(name: string): string {
  return name.normalize('NFC').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Does this row need to say which workspace it is in?
 *
 * Two things earn the label, and nothing else does:
 *
 *   IT LEAVES     the workspace the surface already names — the sheet's bar, or
 *                 the rail's tree — so it has to say where it goes.
 *   IT COLLIDES   with a row of ANOTHER workspace under the same displayed
 *                 name, so without the label the list shows two rows called
 *                 'Main' and nothing anywhere saying which is which.
 *
 * The first rule alone shipped, and the second exists because of how it failed:
 * a row in the workspace you were already in was never labelled, so an
 * ambiguous pair came out HALF labelled — 'Main · TRAYO' above a bare 'Main'.
 * An unlabelled unique row reads as clean; one labelled row beside an identical
 * bare one reads as a rendering fault.
 *
 * ─── THE BUDGET IS UNCHANGED, IT IS JUST SPENT WHERE IT DOES WORK ────────────
 * Labelling every row was never on the table. On the live corpus 28 of 38 live
 * chats are in the ONE workspace you are already in, and a label on those is a
 * word repeated down three quarters of the list saying nothing. It is also a
 * width question, and that is why this is a function rather than a prop the
 * caller works out: the sheet's name cell is 336px of a 390px row and a
 * trailing label can cost up to 84px of it. Charging that only to the rows it
 * tells something is what keeps the label affordable at all. Collisions are
 * rare, so the second rule spends a handful of what the first rule saved.
 *
 * ─── A COLLISION HAS TO CROSS A WORKSPACE, OR THE LABEL SAYS NOTHING ─────────
 * Two chats both called 'Main' both in 'personal' are not helped by writing
 * PERSONAL on both: the user still cannot tell them apart, and the two rows
 * that were merely ambiguous are now ambiguous AND 84px narrower. So the
 * colliding row must be in a DIFFERENT workspace — which makes the promise
 * exact, since any two rows here that share a name then differ in their label.
 *
 * ─── PER RENDERED LIST; THE DRAWER IS A DIFFERENT LIST ───────────────────────
 * `list` is the array this row is rendered from — the live list or the done
 * drawer, never the two concatenated. The drawer is collapsed by default, so
 * counting across that seam would make a live row sprout a label when you open
 * the drawer and drop it when you close it. A label coming and going on a row
 * that nothing happened to is worse than the ambiguity it resolves.
 *
 * ─── THE SET COMPARED IS THE SET LABELLED ────────────────────────────────────
 * Only top-level rows of real groups are candidates, because only those can
 * carry a label: the caller exempts children, and a `contextOnly` group's root
 * is drawn as a heading over someone's retired workers rather than as a row. If
 * a name that can never be labelled could cause a label, the asymmetry this
 * function exists to remove would come straight back in a new shape. A child
 * needs nothing of its own — it sits directly under its parent, which is the
 * row that says where the pair lives, and repeating the word on the indented
 * line would put it on two adjacent rows.
 *
 * O(n) per row over a list the size of a sidebar (38 rows on the live corpus),
 * and it stops at the first collision.
 */
export function needsWorkspaceLabel(
  row: FlatChatGroup<WorkspaceRef>,
  activeWorkspaceSlug: string,
  list: readonly FlatChatGroup<WorkspaceRef>[],
): boolean {
  // A heading, not a row — it has no label to carry, in either direction. The
  // caller draws these as a plain `<div>` and never asks, and saying `true`
  // here anyway would leave a trap for the next caller that does.
  if (row.group.contextOnly) return false;
  if (row.workspace.slug !== activeWorkspaceSlug) return true;
  const name = displayedNameKey(row.group.chat.name);
  // A different workspace is also, necessarily, a different row — so there is
  // no identity check to get wrong here.
  return list.some(
    (other) =>
      !other.group.contextOnly &&
      other.workspace.slug !== row.workspace.slug &&
      displayedNameKey(other.group.chat.name) === name,
  );
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
