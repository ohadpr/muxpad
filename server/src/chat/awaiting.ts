import type Database from 'better-sqlite3';
import { readRecentTurns } from './headline.js';

/**
 * DID THIS WORKER STOP TO ASK YOU SOMETHING?
 *
 * `delivered` and `awaiting you` were one state, and they are opposites. A
 * sub-chat retires at TURN-END, so "I finished the job" and "I finished a turn
 * and the ball is in your court" reached the lifecycle as the same event — and
 * the second one was archived out of the live list, which is the worst available
 * response to somebody waiting on you.
 *
 * The case, in full, because it is the design: `cross-ws` investigated
 * cross-workspace navigation, published a page, wrote a 13 KB report, ended its
 * turn asking which option to take — and its row says `retired_reason =
 * delivered`.
 *
 * ─── Why not the pane's `blocked` status ─────────────────────────────────────
 * It is the obvious candidate, it is the right WORD ("wants you NOW", a red
 * mark, already wired to push), and it is ALREADY CONSULTED: ChatRetirer's
 * keep-list has read it since the first commit. It did not fire here, and it
 * could not have: `blocked` means the HARNESS reported a pending question — a
 * tool-level prompt it is waiting on — and an agent that ends its prose with
 * "which would you prefer?" raises no such thing. The signal is correct and does
 * not cover this case. The question exists only as text.
 *
 * ─── Why not ask the summariser ──────────────────────────────────────────────
 * It is the better reader, and this very bug disqualifies it: the model call is
 * exactly what failed for `cross-ws` — its report WAS generated and then refused
 * by a length rule — so a classification riding that call would have been absent
 * precisely when it was needed, and absent means `delivered`, which is the bug.
 * A lifecycle decision must not depend on a generator that is allowed to fail.
 *
 * So this is deterministic, reads the child's last message, and runs whether or
 * not anything else worked.
 *
 * ─── What it does when it cannot tell ────────────────────────────────────────
 * Says NO. That is `delivered`, which is the default that produced the bug, so
 * it is worth stating why it survives for the unreadable case specifically: an
 * empty or missing transcript is not evidence of a question. Treating silence as
 * "awaiting" would pin every child with a pruned transcript into the live list
 * forever — the 41-agent sidebar, rebuilt. The default is only safe because the
 * DETECTION below is deliberately generous: it takes an explicit invitation as
 * readily as a question mark, so "cannot tell" is rare and means "there is
 * nothing to read", not "this was ambiguous".
 */

/** The last sentence, stripped of the markdown a sign-off usually wears. */
function tail(text: string): string {
  const flat = text
    .replace(/```[\s\S]*?```/g, ' ') // fenced code says nothing about intent
    .replace(/[*_`#>]/g, '')
    .trim();
  // The last non-empty line, then its last sentence. A report that ends with a
  // list of files and then "which one?" must be read on the question.
  const lines = flat.split('\n').filter((l) => l.trim());
  const last = lines[lines.length - 1]?.trim() ?? '';
  return last;
}

/** An interrogative opener, which is what makes a trailing `?` an ASK rather
 *  than a label that happens to be phrased as a question. */
const INTERROGATIVE = /\b(?:which|what|should|shall|do you|would you|want me|can i|may i)\b/i;

/**
 * An explicit invitation, for the endings that carry no question mark at all —
 * and they are the majority. "Your call." and "Let me know which to build." are
 * both a worker stopping and waiting.
 */
const INVITATION =
  /\b(?:let me know|your call|up to you|which (?:one|option|of these)|tell me which|say the word|whichever you (?:pick|prefer|choose)|you (?:pick|choose|decide)|awaiting (?:your )?(?:instructions|input|direction)|shall i proceed|want me to|should i (?:go|proceed|start|build|do))\b/i;

/**
 * IT EXPLICITLY DID NOT ACT.
 *
 * The shape the other two patterns miss, and the one that produced the
 * complaint. `cross-ws` ended with:
 *
 *   "Recommended options 1 + 5 … Nothing implemented; no files under `web/`
 *    touched; preview server torn down."
 *
 * No question, no invitation — and unmistakably waiting for a go-ahead. An
 * investigation that recommends and then says out loud that it changed nothing
 * has handed the decision back, and saying so is the closest thing to an
 * explicit ask that this class of worker produces.
 *
 * The risk, stated: a worker whose JOB was to investigate ends this way and is
 * genuinely finished. It keeps its live row, which costs one archive gesture —
 * against losing the recommendation entirely, which is what happens now.
 */
const DECLINED_TO_ACT =
  /\b(?:nothing (?:was |is )?(?:implemented|changed|built|shipped)|not implemented|no (?:code|files?|changes?)(?: were| was| have been)? (?:changed|touched|written|made|modified)|no changes (?:were |have been )?made|left (?:it )?unimplemented)\b/i;

/**
 * Does this message end with the ball in the reader's court?
 *
 * Pure, and deliberately generous in one direction: the cost of a false positive
 * is one extra row in the live list, which you can archive with a gesture that
 * already exists; the cost of a false negative is a worker that asked you
 * something being filed away as finished. The user has been bitten by the
 * second, and the asymmetry is real, so the detector leans that way — but it
 * leans by recognising MORE SHAPES, not by guessing when there is nothing to
 * read (see the file note).
 */
export function endsAwaitingUser(text: string): boolean {
  const last = tail(text);
  if (!last) return false;
  if (INVITATION.test(last)) return true;
  if (DECLINED_TO_ACT.test(last)) return true;
  // A question mark AND something interrogative about the clause it closes. A
  // trailing `?` alone catches "Settled the question of which selector wins?" —
  // and more usefully, a report that quotes a question back is not asking one.
  return last.endsWith('?') && INTERROGATIVE.test(last);
}

/**
 * The same question, asked of a pane: read its transcript tail and look at the
 * LAST thing it said.
 *
 * A bounded tail read and no model, so it is cheap enough to run synchronously
 * inside a turn-end handler — which is where it has to run, because the
 * retirement decision is made there and cannot wait for anything async.
 */
export function paneAwaitsUser(db: Database.Database, paneId: string): boolean {
  const { conversation } = readRecentTurns(db, paneId);
  if (!conversation) return false;
  // Walk back to the last ASSISTANT line. Anything after it would be a user
  // message, which means the ball is already back in the worker's court.
  const lines = conversation.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] as string;
    if (line.startsWith('user: ')) return false;
    if (!line.startsWith('assistant: ')) continue;
    return endsAwaitingUser(line.slice('assistant: '.length));
  }
  return false;
}
