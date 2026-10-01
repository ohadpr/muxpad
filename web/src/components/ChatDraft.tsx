import { fallbackTabIcon } from '@muxpad/shared';
import {
  type KeyboardEvent as ReactKeyboardEvent,
  forwardRef,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import {
  DRAFT_CHAT_ATTR,
  DRAFT_TOKEN_ATTR,
  type DraftNode,
  caretRange,
  draftChipSignature,
  draftNodes,
  readDraft,
  renderedChipSignature,
} from '../lib/chat-draft';
import type { MentionChat } from '../lib/chat-mention';
import { ChatMentionPill } from './ChatMentionPicker';
import './ChatDraft.css';

/**
 * THE COMPOSER — a string you edit, with the chips already drawn in it.
 *
 * Picking a chat from the `@` picker used to leave the literal text `@Investing`
 * in the composer until you pressed send, at which point the log drew it as a
 * chip. This draws the chip the moment it resolves, with the SAME component the
 * log uses, so what you are composing looks like what you are about to send.
 *
 * Read lib/chat-draft.ts first: it holds the model (the draft is still a plain
 * string), the arithmetic that maps between that string and the DOM, and the
 * reason this is a contenteditable rather than a textarea with an overlay behind
 * it. This file is the three things that cannot be pure — the element, the
 * reconcile, and the portals.
 *
 * ─── REACT DOES NOT OWN THE CHILDREN ─────────────────────────────────────────
 * It must not: the browser edits them, and a React that believes it owns them
 * will fight the caret on every keystroke. So the element is rendered with NO
 * children, and the child list is maintained by the effect below. React still
 * owns the element's own attributes (class, aria, handlers), which is where all
 * the ordinary React-ness lives.
 *
 * The chips are the exception that matters. Each is an EMPTY inert host that the
 * effect puts in the child list, and React renders the real `ChatMentionPill`
 * into it through a portal — so React owns the inside of each host and nothing
 * else. Hand-writing the pill's markup here would have been simpler by about
 * thirty lines and would have forked the chip: four surfaces draw one now
 * (sidebar row, picker row, sent message, this), and ChatChip.tsx's header is
 * explicit that the day they diverge is the day the sidebar stops predicting
 * what a mention looks like.
 *
 * ─── THE DOM IS REBUILT ONLY WHEN THE CHIPS CHANGE ───────────────────────────
 * Rebuilding on every keystroke would work and would be wrong — replacing the
 * children moves the caret, so the browser's editing would be undone and redone
 * under the user, taking IME composition and the native undo stack with it. The
 * reconcile therefore asks one question: do the chips in the DOM match the chips
 * the string asks for? Typing prose never changes that answer, so the common
 * keystroke touches nothing. See `draftChipSignature`.
 */
export interface ChatDraftHandle {
  focus(): void;
  /** The caret, as an offset into the draft string. */
  caret(): number;
  /** Put the caret at an offset into the draft string. */
  setCaret(offset: number): void;
  /**
   * Where the caret goes when `value` NEXT arrives as `text` — said in advance.
   *
   * A value replaced from outside parks the caret at the end (see the
   * reconcile), which is right for a paste and wrong for a mention picked
   * mid-sentence. The alternative a caller reaches for is to replace the value
   * and then `setCaret` a frame later, and that is the bug this exists to
   * remove: it places the caret TWICE, in two different places, and whatever is
   * typed in between lands at the first of them.
   *
   * Keyed by the text it belongs to rather than held as a bare offset, for the
   * same reason `pending` is keyed by its chip list: a hint that missed its
   * commit must be spent, not carried forward onto some later value.
   */
  caretFor(text: string, offset: number): void;
  /** The element, for the callers that measure it (auto-grow, focus checks). */
  el(): HTMLDivElement | null;
}

export interface ChatDraftProps {
  /** The draft. A plain string, exactly as the textarea's `value` was. */
  value: string;
  /** What `@Name` resolves against — the same corpus the log renders with. */
  corpus: readonly MentionChat[];
  placeholder: string;
  className?: string | undefined;
  /** An edit. Both halves, always: the caret is what the `@` grammar keys off. */
  onChange: (text: string, caret: number) => void;
  /** The caret MOVED without an edit — an arrow, a click. Reopens a run. */
  onCaret: (text: string, caret: number) => void;
  onKeyDown?: ((e: ReactKeyboardEvent<HTMLDivElement>) => void) | undefined;
  onPaste?: ((e: React.ClipboardEvent<HTMLDivElement>) => void) | undefined;
  /** Spread onto the element — the combobox attributes while the picker is up. */
  aria?: Record<string, unknown> | undefined;
}

/** A chip in the draft: the host in the child list, and what to draw in it. */
interface DraftChip {
  key: number;
  host: HTMLElement;
  chat: MentionChat;
}

export const ChatDraft = forwardRef<ChatDraftHandle, ChatDraftProps>(function ChatDraft(
  { value, corpus, placeholder, className, onChange, onCaret, onKeyDown, onPaste, aria },
  ref,
) {
  const elRef = useRef<HTMLDivElement | null>(null);
  const [chips, setChips] = useState<DraftChip[]>([]);
  const seq = useRef(0);
  /**
   * The text the DOM last told US it holds.
   *
   * This is how a change the browser already applied is told apart from one that
   * arrived from elsewhere (a paste handler, a restored draft, `setInput('')` on
   * send). The first must not move the caret — the browser has already put it in
   * the right place — and the second must, because there is no caret to keep.
   */
  const echoed = useRef<string | null>(null);
  /** An IME is mid-composition. Touching the DOM during one cancels it. */
  const composing = useRef(false);
  /**
   * A caret waiting for its chips to be DRAWN. See the second effect below.
   *
   * Held with the exact chip list it belongs to, rather than as a bare offset,
   * so the restore can only happen on the commit that drew those chips.
   */
  const pending = useRef<{ chips: DraftChip[]; caret: number; refocus: boolean } | null>(null);
  /**
   * A caret named for a value that has not arrived yet. See `caretFor`.
   *
   * Held with the TEXT it belongs to, so it can only be spent on the commit
   * that value lands in — the same identity discipline as `pending`, one step
   * earlier in the same journey.
   */
  const hinted = useRef<{ text: string; caret: number } | null>(null);

  const readNow = useCallback((): { text: string; caret: number } => {
    const el = elRef.current;
    if (!el) return { text: value, caret: value.length };
    return readDraft(el, window.getSelection());
  }, [value]);

  const place = useCallback((el: HTMLDivElement, offset: number) => {
    const point = caretRange(el, offset);
    const range = document.createRange();
    range.setStart(point.node, point.offset);
    range.collapse(true);
    const sel = window.getSelection();
    if (!sel) return;
    sel.removeAllRanges();
    sel.addRange(range);
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      focus: () => elRef.current?.focus(),
      caret: () => readNow().caret,
      setCaret: (offset: number) => {
        const el = elRef.current;
        if (!el) return;
        el.focus();
        place(el, offset);
      },
      caretFor: (text: string, offset: number) => {
        hinted.current = { text, caret: offset };
      },
      el: () => elRef.current,
    }),
    [readNow, place],
  );

  // ── THE RECONCILE ─────────────────────────────────────────────────────────
  // A layout effect, so a rebuilt child list and its restored caret land in the
  // same frame as the commit that asked for them; in a passive effect the user
  // sees one frame of the caret parked at position 0.
  //
  // `corpus` is a dependency and not an afterthought: it arrives ASYNC (the first
  // `@` pays for it — see ensureCorpus), so the common case for a draft restored
  // from localStorage is text whose chips cannot resolve yet and resolve a
  // moment later. That is a rebuild with the caret held, which is exactly the
  // echoing branch below.
  useLayoutEffect(() => {
    const el = elRef.current;
    if (!el || composing.current) return;
    const nodes = draftNodes(value, corpus);
    const wanted = draftChipSignature(nodes);
    // Is the model merely catching up with an edit the browser already made?
    const echoing = echoed.current === value;
    // A caret this caller named in advance, for exactly this value. Spent here
    // whether or not it is used, so it can never fire on a later commit.
    const hint = hinted.current?.text === value ? hinted.current : null;
    if (hint) hinted.current = null;
    // A hint is an explicit instruction about the caret, so it is honoured even
    // when the child list needs no rebuilding at all — otherwise the one commit
    // it was named for is the one that returns early and ignores it.
    if (!hint && echoing && renderedChipSignature(el) === wanted) return;
    const focused = document.activeElement === el || el.contains(document.activeElement);
    // Where the caret must end up, in three cases and in this order:
    //   NAMED    — the caller said, before the value landed. `pickMention`.
    //   ECHOING  — the browser already moved it; leave it exactly where it is.
    //   OTHERWISE — the value was replaced from outside (a paste, a restored
    //     draft, `setInput('')` on send) and the end is what a textarea does.
    const caret = hint ? hint.caret : echoing && focused ? readNow().caret : value.length;
    const next = build(el, nodes, seq);
    // NOT `place(el, caret)` here — the hosts `build` just put in the child list
    // are still EMPTY. See the effect below.
    //
    // A NAMED caret is placed whether or not the field reads as focused, and
    // takes the focus back if it has gone. `setCaret` — which is what named
    // carets used to go through — called `el.focus()` first, and on iOS that is
    // not ceremony: the pick is a TAP on a picker row, and a tap that lands on
    // the row's button rather than on the field blurs the composer. Without
    // this, the caret the caller asked for would be dropped on exactly the
    // platform this whole hunt is about.
    pending.current = hint
      ? { chips: next, caret, refocus: true }
      : focused
        ? { chips: next, caret, refocus: false }
        : null;
    setChips(next);
    echoed.current = value;
    // No `place` in the deps any more: the reconcile does not touch the
    // selection at all — that is the next effect's whole job.
  }, [value, corpus, readNow]);

  // ── THE CARET GOES BACK ONLY ONCE THE CHIPS ARE DRAWN ─────────────────────
  //
  // THE BUG, measured in WebKit (Safari, and therefore every browser on iOS):
  // restoring the caret above and letting the portals fill the hosts afterwards
  // put the NEXT typed character at offset 0. Type `@Investing` and then a
  // space, and the draft read ` @Investing` — the space at the head of the
  // message, and every character after it too. Chromium is unaffected, which is
  // why this shipped: it was verified there.
  //
  // WHY. A caret beside a chip has no text node to live in, so it is expressed
  // as a position BETWEEN CHILDREN of the editable (see `caretRange`). WebKit
  // keeps its own editing caret as a rendered position rather than as that DOM
  // offset, and re-derives it when the tree under the editable changes — so the
  // portal committing the pill INTO the host invalidated a caret that had been
  // placed one commit too early, and WebKit re-resolved it to the start. The
  // DOM Range still read back as the position we set, so nothing here could
  // notice; only the next keystroke showed it.
  //
  // So the restore waits for the commit that actually draws the chips. `chips`
  // is the identity check and not just the trigger: this must fire on the
  // commit that rendered THESE hosts, never on the one that created them empty.
  // Still a layout effect, and still the same frame — `setChips` above is
  // called from one, so React re-renders synchronously before paint.
  useLayoutEffect(() => {
    const held = pending.current;
    if (!held || held.chips !== chips) return;
    pending.current = null;
    const el = elRef.current;
    if (!el) return;
    if (held.refocus) el.focus();
    place(el, held.caret);
  }, [chips, place]);

  const emit = (fn: (text: string, caret: number) => void) => {
    const st = readNow();
    echoed.current = st.text;
    fn(st.text, st.caret);
  };

  return (
    <>
      <div
        ref={elRef}
        className={`chat-draft${className ? ` ${className}` : ''}${value ? '' : ' is-empty'}`}
        // `plaintext-only` rather than `true`: it gives a paste model that drops
        // formatting without a handler, and it is what MobileInputBar settled on
        // for the same field on iOS. Measured in Chromium that inert chip hosts
        // survive typing, real keyboard input and deletion in this mode exactly
        // as they do under `true`.
        contentEditable="plaintext-only"
        // The children are ours, not React's — see the header. This is the
        // warning that says so out loud.
        suppressContentEditableWarning
        role="textbox"
        tabIndex={0}
        aria-multiline="true"
        aria-label={placeholder}
        data-placeholder={placeholder}
        {...aria}
        onInput={() => emit(onChange)}
        onKeyUp={() => emit(onCaret)}
        onClick={() => emit(onCaret)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        // An IME owns the field between these two. Reconciling in the middle
        // cancels the composition and loses the candidate being chosen, which
        // makes the composer unusable in Japanese and Chinese input.
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={() => {
          composing.current = false;
          emit(onChange);
        }}
        // A newline is a NEWLINE — one `\n` in a text node, with `pre-wrap` to
        // draw it. Left to itself the browser would insert a `<br>` or split the
        // draft into `<div>`s, both of which turn one child list into a tree and
        // make every offset in chat-draft.ts wrong. Shift+Enter (desktop) and
        // Return (mobile) both arrive here.
        onBeforeInput={(e) => {
          const type = (e.nativeEvent as InputEvent).inputType;
          if (type !== 'insertParagraph' && type !== 'insertLineBreak') return;
          e.preventDefault();
          document.execCommand('insertText', false, '\n');
        }}
      />
      {chips.map((chip) =>
        createPortal(
          <ChatMentionPill
            chat={{
              ...chip.chat.chip,
              icon: chip.chat.chip.icon ?? fallbackTabIcon(chip.chat.tabId),
            }}
            // INERT in the composer, and deliberately so: in the log a chip is a
            // link to that chat, but here clicking one must put the caret beside
            // it, not navigate away from a draft you are in the middle of. The
            // host carries `inert`, so this never runs; it is here because the
            // pill's prop is required and a lie would be worse.
            onOpen={() => {}}
          />,
          chip.host,
          String(chip.key),
        ),
      )}
    </>
  );
});

/**
 * Lay out the child list for `nodes`, and hand back the hosts to portal into.
 *
 * One pass, one `replaceChildren`: building into a fragment and swapping it in
 * means the editable is never briefly empty, which is a frame the caret cannot
 * survive.
 */
function build(
  el: HTMLDivElement,
  nodes: readonly DraftNode[],
  seq: { current: number },
): DraftChip[] {
  const chips: DraftChip[] = [];
  const frag = document.createDocumentFragment();
  for (const node of nodes) {
    if (node.kind === 'text') {
      if (node.text) frag.append(document.createTextNode(node.text));
      continue;
    }
    const host = document.createElement('span');
    host.className = 'chat-draft-chip';
    // THREE properties, and each one is load-bearing:
    //   contentEditable=false — the browser treats the chip as one object, so a
    //     single Backspace removes the whole mention rather than eating into a
    //     rendered pill and leaving half a chat's name behind as live text;
    //   inert — it contains a <button>, and neither Tab nor a click may reach
    //     it: the composer is one tab stop and clicking a chip means "put the
    //     caret here";
    //   the token — what this element stands for in the string. Everything in
    //     chat-draft.ts counts characters off this and never off the pill.
    // setAttribute rather than the `contentEditable` IDL property: the property
    // is not reflected everywhere (jsdom does not implement it at all), and this
    // is the one attribute that decides whether a Backspace eats the whole chip
    // or half a chat's name — not a thing to leave to a reflection.
    host.setAttribute('contenteditable', 'false');
    host.setAttribute('inert', '');
    host.setAttribute(DRAFT_TOKEN_ATTR, node.token);
    host.setAttribute(DRAFT_CHAT_ATTR, node.chat.tabId);
    frag.append(host);
    seq.current += 1;
    chips.push({ key: seq.current, host, chat: node.chat });
  }
  el.replaceChildren(frag);
  return chips;
}
