import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';

/**
 * Dictation cleanup for the MOBILE composers.
 *
 * iOS's keyboard mic can't learn vocabulary, so dictating into muxpad produces
 * "Max pad" for muxpad, "crown schedule" for cron schedule, "Ohio" for ohados.
 * The server (POST /api/clean-transcript) rewrites those against a live
 * muxpad-aware glossary; this module is the client half.
 *
 * Two properties are non-negotiable and are why this is a review affordance and
 * not a smarter send button:
 *
 *   1. THE USER SEES THE RESULT BEFORE IT SENDS. Cleaned text goes back into
 *      the composer, full stop. The composer these bars feed reaches an agent
 *      that runs tool calls — a misheard `pane send` is arbitrary shell
 *      execution, so a human reading the text before it leaves is a safety
 *      property, not a nicety. Nothing here calls submit.
 *   2. IT IS ALWAYS REVERSIBLE. The pre-cleanup text is held verbatim and one
 *      tap puts it back, so a mangled rewrite costs a tap rather than a
 *      retyped paragraph.
 *
 * Mobile only by explicit instruction: dictation is a phone problem, and the
 * desktop composer stays as it was.
 */

// ── What changed ────────────────────────────────────────────────────────────

/** One word-level substitution, for the "what did it change" hint. */
export interface Change {
  from: string;
  to: string;
}

/** Split on whitespace, keeping the words only (spacing is reconstructed by the
 *  server's text, not by us — we only need words to diff). */
function words(s: string): string[] {
  return s.split(/\s+/).filter(Boolean);
}

/**
 * The substitutions between two versions of a message, as human-readable pairs.
 *
 * A classic LCS diff, then adjacent delete+insert runs collapsed into one
 * "crown schedule → cron schedule" pair — which is how a mishearing actually
 * reads. Pure and synchronous so it's unit-testable without a DOM.
 *
 * Returns EVERY substitution. Trimming for display is `summarizeChanges`'s job,
 * because it has to say how many it left out — a hint that shows four of nine
 * corrections without saying so undercuts the whole eyeball-it property.
 */
export function describeChanges(before: string, after: string): Change[] {
  const a = words(before);
  const b = words(after);
  // LCS table. Bounded by MAX_TRANSCRIPT_CHARS on the server (2000 chars ⇒ a
  // few hundred words), so the O(n·m) table is small enough to build eagerly.
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const row = lcs[i];
      const next = lcs[i + 1];
      if (!row || !next) continue;
      row[j] = a[i] === b[j] ? (next[j + 1] ?? 0) + 1 : Math.max(next[j] ?? 0, row[j + 1] ?? 0);
    }
  }

  const out: Change[] = [];
  let i = 0;
  let j = 0;
  let removed: string[] = [];
  let added: string[] = [];
  const flush = () => {
    if (removed.length > 0 || added.length > 0) {
      out.push({ from: removed.join(' '), to: added.join(' ') });
      removed = [];
      added = [];
    }
  };
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      flush();
      i++;
      j++;
      continue;
    }
    // Follow the table: whichever side the LCS says to drop from.
    if ((lcs[i + 1]?.[j] ?? 0) >= (lcs[i]?.[j + 1] ?? 0)) {
      removed.push(a[i] as string);
      i++;
    } else {
      added.push(b[j] as string);
      j++;
    }
  }
  while (i < n) removed.push(a[i++] as string);
  while (j < m) added.push(b[j++] as string);
  flush();
  return out;
}

/**
 * A one-line summary of the pairs, for the hint beside the composer.
 *
 * Shows at most `limit` substitutions — the hint is a glance, not a report —
 * and always accounts for the rest, so "four corrections" and "four of nine"
 * never look the same.
 *
 * Pure insertions and deletions have no readable "x → y" form, so they fall
 * back to being counted rather than rendered as an arrow from nothing.
 */
export function summarizeChanges(changes: Change[], limit = 4): string {
  if (changes.length === 0) return 'No changes';
  const named = changes.filter((c) => c.from && c.to).slice(0, limit);
  const rest = changes.length - named.length;
  if (named.length === 0) return rest === 1 ? '1 change' : `${rest} changes`;
  const shown = named.map((c) => `${c.from} → ${c.to}`).join(' · ');
  return rest > 0 ? `${shown} · +${rest} more` : shown;
}

// ── The hook ────────────────────────────────────────────────────────────────

