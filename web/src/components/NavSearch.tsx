import { fallbackTabIcon } from '@muxpad/shared';
import { Fragment } from 'react';
import { type TabMatch, snippetParts, splitHighlight } from '../lib/nav-search';
import type { OutputMatch } from '../lib/output-search';
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
          {/* ── AND WHICH MACHINE IT WAS SAID ON ─────────────────────────
              Only for a hit from another one: searching across machines is
              only useful if the answer says where it landed, and a local hit
              carrying "this machine" would be a label on every row of a
              one-machine install. Sits with the chat name, because "where"
              is the same question twice — which chat, and which computer. */}
          {row.hit.host ? <span className="navsearch-row-host"> · {row.hit.host}</span> : null}
        </span>
      </span>
    </div>
  );
}

/**
 * A THING YOU MADE — a hosted app, or a published artifact.
 *
 * Two labels carry everything that is not the name, and both are facts a title
 * cannot imply: whether it is on the open internet or the tailnet only, and
 * whether pressing Enter will actually show it to you. An artifact whose link
 * has lapsed says so and stays in the list, because the bytes are still there
 * and `muxpad publish --extend` revives it — hiding the row would be telling
 * somebody their artifact is gone when it is not.
 *
 * The COPY button is the other half of the point. Half the time the question
 * is not "show me" but "give me the link to send" — which is the question that
 * got asked three times in five days about one games portal.
 */
export function OutputResult({
  match,
  id,
  selected,
  onHover,
  onPick,
  onCopy,
  origin,
}: {
  match: OutputMatch;
  id: string;
  selected: boolean;
  onHover: () => void;
  onPick: () => void;
  onCopy: () => void;
  /** The NAME of the chat that made it, already resolved — the row is handed
   *  a word, not an id to go and look up. Absent for the common case of a
   *  thing made outside a chat, or one whose chat is gone. */
  origin?: string | undefined;
}) {
  const { output, field, range } = match;
  const lapsed = output.kind === 'artifact' && output.expired === true;
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: same combobox keyboard path as the rows above.
    <div
      className="navsearch-row navsearch-row-output"
      id={id}
      // biome-ignore lint/a11y/useSemanticElements: an <option> cannot hold a second line, a chip and a button.
      role="option"
      tabIndex={-1}
      aria-selected={selected}
      data-cursor={selected ? 'true' : undefined}
      data-kind={output.kind}
      onMouseMove={onHover}
      onClick={onPick}
    >
      <span className="navsearch-row-icon" aria-hidden="true">
        {output.kind === 'app' ? '▦' : '◈'}
      </span>
      <span className="navsearch-row-text">
        <span className="navsearch-row-title" dir="auto">
          <Highlight text={output.title} range={field === 'title' ? range : undefined} />
        </span>
        <span className="navsearch-row-sub" dir="auto">
          {/* WHICH KIND, then where it can be reached from. "Artifact ·
              public" and "App · tailnet only" are the same two words the
              Artifacts and Apps pages carry, so a result and its page read
              alike. */}
          <span className="navsearch-row-ws">
            {output.kind === 'app' ? 'App · tailnet only' : 'Artifact · public'}
          </span>
          {lapsed && (
            <>
              <span className="navsearch-row-dot" aria-hidden="true">
                ·
              </span>
              {/* Not styled as an error: an expired link is a link with a
                  shelf life that ran out, which is what every new one has. */}
              <span className="navsearch-row-lapsed">link expired</span>
            </>
          )}
          {field === 'slug' && (
            <>
              <span className="navsearch-row-dot" aria-hidden="true">
                ·
              </span>
              <Highlight text={output.slug} range={range} />
            </>
          )}
          {/* A CWD MATCH SAYS SO. It is the one field that is matched and not
              shown — the path is long and it is not what the thing is called —
              and a row that appeared for a reason the user cannot see reads as
              a wrong result. `tom-romy-surfers` is exactly this case: the
              words are in the directory and nowhere else. */}
          {field === 'cwd' && (
            <>
              <span className="navsearch-row-dot" aria-hidden="true">
                ·
              </span>
              <span className="navsearch-row-why">matched its folder</span>
            </>
          )}
          {/* WHICH CHAT MADE IT. Last on the line, because it is the answer to
              a question you only ask once you have found the thing. Shown as a
              name and not a link: the row's one action is opening the thing
              itself, and a second target in a list driven entirely by the
              keyboard would be a target the keyboard cannot reach. */}
          {origin && (
            <>
              <span className="navsearch-row-dot" aria-hidden="true">
                ·
              </span>
              <span className="navsearch-row-origin">from {origin}</span>
            </>
          )}
        </span>
      </span>
      {output.url && (
        <button
          type="button"
          className="navsearch-row-copy"
          // The row itself opens, so this button must not: a click that both
          // copied and navigated would close the palette on the way to the
          // clipboard.
          onClick={(e) => {
            e.stopPropagation();
            onCopy();
          }}
          title={`Copy ${output.url}`}
          aria-label={`Copy the link to ${output.title}`}
        >
          Copy
        </button>
      )}
    </div>
  );
}
