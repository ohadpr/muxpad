import { fallbackTabIcon } from '@muxpad/shared';
import { Fragment, type ReactNode } from 'react';
import type { MentionRow } from '../lib/chat-mention';
import { snippetParts, splitHighlight } from '../lib/nav-search';
import { ChatChip, type ChatChipChat, chatTooltip } from './ChatChip';
import './ChatMentionPicker.css';

/**
 * The `@` picker — every chat, live and done, over the composer.
 *
 * Presentational on purpose: it takes rows and a cursor and reports clicks. The
 * grammar (what is a mention, what a mention MEANS) is in lib/chat-mention, and
 * the keyboard lives on the textarea in ChatPane — the field keeps focus
 * throughout and points at the active row through `aria-activedescendant`, which
 * is the same combobox arrangement the sidebar's search box uses. A picker that
 * took focus would break composing mid-sentence, which is the one thing this
 * gesture must not do.
 *
 * TWO TIERS, in the sidebar box's order and for its reasons: names/headlines
 * first, instantly, with no network in the path; then what was actually SAID,
 * from the archive's FTS index, under its own divider and never reordering the
 * rows above it.
 *
 * The second column is the HEADLINE — the machine-written line that used to be
 * the sidebar row's second line. Taking it off the row is what bought the rail
 * its scannability, and this is one of the two places it had to stay reachable
 * (the other is the row's tooltip). Where there is no headline the clock says
 * what it can instead, so the column is never empty for its own sake.
 */
export function ChatMentionPicker({
  rows,
  cursor,
  query,
  listId,
  searching,
  onPick,
  onHover,
}: {
  rows: readonly MentionRow[];
  cursor: number;
  query: string;
  /** Shared with the textarea's `aria-controls`/`aria-activedescendant`. */
  listId: string;
  /** The archive tier is still in flight — only ever shown as a quiet tail. */
  searching: boolean;
  onPick: (row: MentionRow) => void;
  onHover: (index: number) => void;
}) {
  const q = query.trim();
  const firstContent = rows.findIndex((r) => r.via === 'content');
  return (
    // biome-ignore lint/a11y/useSemanticElements: a <select> cannot host two labelled tiers, a chip, a highlighted run and a snippet.
    <div className="chat-mention" id={listId} role="listbox" tabIndex={-1} aria-label="Chats">
      <div className="chat-mention-head" aria-hidden="true">
        {q ? `matching “${q}”` : 'reference, direct, or search'}
      </div>
      {rows.map((row, i) => (
        <Fragment key={row.chat.tabId}>
          {i === firstContent ? (
            <div className="chat-mention-divider" aria-hidden="true">
              In messages
            </div>
          ) : null}
          <Row
            row={row}
            id={`${listId}-${i}`}
            selected={i === cursor}
            onHover={() => onHover(i)}
            onPick={() => onPick(row)}
          />
        </Fragment>
      ))}
      {/* Only ever a tail: the instant rows above are the answer being read,
          and a spinner that replaced them would make typing feel like waiting. */}
      {searching ? <div className="chat-mention-foot">Searching messages…</div> : null}
    </div>
  );
}

function Row({
  row,
  id,
  selected,
  onHover,
  onPick,
}: {
  row: MentionRow;
  id: string;
  selected: boolean;
  onHover: () => void;
  onPick: () => void;
}) {
  const { chat } = row;
  const chip = { ...chat.chip, icon: chat.chip.icon ?? fallbackTabIcon(chat.tabId) };
  return (
    // No keyboard handler here, deliberately: the keyboard path is the
    // composer's own combobox handling (aria-activedescendant), and these rows
    // are never tab stops.
    <div
      className="chat-mention-row"
      id={id}
      // biome-ignore lint/a11y/useSemanticElements: an <option> cannot hold a chip, a highlighted name and a snippet.
      role="option"
      tabIndex={-1}
      aria-selected={selected}
      data-cursor={selected ? 'true' : undefined}
      data-done={chat.done ? 'true' : undefined}
      // Everything the row can't show: the headline when the second column is
      // showing a snippet instead, and always the clock in words.
      title={chatTooltip(chip)}
      // Pointer-DOWN, not click: the composer's textarea must not lose focus to
      // a mousedown on the list before the pick lands, or the caret restore
      // fights the browser's own focus change.
      onPointerDown={(e) => {
        e.preventDefault();
        onPick();
      }}
      onMouseMove={onHover}
    >
      <ChatChip density="row" chat={chip} />
      <span className="chat-mention-name" dir="auto">
        <Highlight text={chat.tabName} range={row.nameRange} />
      </span>
      {/* WHICH WORKSPACE, on every row.
          This list is the one surface that spans them — the sidebar only ever
          shows you one at a time, so a name is unique there and is NOT unique
          here. Searching "main" returns a `Main` from Trayo and a `Main` from
          Trayobot as two identical rows, and the only things distinguishing them
          are an emoji and a headline about whatever they happened to be doing.
          Picking the wrong one directs work to the wrong chat, which is the
          failure this whole grammar is written to avoid.
          Quiet, and before the lifecycle tag: it answers "which of these is the
          one I mean", which you ask before "what state is it in". */}
      <span className="chat-mention-ws">{chat.workspaceName}</span>
      {/* A sub-chat leaves the live list the moment it delivers, so this list is
          one of the two ways back to it — and its name is usually the task
          ("Work review"), not whose task it was. The tag says WHOSE, and for a
          delivered one it says that too: "this row is a result", not something
          you walked away from. Ahead of the headline, and the last thing on the
          row to give up space — the snippet beside it shrinks first. */}
      {provenance(chat) ? <span className="chat-mention-under">{provenance(chat)}</span> : null}
      <span className="chat-mention-why" dir="auto">
        {row.via === 'content' && row.snippet ? (
          snippetParts(row.snippet).map((part, i) =>
            part.hit ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: the parts have no identity of their own and the row is rebuilt per response.
              <mark className="chat-mention-hit" key={i}>
                {part.text}
              </mark>
            ) : (
              // biome-ignore lint/suspicious/noArrayIndexKey: see above.
              <Fragment key={i}>{part.text}</Fragment>
            ),
          )
        ) : (
          <>{chat.headline ?? ''}</>
        )}
      </span>
    </div>
  );
}