export type CleanupPhase = 'idle' | 'busy' | 'applied' | 'error';

export interface CleanupState {
  phase: CleanupPhase;
  /** Populated in `applied` — the substitutions, for the eyeball-it hint. */
  changes: Change[];
  /** Populated in `error` — shown verbatim so a failure is never silent. */
  message: string;
}

export interface CleanupIo {
  /** Current composer text. */
  read(): string;
  /** Replace the composer text (cleanup result, or the restored original). */
  write(text: string): void;
}

const IDLE: CleanupState = { phase: 'idle', changes: [], message: '' };

/**
 * Drive one composer's cleanup lifecycle.
 *
 * `run()` never writes anything the user can't take back: the pre-cleanup text
 * is captured before the request and `undo()` restores it verbatim. Both the
 * applied and error states are dismissed by `reset()`, which callers wire to
 * "the user typed again" and "the user sent" — a stale "undo" offering to
 * restore text from two messages ago would be a trap.
 */
export function useDictationCleanup(io: CleanupIo) {
  const [state, setState] = useState<CleanupState>(IDLE);
  // The text as it stood before the last successful cleanup. Held in a ref, not
  // state, because undo must restore what was actually replaced even if a
  // re-render raced the request.
  const originalRef = useRef<string | null>(null);
  // Exactly what cleanup last wrote into the composer. `undo` refuses unless
  // the composer still holds it — a backstop against any mutation path that
  // forgot to call `reset()`, so the worst case is a dead button rather than
  // undo overwriting text cleanup never produced.
  const appliedRef = useRef<string | null>(null);
  // Request generation. The model call takes seconds (a cold Agent SDK spawn
  // was measured at ~18s), which is ample time for the user to send the
  // message or keep typing. Anything that invalidates the composed text bumps
  // this, and a resolved request whose generation is stale drops its result on
  // the floor instead of repopulating a composer that has moved on.
  const genRef = useRef(0);
  // The io callbacks are re-created every render by both call sites; pin them
  // so `run` is stable and an in-flight request writes to the live composer.
  const ioRef = useRef(io);
  ioRef.current = io;
  // Guards a resolved request from writing into an unmounted composer.
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const reset = useCallback(() => {
    genRef.current++;
    originalRef.current = null;
    appliedRef.current = null;
    setState((s) => (s.phase === 'idle' ? s : IDLE));
  }, []);

  const run = useCallback(async () => {
    const before = ioRef.current.read();
    if (!before.trim()) return;
    // A second tap, a send, or a keystroke while this is in flight all bump the
    // generation; this call's result is only allowed to land if it is still the
    // current one AND the composer still holds the text it was asked about.
    const gen = ++genRef.current;
    const stale = () =>
      !aliveRef.current || gen !== genRef.current || ioRef.current.read() !== before;
    setState({ phase: 'busy', changes: [], message: '' });
    try {
      const { text, changed } = await api.cleanTranscript(before);
      if (stale()) return;
      if (!changed || text === before) {
        // Nothing to fix is a RESULT, not a no-op — say so rather than leaving
        // the button looking like it did nothing.
        originalRef.current = null;
        appliedRef.current = null;
        setState({ phase: 'applied', changes: [], message: '' });
        return;
      }
      originalRef.current = before;
      appliedRef.current = text;
      ioRef.current.write(text);
      setState({ phase: 'applied', changes: describeChanges(before, text), message: '' });
    } catch (err) {
      if (stale()) return;
      // Loud, specific, and it leaves the composer exactly as the user left it.
      setState({
        phase: 'error',
        changes: [],
        message: err instanceof Error ? err.message : 'cleanup failed',
      });
    }
  }, []);

  const undo = useCallback(() => {
    const original = originalRef.current;
    if (original === null) return;
    // The composer moved on without telling us (a mutation path that skipped
    // `reset`). Restoring here would clobber whatever is in there now, so stand
    // down instead — losing the undo is recoverable, losing the text isn't.
    if (appliedRef.current !== null && ioRef.current.read() !== appliedRef.current) {
      reset();
      return;
    }
    genRef.current++;
    ioRef.current.write(original);
    originalRef.current = null;
    appliedRef.current = null;
    setState(IDLE);
  }, [reset]);

  return {
    state,
    run,
    undo,
    reset,
    /** True only while there is something to restore. */
    canUndo: state.phase === 'applied' && originalRef.current !== null,
  };
}
