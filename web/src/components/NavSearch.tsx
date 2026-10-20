import { fallbackTabIcon } from '@muxpad/shared';
import { Fragment } from 'react';
import { type TabMatch, snippetParts, splitHighlight } from '../lib/nav-search';
import type { MessageRow } from '../lib/use-session-search';
import './NavSearch.css';

/**
 * The search RESULT ROWS — a chat matched by name/headline/workspace, and a
 * message matched in the archive. Rendered by the ⌘K palette
 * (components/CommandPalette), the one search surface.
 *
 * The rail used to host a second, inline search box here that swapped the tree
 * for these rows; it became a button that opens the palette, and the box, its
 * query state and its `/` shortcut went with it. The rows stayed because they
 * are the palette's, and the `navsearch-` class namespace stayed with them
 * rather than churn every selector that styles them.
 */

/** The matched run, bolded in place. `splitHighlight` degrades to plain text
 *  when the range no longer fits the string (a poll renamed the tab between
 *  the ranking and this render), so this can never slice mid-word garbage. */
function Highlight({
  text,
  range,
}: { text: string; range?: readonly [number, number] | undefined }) {
  const [before, hit, after] = splitHighlight(text, range);
  if (!hit) return <>{text}</>;
  return (
    <>
      {before}
      <mark className="navsearch-hit">{hit}</mark>
      {after}
    </>
  );
}

export function TabResult({
  match,
  id,
  selected,
  onHover,
  onPick,
}: {
  match: TabMatch;
  id: string;
  selected: boolean;
  onHover: () => void;
  onPick: () => void;
}) {
  const { tab, field, range } = match;
  // Second line: where it lives, then what it is about. The headline is the
  // same one-liner the tree's rows carry, so a result and its row read alike.
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the keyboard path is the combobox above (aria-activedescendant); these rows are never tab stops.
    <div
      className="navsearch-row"
      id={id}
      // biome-ignore lint/a11y/useSemanticElements: an <option> cannot hold two lines, an icon and a highlighted run.
      role="option"
      tabIndex={-1}
      aria-selected={selected}
      data-cursor={selected ? 'true' : undefined}
      onMouseMove={onHover}
      onClick={onPick}
    >
      <span className="navsearch-row-icon" aria-hidden="true">
        {tab.icon ?? fallbackTabIcon(tab.tabId)}
      </span>
      <span className="navsearch-row-text">
        <span className="navsearch-row-title" dir="auto">
          <Highlight text={tab.tabName} range={field === 'name' ? range : undefined} />
        </span>
        <span className="navsearch-row-sub" dir="auto">
          <span className="navsearch-row-ws">
            <Highlight text={tab.workspaceName} range={field === 'workspace' ? range : undefined} />
          </span>
          {tab.headline ? (
            <>
              <span className="navsearch-row-dot" aria-hidden="true">
                ·
              </span>
              <Highlight text={tab.headline} range={field === 'headline' ? range : undefined} />
            </>
          ) : null}
        </span>
      </span>
      {/* Status as a bare dot, not a StateChip: the chip carries
          visually-hidden words, and inside an `option` those join the row's
          ACCESSIBLE NAME — the exact mistake NavTree's pane rows made once.
          A dot says "this one is blocked" to the eye and nothing to the
          screen reader, which is the right split for a transient list. */}
      {tab.status && tab.status !== 'idle' ? (
        <span className="navsearch-row-state" data-state={tab.status} aria-hidden="true" />
      ) : null}
    </div>
  );
}

export function MessageResult({
  row,
  id,
  selected,
  onHover,
  onPick,
}: {
  row: MessageRow;
  id: string;
  selected: boolean;
  onHover: () => void;
  onPick: () => void;
}) {
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: same combobox keyboard path as the tab rows above.
    <div
      className="navsearch-row navsearch-row-message"
      id={id}
      // biome-ignore lint/a11y/useSemanticElements: same two-line row shape as TabResult.
      role="option"
      tabIndex={-1}
      aria-selected={selected}
      data-cursor={selected ? 'true' : undefined}
      onMouseMove={onHover}
      onClick={onPick}
    >
      <span className="navsearch-row-icon" aria-hidden="true">
        {row.tab.icon ?? fallbackTabIcon(row.tab.tabId)}
      </span>
      <span className="navsearch-row-text">
        {/* The SNIPPET leads, because it is the thing you recognised; the chat
            it came from is the answer to "where", and goes underneath. FTS5
            already marked the matched terms in it (see snippetParts). */}
        <span className="navsearch-row-snippet" dir="auto">
          {snippetParts(row.hit.snippet).map((part, i) =>
            part.hit ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: the parts have no identity of their own and the whole row is rebuilt per response.
              <mark className="navsearch-hit" key={i}>
                {part.text}
              </mark>
            ) : (
              // biome-ignore lint/suspicious/noArrayIndexKey: see above.
              <Fragment key={i}>{part.text}</Fragment>
            ),
          )}
        </span>
        <span className="navsearch-row-sub" dir="auto">
          {row.tab.tabName}
        </span>
      </span>
    </div>
  );
}
