import { type MentionChat, type MentionSegment, parseMentions } from './chat-mention';

/**
 * THE LIVE DRAFT — a string the user edits, drawn with chips in it.
 *
 * The composer used to be a `<textarea>`, so a mention you had just picked sat
 * there as the literal characters `@Investing` until you sent the message, at
 * which point the log drew it as a chip. Two renderings of one thing, and the
 * one you were looking at while composing was the lesser of them.
 *
 * ─── WHY THE COMPOSER IS A contenteditable, AND NOT A MIRRORED OVERLAY ───────
 * The obvious cheap fix is to leave the textarea alone, make it transparent, and
 * draw the chips in an absolutely-positioned div behind it that renders the same
 * string. It cannot work, and the reason is not fiddliness — it is arithmetic.
 * A chip is WIDER than the `@Investing` it stands for: it carries a 16px tile, a
 * gap, a border and 13px of padding. So the overlay lays the line out to a
 * different width than the textarea does, wraps in a different place, and the
 * caret — which is the textarea's, positioned by the textarea's own layout of
 * the raw text — lands somewhere other than where the glyph the user is looking
 * at actually is. Every keystroke past the first chip drifts. A composer may be
 * many things, but it may not lie about where the caret is.
 *
 * A contenteditable has ONE layout. The chip is in the flow, so its extra width
 * is the browser's problem, wrapping is correct by construction, and the caret is
 * the browser's own. The cost is that we no longer get `value`/`selectionStart`
 * for free, which is what this module is: the arithmetic that puts them back.
 *
 * MobileInputBar.tsx made the same call for a different reason, and its note is
 * worth reading — iOS attaches its keyboard accessory bar only to real form
 * controls, so a contenteditable comes up clean. The two reasons point the same
 * way, which is the strongest evidence either of them could have.
 *
 * ─── THE MODEL IS STILL A STRING ──────────────────────────────────────────────
 * `input` in ChatPane stays a plain `string`, and everything built on it —
 * `parseDirective`, `repinPicks`, the draft in localStorage, the send path, the
 * `@` grammar's offsets — is untouched. The DOM is a PROJECTION of that string,
 * and this module is the two functions that make the projection reversible:
 * `readDraft` (DOM → string + caret) and `draftNodes`/`caretRange` (string →
 * DOM). Nothing here knows about React.
 *
 * ─── AND THE CHIPS ARE THE SAME COMPONENT THE LOG DRAWS ───────────────────────
 * A chip in the draft is an empty inert host element; `ChatDraft` portals the
 * real `ChatMentionPill` into it. So there is ONE chip implementation across the
 * sidebar row, the picker, the sent message and now the composer — which is the
 * invariant ChatChip.tsx's header asks for, and the thing hand-written chip
 * markup in the composer would have quietly broken.
 */

/** What the editable holds, in order: runs of prose and inert mention hosts. */
export type DraftNode =
  | { kind: 'text'; text: string }
  | { kind: 'mention'; token: string; chat: MentionChat };

/**
 * The two attributes a mention host carries.
 *
 * The TOKEN is what the host stands for in the string — verbatim as the user
 * typed it, casing and all, because the string is theirs and the renderer does
 * not get to rewrite it. The CHAT is which chat it resolved to, and it is here
 * for one reason: two chats can share a name, so a rebuild has to be able to
 * tell "the same token now pointing at a different chat" from "no change", and
 * the token alone cannot.
 */
export const DRAFT_TOKEN_ATTR = 'data-draft-token';
export const DRAFT_CHAT_ATTR = 'data-draft-chat';

/**
 * The draft's nodes, by the SAME rule the log renders a sent message by.
 *
 * `parseMentions` and nothing else, deliberately: the whole point of drawing
 * chips while composing is that the draft predicts the message. A second rule
 * here — "only chips the picker inserted", say — is how `@Investing` comes to
 * mean one thing in the composer and another in the log.
 */
export function draftNodes(text: string, corpus: readonly MentionChat[]): DraftNode[] {
  return parseMentions(text, corpus).map(toDraftNode);
}

