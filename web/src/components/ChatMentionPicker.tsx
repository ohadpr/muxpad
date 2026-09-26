import { fallbackTabIcon } from '@muxpad/shared';
import { Fragment, type ReactNode } from 'react';
import type { MentionRow } from '../lib/chat-mention';
import { snippetParts, splitHighlight } from '../lib/nav-search';
import { type ChatChipChat, ChatChip, chatTooltip } from './ChatChip';
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
    // biome-ignore lint/a11y/useKeyWithClickEvents: the keyboard path is the composer's own combobox handling (aria-activedescendant); these rows are never tab stops.
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
 * Two uses, one container: work you DIRECTED to another chat (with the request
 * as its second line and the state slot spinning), and the report that comes
 * back (with the other agent's answer as the body). Same chip, same header, so
 * the pair reads as one exchange rather than as two unrelated rows.
 */
export function ChatMentionCard({
  chat,
  sub,
  working,
  state,
  body,
  onOpen,
}: {
  chat: ChatChipChat & { headline?: string | null };
  /** One line under the name — the request, when there is no body. */
  sub?: string | undefined;
  /** The other chat is still on it: the same 10px mark as everywhere else. */
  working?: boolean | undefined;
  /** A word for what happened, when nothing is spinning. */
  state?: string | undefined;
  /** The report itself, rendered in full by the caller (markdown, links…). */
  body?: ReactNode | undefined;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      className={`chat-mention-card${body ? ' -report' : ''}`}
      title={chatTooltip(chat)}
      onClick={onOpen}
    >
      <span className="chat-mention-card-head">
        <ChatChip density="card" chat={chat} />
        <span className="chat-mention-card-text">
          <span className="chat-mention-card-name">{chat.name}</span>
          {sub ? (
            <span className="chat-mention-card-sub" dir="auto">
              {sub}
            </span>
          ) : null}
        </span>
        {working ? (
          <span className="chat-mention-card-mark" aria-hidden="true" />
        ) : state ? (
          <span className="chat-mention-card-state">{state}</span>
        ) : null}
      </span>
      {body ? (
        <span className="chat-mention-card-body" dir="auto">
          {body}
        </span>
      ) : null}
    </button>
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