/**
 * The tag between a row's name and its headline: where this chat came from, and
 * — when it is over — which of the three ways it got there.
 *
 * `delivered` is the one that earns its space. `decayed` and `archived` both say
 * "you are done with this", which the chip's own dashed outline already says; a
 * delivered sub-chat is a RESULT that has left the live list, and the word is the
 * difference between recognising it and scrolling past it. Empty for an ordinary
 * live chat, which is most of them — nothing is added to the common row.
 */
function provenance(chat: MentionRow['chat']): string {
  const parts: string[] = [];
  if (chat.doneReason === 'delivered') parts.push('delivered');
  if (chat.parentName) parts.push(`under ${chat.parentName}`);
  return parts.join(' · ');
}

/**
 * The inline mention — a chip in running text, from an `@` in a message.
 *
 * A BUTTON, not a decorated span: its whole job is that clicking it takes you
 * to that chat, and a clickable span is a thing only a mouse can use.
 */
export function ChatMentionPill({
  chat,
  onOpen,
}: {
  chat: ChatChipChat & { headline?: string | null };
  onOpen: () => void;
}) {
  return (
    <button type="button" className="chat-mention-pill" title={chatTooltip(chat)} onClick={onOpen}>
      <ChatChip density="chip" chat={chat} />
      {/* The chat's OWN name, not the casing the user happened to type: this is
          a chip standing for a thing, and the thing has a name. The typed text
          is preserved in the message; it is just not what the chip reads. */}
      {chat.name}
    </button>
  );
}

/**
 * The card — a chat, inline in a conversation.
 *
 * Four uses, one container: work you DIRECTED to another chat, the report that
 * comes back, a chat this one SPAWNED, and that worker's report. Same chip, same
 * header, same state slot, so a pair reads as one exchange rather than as two
 * unrelated rows.
 *
 * ─── THE HEAD is the link, and the card is not ────────────────────────────────
 * The whole card used to be one `<button>`. That is the obvious shape for the
 * directed card, which has no body — and it is wrong for the report, whose body
 * is the other agent's answer rendered in full, mentions included. A
 * `ChatMentionPill` is itself a button, so "see @Investing" inside a report put a
 * button inside a button: clicking the pill navigated to Investing and then the
 * click bubbled to the card and navigated straight back, defeating the thing that
 * was clicked. (It is also invalid DOM nesting, which React says out loud.)
 *
 * So the container is inert and the HEAD carries the navigation. Independently
 * clickable content in the body now sits beside that link rather than inside it —
 * and that is also why the state chip and the disclosure are the head's SIBLINGS
 * rather than its children.
 *
 * ─── THE RIGHT-EDGE CLUSTER: state, then disclosure ───────────────────────────
 * `state` is a word for what happened and it sits OUTSIDE the link, which is
 * StateChip's own rule and not a detail: visually-hidden or not, text inside a
 * control joins that control's accessible NAME, so a state in the head would
 * rename the link every time an agent started or stopped ("Work review" → "Work
 * review, delivered").
 *
 * `onToggleExpanded` adds a SECOND control beside it. Expand to read the work
 * here; the head to go there and continue. Both, deliberately: the summary is an
 * index, and an index that can only be followed by leaving the conversation is
 * the thing being complained about.
 */