const toDraftNode = (seg: MentionSegment): DraftNode =>
  seg.kind === 'mention'
    ? { kind: 'mention', token: seg.text, chat: seg.chat }
    : { kind: 'text', text: seg.text };

/**
 * The chips a set of nodes asks for, in order — the ONE thing a rebuild is
 * decided by.
 *
 * Reconciling the DOM on every keystroke would work and would also be wrong:
 * replacing the children moves the caret, so the browser's own editing (which
 * has already put the character in the right place) would be undone and redone
 * under the user forty times a second, taking IME composition and the native
 * undo stack with it. So the DOM is left ALONE while the chips in it still match
 * the chips the string asks for, and is rebuilt only when that changes — which
 * is once per mention appearing or disappearing, not once per character.
 */
export function draftChipSignature(nodes: readonly DraftNode[]): string {
  return (
    nodes
      .filter((n): n is DraftNode & { kind: 'mention' } => n.kind === 'mention')
      // JSON rather than a delimiter: a tabId is a slug and a token is whatever
      // the user typed, so there is no character that is safely not in either.
      .map((n) => JSON.stringify([n.chat.tabId, n.token]))
      .join('')
  );
}

/** The same signature, read off the DOM as it stands. */
export function renderedChipSignature(el: HTMLElement): string {
  return [...el.childNodes]
    .filter(isMentionHost)
    .map((h) =>
      JSON.stringify([
        h.getAttribute(DRAFT_CHAT_ATTR) ?? '',
        h.getAttribute(DRAFT_TOKEN_ATTR) ?? '',
      ]),
    )
    .join('');
}

/** A mention host — an inert element standing for one `@Name` in the string. */
function isMentionHost(n: Node): n is HTMLElement {
  return n.nodeType === Node.ELEMENT_NODE && (n as HTMLElement).hasAttribute(DRAFT_TOKEN_ATTR);
}

/**
 * How many characters of the string a single child of the editable stands for.
 *
 * A mention host stands for its whole token even though it contains a rendered
 * pill whose text ("📈 Investing") is not the token at all — which is exactly
 * why the token is an attribute rather than something read back out of the
 * chip's own text. Rename the chat, restyle the pill, translate the emoji: the
 * string is unaffected.
 */
function lengthOf(n: ChildNode): number {
  if (n.nodeType === Node.TEXT_NODE) return (n as Text).data.length;
  if (isMentionHost(n)) return (n.getAttribute(DRAFT_TOKEN_ATTR) ?? '').length;
  // A `<br>` the browser left behind. See readDraft for the trailing-`<br>`
  // case, which is the one that must NOT count.
  if (n.nodeName === 'BR') return 1;
  return (n.textContent ?? '').length;
}

/**
 * Is this the bogus trailing `<br>` browsers keep in an editable?
 *
 * An empty contenteditable, and the end of one whose last character is a
 * newline, both get a `<br>` that is scaffolding rather than content — counting
 * it appends a newline the user never typed, and on an empty composer it makes
 * the draft `"\n"`, which is not empty, which re-enables the send button on a
 * blank message.
 */
function isTrailingBr(n: ChildNode, i: number, all: readonly ChildNode[]): boolean {
  return n.nodeName === 'BR' && i === all.length - 1;
}

/** The string the editable currently holds. */
export function readDraftText(el: HTMLElement): string {
  const kids = [...el.childNodes];
  return kids
    .map((n, i) => {
      if (isTrailingBr(n, i, kids)) return '';
      if (n.nodeType === Node.TEXT_NODE) return (n as Text).data;
      if (isMentionHost(n)) return n.getAttribute(DRAFT_TOKEN_ATTR) ?? '';
      if (n.nodeName === 'BR') return '\n';
      return n.textContent ?? '';
    })
    .join('');
}

