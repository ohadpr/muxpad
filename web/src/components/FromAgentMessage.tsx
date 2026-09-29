import type { ReactNode } from 'react';
import { useState } from 'react';
import type { MentionChat } from '../lib/chat-mention';
import { ChatMentionCard } from './ChatMentionPicker';

/**
 * How much of the message the COLLAPSED card shows.
 *
 * "Who sent it plus enough of the text to recognise it" — so the preview's job
 * is recognition, not reading. Three lines is what a brief's opening sentence
 * and its first instruction occupy, and on the 390px sheet three lines of
 * 14px prose is roughly a third of the viewport: enough to know which message
 * this is without the card becoming the conversation.
 */
const PREVIEW_LINES = 3;
/** …and a ceiling for a message with no newlines at all, which would otherwise
 *  make "three lines" mean the entire brief. */
const PREVIEW_CHARS = 240;

/**
 * The collapsed preview, and whether there is anything more behind it.
 *
 * Exported for its test: the boundary cases (a message shorter than the
 * preview, a single unbroken paragraph) are where a disclosure control that
 * does nothing when pressed comes from.
 */
export function previewOf(text: string): { preview: string; truncated: boolean } {
  const body = text.trim();
  const lines = body.split('\n');
  let preview = lines.slice(0, PREVIEW_LINES).join('\n');
  if (preview.length > PREVIEW_CHARS) {
    // Cut on a word boundary when there is one nearby, so the preview does not
    // end mid-token — but never search backwards far enough to lose the line.
    const cut = preview.slice(0, PREVIEW_CHARS);
    const space = cut.lastIndexOf(' ');
    preview = space > PREVIEW_CHARS - 40 ? cut.slice(0, space) : cut;
  }
  return { preview, truncated: preview.length < body.length };
}

/**
 * A MESSAGE THAT ARRIVED FROM ANOTHER CHAT.
 *
 * The mirror of the spawn card: that one shows work going OUT of a
 * conversation, this shows work coming IN. `muxpad agent send` delivers a real
 * message — muxpad does not write the agent's transcript, it tails the
 * harness's file — so on the receiving side a coordinator's multi-paragraph
 * brief has rendered as an ordinary user bubble, indistinguishable from
 * something the human typed. This says who it was from.
 *
 * ─── Not a second card component ─────────────────────────────────────────────
 * `ChatMentionCard` already does all of it: a clickable head that goes to the
 * chat at the other end, a state annotation, a disclosure chevron, and a body
 * slot. This is the wrapper that decides what goes in those slots, exactly as
 * `MentionMessage` is for a report.
 *
 * ─── Expanding shows the WHOLE message, with no inner scroller ───────────────
 * The briefs this exists for run to several hundred lines, so "expanded" had to
 * be a choice between a bounded scrolling region and the lot. It is the lot,
 * for the reason already written down next to `.chat-mention-card-work`: a
 * scrolling region inside a scrolling log is a scroll trap — the wheel stops
 * working depending on where the pointer happens to be. The log is the
 * scroller. A reader who expands a 400-line brief asked for 400 lines, and the
 * `.chat-mention-card-body` note makes the same point from the other side: a
 * message that ellipsises is a message you have to go somewhere else to read.
 *
 * ─── The disclosure is per-device and lives here ─────────────────────────────
 * Local state, deliberately: expanding a card is a reader's business on the
 * device in front of them, not a fact about the conversation, so it is neither
 * persisted nor synced. It survives the transcript re-rendering underneath it
 * because the row is keyed by the event id — React reconciles by key, so a
 * poll landing new messages above this one does not remount it and does not
 * collapse it.
 */
export function FromAgentMessage({
  from,
  text,
  render,
  forceOpen,
  onOpen,
}: {
  /**
   * The chat that sent it, when it still resolves — the card's name and its
   * link. Null when the sending chat has since been deleted: the card still
   * draws, because "this came from another chat, and here it is" is true and
   * useful without a name, and a button that does nothing when pressed is not.
   */
  from: MentionChat | null;
  /** The message, exactly as delivered. */
  text: string;
  /** How the caller draws the prose — `UserText`, in the conversation. */
  render: (text: string) => ReactNode;
  /**
   * A SEARCH LANDED IN HERE — open regardless of what the reader last chose.
   *
   * The archive indexes the whole message, so a search can legitimately land in
   * the part the preview cuts off, and the rule the action fold already follows
   * applies unchanged: a highlight nobody can see is the same as no highlight.
   * Deliberately NOT written into the disclosure state, so the card snaps back
   * the moment the highlight is dismissed rather than leaving the log
   * rearranged — see ActionGroup's `holdsHit`.
   */
  forceOpen?: boolean | undefined;
  onOpen?: (() => void) | undefined;
}) {
  const [open, setOpen] = useState(false);
  const expanded = open || forceOpen === true;
  const { preview, truncated } = previewOf(text);
  return (
    <ChatMentionCard
      chat={from?.chip ?? { name: 'another chat' }}
      // AN ANNOTATION, not a lifecycle state — so it keeps its word rather than
      // becoming a tick. "sent this" is what the card is claiming, and it is
      // the same grammar as the `reported` / `directed here` beside it.
      state="sent this"
      tone="note"
      body={render(expanded ? text.trim() : preview)}
      expanded={expanded}
      // NO CONTROL WHEN THERE IS NOTHING BEHIND IT. A short message is already
      // shown in full, and a chevron over it would be a control that does
      // nothing when pressed.
      {...(truncated ? { onToggleExpanded: () => setOpen((v) => !v) } : {})}
      {...(onOpen ? { onOpen } : {})}
    />
  );
}
