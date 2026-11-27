import { useNavigate } from '@tanstack/react-router';
import { useEffect, useId, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { PALETTE_OPEN_EVENT, isMacPlatform } from '../lib/command-palette';
import { tabSlugFromPath } from '../lib/nav-search';
import { noticeFromError } from '../lib/notice-store';
import type { SearchableOutput } from '../lib/output-search';
import { useSearchResultOpener, useSessionSearch } from '../lib/use-session-search';
import { MessageResult, OutputResult, TabResult } from './NavSearch';
import './CommandPalette.css';

/**
 * ⌘K — "find any chat, by name or by what was said in it, and go there."
 *
 * THE ONE SEARCH. The rail used to carry a second, inline box over the same
 * engine (lib/use-session-search); it is now a button that opens this, and so
 * is the mobile sheet's magnifier (lib/command-palette). ⌘K used to focus that
 * box, which meant it did nothing at all on the two layouts where you most
 * need a keyboard route to another chat:
 *
 *   · the desktop rail collapsed or dragged to nothing, and
 *   · mobile, where the field lived behind a glyph inside a sheet.
 *
 * A dialog has no such dependency. It is mounted once in AppLayout, above
 * everything, and it opens the same way from a terminal pane, a chat composer
 * or the workspace picker.
 *
 * The composer case is why ⌘K is NOT gated on "is the user typing": a bare `/`
 * has to be, because it is a character, but a modified chord never reaches the
 * text as input, and "take me elsewhere" is a thing you ask for mid-sentence
 * more often than not.
 */
/** Is this key going INTO a terminal? xterm renders a hidden helper textarea
 *  inside `.xterm`, and that subtree is the only place a raw Ctrl+K has a
 *  meaning of its own (readline's kill-line). */
function isTerminalTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && typeof el.closest === 'function' && !!el.closest('.xterm');
}

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // ⌘K from anywhere, including while typing: a modified chord never reaches
  // the text as input, and "take me elsewhere" is a thing you ask for
  // mid-sentence more often than not.
  //
  // THE PLATFORM SPLIT IS NOT COSMETIC. On macOS the chord is ⌘K, which no
  // terminal wants, so it is taken in the CAPTURE phase — xterm stops
  // propagation on the whole keyboard, and without capture the one shortcut
  // meant to get you out of a terminal would be the one a terminal eats.
  //
  // Off macOS the chord is Ctrl+K, and Ctrl+K is SPOKEN FOR: it is readline's
  // kill-to-end-of-line and the default tmux prefix is a near neighbour. A
  // capture-phase steal there would quietly break line editing in every shell
  // in the app, which is a far worse trade than a shortcut that needs the rail.
  // So on those platforms a focused terminal keeps its key and the palette
  // takes Ctrl+K only from the rest of the page.
  useEffect(() => {
    const isMac = isMacPlatform();
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey) return;
      if (e.key !== 'k' && e.key !== 'K') return;
      if (isMac ? !e.metaKey : !e.ctrlKey || e.metaKey) return;
      if (!isMac && isTerminalTarget(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      setOpen((was) => !was);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  // The BUTTONS — the rail's "Search chats" and the sheet's magnifier (see
  // lib/command-palette). Open, never toggle: a button says "show me search",
  // and a second press on something now under the backdrop cannot happen anyway.
  //
  // flushSync + focus IN the handler, not after a frame, and that is for the
  // phone, where this button is the only way in at all: iOS raises the
  // keyboard only for a focus() made inside the tap that asked for it, and
  // `dispatchEvent` keeps us on that tap's stack. The rAF focus below still
  // runs and is a no-op by then.
  useEffect(() => {
    const onOpen = () => {
      flushSync(() => setOpen(true));
      inputRef.current?.focus();
    };
    window.addEventListener(PALETTE_OPEN_EVENT, onOpen);
    return () => window.removeEventListener(PALETTE_OPEN_EVENT, onOpen);
  }, []);

  if (!open) return null;

  return (
    // The backdrop dismisses on a press OUTSIDE the dialog. It carries no role
    // and is not a tab stop: Escape on the focused field is the keyboard way
    // out, and a reader meeting a clickable div here would only be offered a
    // second, worse one.
    <div className="cmdk-backdrop" onPointerDown={() => setOpen(false)}>
      {/* A real <dialog>, open and non-modal. `showModal()` is what we do NOT
          want: it moves the element to the top layer with its own ::backdrop
          and takes over Escape, which would fight the field's own handler and
          leave the query un-cleared on close. */}
      <dialog
        open={true}
        className="cmdk-dialog"
        aria-label="Find a chat"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <ChatSearch
          inputRef={inputRef}
          autoFocus={true}
          hint={true}
          onDone={() => setOpen(false)}
          onEscape={() => setOpen(false)}
        />
      </dialog>
    </div>
  );
}

/**
 * THE SEARCH ITSELF — the field and its results — without the dialog.
 *
 * Two hosts: the ⌘K dialog above, and the Search tab of the phone's chat list
 * (MobileNav), which is this same component kept mounted under a tab rather
 * than a second search. One engine (lib/use-session-search), one set of rows
 * (NavSearch), one keyboard model.
 */
export function ChatSearch({
  inputRef,
  autoFocus,
  hint,
  cursor: cursorShown = true,
  onDone,
  onEscape,
}: {
  inputRef: React.RefObject<HTMLInputElement>;
  autoFocus: boolean;
  /** The `esc` key cap — meaningful in a dialog, noise in a tab. */
  hint: boolean;
  /**
   * Paint the keyboard cursor. A dialog driven by arrows needs it; a list
   * under a thumb does not — there the first row lit up reads as "you are
   * here". Enter still opens the cursor's row either way.
   */
  cursor?: boolean;
  /** A result was opened. */
  onDone: () => void;
  onEscape: () => void;
}) {
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  // WHERE WE ARE, read from the path rather than the router: this dialog is
  // mounted once above every route and has no matched route of its own to ask.
  // Read during render on purpose — it has to be right on the FIRST paint
  // after opening, and an effect would show the chat you are standing on for
  // one frame and then drop it out from under the cursor.
  const here = tabSlugFromPath(window.location.pathname);
  const {
    tabMatches,
    showingRecents,
    outputRows,
    tabNames,
    messageRows,
    searching,
    active,
    rowCount,
    loadCorpus,
  } = useSessionSearch(query, { exclude: here });
  const navigate = useNavigate();
  const openResult = useSearchResultOpener();

  // Clamp rather than reset: the list shrinks under the cursor whenever a
  // keystroke narrows it, and an out-of-range cursor makes Enter a no-op.
  const safeCursor = rowCount === 0 ? 0 : Math.min(cursor, rowCount - 1);

  // Mounting is the moment to pay for the corpus. The dialog mounts this on
  // every open, which is also what forgets the last question: a palette that
  // reopens showing yesterday's results is one you have to clear first.
  useEffect(() => {
    loadCorpus();
    if (!autoFocus) return;
    // After paint, or the field is not in the document yet to take focus.
    const id = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(id);
  }, [loadCorpus, autoFocus, inputRef]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed to the cursor MOVING, not to the row list identity — re-running on every keystroke would fight the natural scroll position.
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>('[data-cursor="true"]')
      // `?.()`: this now runs on MOUNT too (the dialog mounts it per open),
      // where a DOM without layout — jsdom — has no scrollIntoView.
      ?.scrollIntoView?.({ block: 'nearest' });
  }, [safeCursor]);

  /**
   * GOING TO A THING YOU MADE, and the two kinds go to different places.
   *
   * An APP opens inside muxpad — its own full-screen route, which is also
   * where the logs and the start/stop controls are, so a stopped one lands
   * somewhere that can fix it rather than on a connection error.
   *
   * An ARTIFACT opens in a NEW TAB, because it is a public page and not part
   * of this app: navigating muxpad itself to it would replace the cockpit with
   * a static report and leave the back button as the only way home.
   */
  const openOutput = (output: SearchableOutput) => {
    if (output.kind === 'app') {
      void navigate({ to: '/hosted/a/$slug', params: { slug: output.slug } });
      return;
    }
    if (output.url) window.open(output.url, '_blank', 'noopener,noreferrer');
  };

  /**
   * Tab ID → the chat's NAME, out of the corpus this palette already holds.
   *
   * Resolved HERE rather than on the server, because the server would have to
   * join a name onto every row of a polled listing to answer a question only
   * this one surface asks. An id that resolves to nothing renders as no
   * origin, which is right: a chat that has been deleted is not a place to go
   * back to, and naming it would offer one.
   */
  const originName = (tabId: string | undefined): string | undefined =>
    tabId ? tabNames.get(tabId) : undefined;

  const copyOutput = (output: SearchableOutput) => {
    if (!output.url) return;
    void navigator.clipboard
      .writeText(output.url)
      .catch((err: unknown) => noticeFromError("Couldn't copy the link.", err));
  };

  const openRow = (i: number) => {
    const tabRow = tabMatches[i];
    if (tabRow) {
      openResult(tabRow.tab);
      onDone();
      return;
    }
    const outputRow = outputRows[i - tabMatches.length];
    if (outputRow) {
      openOutput(outputRow.output);
      onDone();
      return;
    }
    const msgRow = messageRows[i - tabMatches.length - outputRows.length];
    if (!msgRow) return;
    openResult(msgRow.tab, { paneId: msgRow.paneId, hit: msgRow.hit, query });
    onDone();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // Mid-composition an IME owns Enter and the arrows (choosing a candidate),
    // and stealing them there makes the field unusable in Japanese/Chinese
    // input — Enter would navigate instead of committing the candidate.
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      onEscape();
      return;
    }
    if (e.key === 'ArrowDown' || (e.key === 'n' && e.ctrlKey)) {
      e.preventDefault();
      if (rowCount > 0) setCursor((c) => (Math.min(c, rowCount - 1) + 1) % rowCount);
      return;
    }
    if (e.key === 'ArrowUp' || (e.key === 'p' && e.ctrlKey)) {
      e.preventDefault();
      if (rowCount > 0) setCursor((c) => (Math.min(c, rowCount - 1) + rowCount - 1) % rowCount);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (rowCount > 0) openRow(safeCursor);
    }
  };

  return (
    <>
      <div className="cmdk-field">
        <svg className="cmdk-field-icon" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.5" />
        </svg>
        <input
          ref={inputRef}
          className="cmdk-input"
          value={query}
          placeholder="Find a chat by name, or search what was said…"
          aria-label="Find a chat"
          role="combobox"
          // EXPANDED whenever there is a list to move through, which now
          // includes the recents shown before anything is typed. Gated on
          // `active` this said "collapsed" over eight live rows.
          aria-expanded={rowCount > 0}
          aria-autocomplete="list"
          // `aria-controls` is required of the role and stated
          // unconditionally, but the ACTIVE DESCENDANT is not — pointing it at a row id that is not in the document is
          // a reader announcing nothing at all.
          aria-controls={listId}
          {...(rowCount > 0 ? { 'aria-activedescendant': `${listId}-r${safeCursor}` } : {})}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          onChange={(e) => {
            setQuery(e.target.value);
            setCursor(0);
          }}
          onKeyDown={onKeyDown}
        />
        {hint && <kbd className="cmdk-hint">esc</kbd>}
      </div>

      <div
        className="cmdk-results"
        id={listId}
        ref={listRef}
        // biome-ignore lint/a11y/useSemanticElements: a <select> cannot host two labelled tiers, a highlighted substring, or a snippet.
        role="listbox"
        tabIndex={-1}
        aria-label="Search results"
        // ─── THE PRESS MUST NOT MOVE FOCUS OFF THE INPUT ─────────────────
        //
        // "Search results don't even respond, can't click them" — on the
        // phone, where the keyboard is up because you just typed the query.
        //
        // A press on a row would otherwise take focus off the combobox (the
        // rows are `tabIndex=-1`, so focus goes to the nearest focusable
        // thing or to the body). On iOS that focus change IS the keyboard
        // dismissing, and the tap is spent doing it instead of picking the
        // row. The dismissal then relayouts the list — the results reserve
        // `--chat-keyboard-inset` at their foot — so the row you aimed at has
        // moved by the time you tap again.
        //
        // Refusing the default here is what every combobox does, and it is
        // the whole reason this never showed on a desktop: there, losing
        // focus costs nothing visible. It does NOT refuse the click; the row
        // still picks, and keyboard navigation keeps working afterwards
        // because the caret never left the field.
        onMouseDown={(e) => e.preventDefault()}
      >
        {/* The placeholder is for an empty query with NOTHING to show — a
            fresh profile with no chats yet. With recents below it, it was a
            paragraph telling you to type over a list you could already
            arrow through. */}
        {!active && !showingRecents && (
          <p className="cmdk-empty">
            Type to find a chat by name, or three characters to search inside messages.
          </p>
        )}
        {showingRecents && (
          <div className="cmdk-divider">
            <span>Recent</span>
          </div>
        )}
        {active && rowCount === 0 && (
          <p className="cmdk-empty">{searching ? 'Searching messages…' : 'No matches.'}</p>
        )}

        {/* The result rows live in NavSearch.tsx, where the rail's old
            inline search drew them too. */}
        {tabMatches.map((m, i) => (
          <TabResult
            key={m.tab.tabId}
            match={m}
            id={`${listId}-r${i}`}
            selected={cursorShown && i === safeCursor}
            onHover={() => setCursor(i)}
            onPick={() => openRow(i)}
          />
        ))}

        {outputRows.length > 0 && (
          <div className="cmdk-divider">
            <span>Artifacts &amp; apps</span>
          </div>
        )}

        {outputRows.map((row, k) => {
          const i = tabMatches.length + k;
          return (
            <OutputResult
              key={`${row.output.kind}:${row.output.slug}`}
              match={row}
              id={`${listId}-r${i}`}
              selected={cursorShown && i === safeCursor}
              onHover={() => setCursor(i)}
              onPick={() => openRow(i)}
              onCopy={() => copyOutput(row.output)}
              {...(originName(row.output.originTab)
                ? { origin: originName(row.output.originTab) }
                : {})}
            />
          );
        })}

        {messageRows.length > 0 && (
          <div className="cmdk-divider">
            <span>In messages</span>
          </div>
        )}

        {messageRows.map((row, k) => {
          const i = tabMatches.length + outputRows.length + k;
          return (
            <MessageResult
              key={`${row.hit.sid}:${row.hit.ts}`}
              row={row}
              id={`${listId}-r${i}`}
              selected={cursorShown && i === safeCursor}
              onHover={() => setCursor(i)}
              onPick={() => openRow(i)}
            />
          );
        })}
      </div>
    </>
  );
}