/**
 * Where a DOM position sits in the string.
 *
 * `node`/`offset` is a Selection's anchor or focus, so it can be any of three
 * things: a position inside a text node, a CHILD INDEX in the editable itself
 * (which is what the browser reports with the caret beside a chip), or a
 * position somewhere inside a chip's rendered pill (a click on the emoji).
 *
 * The third is the one with a judgement in it: a chip is ATOMIC, so there is no
 * such thing as a caret three characters into it. Such a position resolves to
 * the chip's far edge — the near edge if the position is in its first half — so
 * clicking a chip puts the caret beside it rather than silently snapping to the
 * start of the line.
 */
export function offsetOf(el: HTMLElement, node: Node, offset: number): number {
  const kids = [...el.childNodes];
  if (node === el) {
    // A child index. Everything before it counts; the child at the index does not.
    return kids
      .slice(0, offset)
      .reduce((n, k, i) => n + (isTrailingBr(k, i, kids) ? 0 : lengthOf(k)), 0);
  }
  let seen = 0;
  for (const [i, kid] of kids.entries()) {
    const len = isTrailingBr(kid, i, kids) ? 0 : lengthOf(kid);
    if (kid === node) {
      return seen + (kid.nodeType === Node.TEXT_NODE ? Math.min(offset, len) : 0);
    }
    if (kid.contains(node)) {
      // Inside a chip. Atomic, so: the near edge or the far one, never inside.
      return seen + (isMentionHost(kid) ? len : Math.min(offset, len));
    }
    seen += len;
  }
  // A node that is not in this editable at all — the honest answer is the end,
  // which is where a browser puts the caret when it has nowhere better.
  return seen;
}

/** A DOM position for an offset into the string — `null` when the offset is
 *  outside it, which the caller should read as "leave the selection alone". */
export interface DraftPoint {
  node: Node;
  offset: number;
}

/**
 * The DOM position for an offset into the string.
 *
 * PREFERS A TEXT NODE, and that preference is the whole subtlety. An offset at a
 * chip's trailing edge can be expressed two ways — "after child 1" or "at index
 * 0 of the text node that follows it" — and only the second gives the browser a
 * text node to put the caret in, which is what makes the next typed character
 * land beside the chip instead of nowhere. An offset INSIDE a chip's token
 * cannot be honoured at all, so it lands at the chip's end.
 */
export function caretRange(el: HTMLElement, offset: number): DraftPoint {
  const kids = [...el.childNodes];
  const want = Math.max(0, offset);
  let seen = 0;
  for (const [i, kid] of kids.entries()) {
    const len = isTrailingBr(kid, i, kids) ? 0 : lengthOf(kid);
    if (kid.nodeType === Node.TEXT_NODE && want <= seen + len) {
      return { node: kid, offset: want - seen };
    }
    if (want < seen + len) {
      // Inside a chip (or a stray element). Snap to whichever edge is nearer,
      // expressed as a child index of the editable.
      return { node: el, offset: want - seen <= len / 2 ? i : i + 1 };
    }
    if (want === seen + len) {
      // Exactly at this child's end. If prose follows, start of that — see above.
      const next = kids[i + 1];
      if (next?.nodeType === Node.TEXT_NODE) return { node: next, offset: 0 };
      return { node: el, offset: i + 1 };
    }
    seen += len;
  }
  // Past the end, or an empty editable.
  return { node: el, offset: kids.length };
}

/** What the composer reports on every edit: the string, and where the caret is. */
export interface DraftState {
  text: string;
  caret: number;
}

/**
 * The editable's current state, read through the live Selection.
 *
 * A caret OUTSIDE this editable (the field is not focused, another pane has the
 * selection) reports the end of the string rather than 0: "I do not know where
 * the caret is" must not read as "the caret is at the start", which would open
 * the `@` picker over a mention at the head of a draft nobody is editing.
 */
export function readDraft(el: HTMLElement, sel: Selection | null): DraftState {
  const text = readDraftText(el);
  const node = sel?.focusNode ?? null;
  const inside = node !== null && (node === el || el.contains(node));
  return {
    text,
    caret: inside ? offsetOf(el, node, sel?.focusOffset ?? 0) : text.length,
  };
}