export function ChatMentionCard({
  chat,
  sub,
  working,
  state,
  tone,
  body,
  work,
  expanded,
  anchorId,
  onToggleExpanded,
  onOpen,
}: {
  chat: ChatChipChat & { headline?: string | null };
  /** One line under the name — the request, when there is no body. */
  sub?: string | undefined;
  /** The other chat is still on it: the same 10px mark as everywhere else. */
  working?: boolean | undefined;
  /** A word for what happened, when nothing is spinning. */
  state?: string | undefined;
  /**
   * Which HUE that word carries — the app's status channel, re-stepped per theme
   * in styles.css, so nothing here names a colour.
   *
   * Absent means `note`: a neutral chip for a word that is an annotation rather
   * than a lifecycle state ("reported", "directed here"). Those must not borrow
   * the green that means a worker finished.
   */
  tone?: 'delivered' | 'done' | 'failed' | 'note' | undefined;
  /** The report itself, rendered in full by the caller (markdown, links…). */
  body?: ReactNode | undefined;
  /**
   * THE WORK the body is a summary of — shown only while `expanded`.
   *
   * Passed in rather than fetched here because it is fetched on demand and cached
   * per child by the conversation (see ChatPane): this component stays
   * presentational, and a card that re-mounted would not re-request anything.
   */
  work?: ReactNode | undefined;
  expanded?: boolean | undefined;
  /**
   * The scroll memory's handle on this row (`data-eid`, see ANCHOR_ATTR) — the
   * same arrangement `ActionGroup` uses.
   *
   * Needed because expanding is a reader-caused height change in the MIDDLE of
   * the document, and the scroll hold measures the row by this id before the
   * commit. Without it the hold silently does nothing and expanding a card above
   * the viewport pulls the text out from under whoever pressed the button.
   */
  anchorId?: string | undefined;
  /** Omitted when there is nothing to expand TO — no control is drawn at all,
   *  rather than one that does nothing when pressed. */
  onToggleExpanded?: (() => void) | undefined;
  /**
   * Where to go. OMITTED when the chat at the other end cannot be resolved —
   * which is a real state (a report from a chat that has since been deleted),
   * and the card still draws, because a name and an answer you can read is a far
   * better degradation than XML. What it must NOT do then is offer a button that
   * does nothing when you press it.
   */
  onOpen?: (() => void) | undefined;
}) {
  const head = (
    <>
      <ChatChip density="card" chat={chat} />
      <span className="chat-mention-card-text">
        <span className="chat-mention-card-name">{chat.name}</span>
        {sub ? (
          <span className="chat-mention-card-sub" dir="auto">
            {sub}
          </span>
        ) : null}
      </span>
    </>
  );
  return (
    <div
      className={`chat-mention-card${body ? ' -report' : ''}`}
      data-expanded={expanded ? 'true' : undefined}
      data-eid={anchorId}
      title={chatTooltip(chat)}
    >
      <div className="chat-mention-card-row">
        {onOpen ? (
          <button type="button" className="chat-mention-card-head" onClick={onOpen}>
            {head}
          </button>
        ) : (
          <div className="chat-mention-card-head">{head}</div>
        )}
        {working ? (
          <span className="chat-mention-card-mark" aria-hidden="true" />
        ) : state ? (
          <span className="chat-mention-card-state" data-state={tone ?? 'note'}>
            {state}
          </span>
        ) : null}
        {onToggleExpanded ? (
          <button
            type="button"
            className="chat-mention-card-more"
            aria-expanded={expanded === true}
            title={expanded ? 'Hide the work' : 'Show the work'}
            onClick={onToggleExpanded}
          >
            {/* The glyph is CSS (a rotating chevron), so the button's accessible
                name is this text and nothing else. */}
            <span className="chat-mention-card-chevron" aria-hidden="true" />
            <span className="chat-mention-card-sr">
              {expanded ? 'Hide the work' : 'Show the work'}
            </span>
          </button>
        ) : null}
      </div>
      {body ? (
        <div className="chat-mention-card-body" dir="auto">
          {body}
        </div>
      ) : null}
      {/* THE SUMMARY STAYS. Expanding adds the work under it rather than
          replacing it — the summary is the line that says where the work is, and
          swapping it out would take that away exactly when it is being used. */}
      {expanded && work ? (
        <div className="chat-mention-card-work" dir="auto">
          {work}
        </div>
      ) : null}
    </div>
  );
}

/** The matched run of the name, bolded in place. Degrades to plain text when
 *  the range no longer fits the string (the tab was renamed under the ranking),
 *  which is `splitHighlight`'s contract — never sliced-apart nonsense. */
function Highlight({
  text,
  range,
}: { text: string; range?: readonly [number, number] | undefined }) {
  const [before, hit, after] = splitHighlight(text, range);
  if (!hit) return <>{text}</>;
  return (
    <>
      {before}
      <mark className="chat-mention-hit">{hit}</mark>
      {after}
    </>
  );
}
