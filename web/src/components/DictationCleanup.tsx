import type { useDictationCleanup } from '../lib/dictation-cleanup';
import { summarizeChanges } from '../lib/dictation-cleanup';
import './DictationCleanup.css';

/**
 * The mobile dictation-cleanup affordance: one button and one hint line,
 * shared by both mobile composers (the terminal bar and the chat pill).
 *
 * ── Why an always-present button rather than one that appears when the text
 *    looks garbled ──────────────────────────────────────────────────────────
 * The tempting design is to surface this only when the composed text fuzzy-
 * matches a known-mangled glossary term. It's the wrong call here, for three
 * reasons:
 *
 *   - The garbled forms are unbounded and unguessable. "Ohio" (ohados), "trio
 *     go to market" (Trayo GTM), "heart effect" (artifact) are all ordinary
 *     English that a phonetic matcher either misses or fires on constantly. A
 *     button that hides exactly when the mishearing was subtle is worse than no
 *     button — the user learns it means "nothing is wrong".
 *   - It can't be learned. An affordance that comes and goes on a rule the user
 *     can't see doesn't become muscle memory, and this one has to: the whole
 *     value is tapping it reflexively after every dictation.
 *   - It costs nothing to show. The request only fires on tap; an unpressed
 *     button is a 36px glyph, not an API call.
 *
 * So: always rendered on mobile, disabled while the composer is empty — a rule
 * that is deterministic, visible, and self-explaining.
 *
 * The button is a REVIEW affordance and never sends. After a cleanup it becomes
 * Undo (one tap restores the pre-cleanup text verbatim) and the hint names what
 * changed, so the correction can be eyeballed rather than trusted.
 */

export type Cleanup = ReturnType<typeof useDictationCleanup>;

/** Which composer this instance is decorating — the two have different visual
 *  grammars (a squared-off key bar vs a round-buttoned pill). */
export type CleanupVariant = 'terminal' | 'chat';

export function CleanupButton({
  cleanup,
  variant,
  hasText,
}: {
  cleanup: Cleanup;
  variant: CleanupVariant;
  hasText: boolean;
}) {
  const { state, run, undo, canUndo } = cleanup;
  const busy = state.phase === 'busy';
  if (canUndo) {
    return (
      <button
        type="button"
        className={`cleanup-btn -${variant} -undo`}
        onClick={undo}
        aria-label="Undo cleanup — restore what I dictated"
        title="Undo cleanup"
        data-testid="cleanup-undo"
      >
        <SvgUndo />
      </button>
    );
  }
  return (
    <button
      type="button"
      className={`cleanup-btn -${variant}`}
      onClick={run}
      // Disabled while empty (nothing to clean) and while in flight (a second
      // tap would race a write into the composer).
      disabled={busy || !hasText}
      aria-busy={busy}
      aria-label="Clean up dictation"
      title="Clean up dictation"
      data-testid="cleanup-run"
    >
      {busy ? <span className="cleanup-spin" aria-hidden="true" /> : <SvgWand />}
    </button>
  );
}

/**
 * The line under/over the composer: what changed, or why it didn't.
 *
 * Renders nothing at rest so it costs no vertical space in the common case.
 * The error branch is `role="alert"`: a cleanup that couldn't run must announce
 * itself, because the failure mode it guards against is the user believing
 * their text was checked when it wasn't.
 */
export function CleanupHint({ cleanup, variant }: { cleanup: Cleanup; variant: CleanupVariant }) {
  const { state } = cleanup;
  if (state.phase === 'error') {
    return (
      <div className={`cleanup-hint -${variant} -error`} role="alert" data-testid="cleanup-hint">
        Couldn’t clean that up — {state.message}
      </div>
    );
  }
  if (state.phase !== 'applied') return null;
  // <output> rather than a div with role="status": same live-region semantics,
  // and it is literally the element for "result of a computation the user asked
  // for". `htmlFor` is deliberately absent — the composers it decorates are a
  // contenteditable and an unlabelled textarea, so there is no id to point at.
  return (
    <output className={`cleanup-hint -${variant}`} data-testid="cleanup-hint">
      {summarizeChanges(state.changes)}
    </output>
  );
}

/** Wand + sparks. Reads as "tidy this up" without borrowing the ✨ that every
 *  other product uses for "the AI wrote it for you" — this one only fixes
 *  words that were already there. */
function SvgWand() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" fill="none">
      <path
        d="m4 20 9.5-9.5M15 5.5 18.5 9"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
      <path
        d="m13 8.5 5.5-5.5M18.5 3 20 4.5 14.5 10"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M6 4v3M4.5 5.5h3M18 15v2.5M16.75 16.25h2.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Curved back-arrow — the same "pull it back" glyph the chat surface uses for
 *  restoring a message to the composer. */
function SvgUndo() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" fill="none">
      <path
        d="M9 5 4.5 9.5 9 14"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M4.5 9.5h9a5.5 5.5 0 0 1 0 11H9"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  );
}
