/**
 * WHICH WORKING INDICATOR YOU GET THIS TURN.
 *
 * There are ten, and you see a different one each turn rather than the same one
 * forever. The point is not novelty for its own sake: a single indicator becomes
 * furniture within a day and stops being read at all, where a thing that changed
 * since last time is briefly looked at — which is the entire job of the element.
 *
 * ── A CYCLE, NOT A RANDOM PICK ──────────────────────────────────────────────
 * Random repeats. Over ten turns a uniform draw shows you only ~6.5 of the ten
 * and hands you the same one twice in a row about one turn in ten, which reads
 * as broken rather than varied. A counter modulo ten guarantees all ten before
 * any repeat, and costs one integer.
 *
 * ── AND IT MUST NOT CHANGE MID-TURN ─────────────────────────────────────────
 * The indicator unmounts the instant the first token streams and can remount if
 * the stream clears, so advancing on mount would re-roll inside a single turn —
 * the one moment the user is actually looking at it. So the caller derives it
 * from the turn's own identity (see `workingVariantFor`): the same turn always
 * resolves to the same variant, and a new turn advances.
 */
export const WORKING_VARIANTS = [
  'braille',
  'ascii',
  'invader',
  'pong',
  'glider',
  'snake',
  'tetris',
  'matrix',
  'binary',
  'prompt',
] as const;

export type WorkingVariant = (typeof WORKING_VARIANTS)[number];

const KEY = 'muxpad.workingVariant.v1';

/** Where the cycle is up to. Persisted so a reload does not restart at zero and
 *  show you `braille` every morning. */
function readCursor(): number {
  try {
    const n = Number(localStorage.getItem(KEY));
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  } catch {
    return 0;
  }
}

/**
 * The variant for a given turn.
 *
 * `turnKey` is any value that is stable for one turn and different for the next
 * — in practice the id of the user event that started it. The mapping is
 * remembered, so asking twice for the same turn gives the same answer however
 * many times the component remounts inside it.
 *
 * A null key means "no turn has been identified yet", which happens for the
 * beat between a send and its transcript line landing. That gets the cursor's
 * current position WITHOUT advancing, so the real turn a moment later keeps the
 * same one rather than skipping a variant.
 */
const seen = new Map<string, WorkingVariant>();

export function workingVariantFor(turnKey: string | null | undefined): WorkingVariant {
  const cursor = readCursor();
  const at = (n: number) => WORKING_VARIANTS[n % WORKING_VARIANTS.length] as WorkingVariant;
  if (!turnKey) return at(cursor);
  const already = seen.get(turnKey);
  if (already) return already;
  const picked = at(cursor);
  seen.set(turnKey, picked);
  // Bounded: this only ever holds turns seen in one page's lifetime, and the
  // chat is remounted on navigation. Trim anyway — a pane left open for days on
  // a once-a-minute cron would otherwise grow one entry per fire.
  if (seen.size > 200) {
    for (const k of [...seen.keys()].slice(0, 100)) seen.delete(k);
  }
  try {
    localStorage.setItem(KEY, String((cursor + 1) % WORKING_VARIANTS.length));
  } catch {
    // quota etc. — best effort; without persistence the cycle simply restarts
    // at zero on the next reload, which is a worse shuffle, not a broken one.
  }
  return picked;
}

/** Test seam — forget the turn mapping and reset the cycle. */
export function __resetWorkingVariant(): void {
  seen.clear();
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
