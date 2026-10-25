import {
  STANDING_RULES,
  readAgentInstructions,
  wrapAgentInstructions,
} from '../agent-instructions.js';

/**
 * WHAT MUXPAD PREPENDS TO A TURN — one rule for every harness that has no
 * system prompt.
 *
 * ─── The failure this replaces ────────────────────────────────────────────
 *
 * Two backends carried the same five lines of logic, copied:
 *
 *     const finalPrompt = resuming ? prompt : withSessionPreamble(…);
 *     // fresh spawns only; a resume already carries it in-thread
 *
 * "A resume already carries it in-thread" is true the day the session starts
 * and false forever after. The instructions were A MESSAGE, and a message
 * ages, gets summarised, gets compacted away — and nothing put it back,
 * because every turn after the first is a resume.
 *
 * MEASURED on a four-day-old codex pane: 2,392 turns, 6.5 MB of transcript,
 * ZERO occurrences of the instruction block or of any rule in it. That pane
 * then DM'd a colleague on Slack as a bot, unapproved, using a token it found
 * on disk — three things the instructions forbid explicitly. It had simply
 * never been told. Claude panes were unaffected, because a system prompt is
 * re-sent with every request; the rules held on one harness and evaporated on
 * the other two, which is the worst possible shape for a rule.
 *
 * ─── The arrangement now ──────────────────────────────────────────────────
 *
 *   FIRST TURN of a RUNNER    the full instructions.
 *   EVERY TURN after it       {@link STANDING_RULES} — the non-negotiables,
 *                             short enough to re-send forever.
 *
 * Keyed on the runner PROCESS rather than the session, because "is this a
 * resume" is a question neither backend can answer honestly — see
 * {@link turnPreamble}'s `instructionsInThread`. A pane start is the cheap,
 * observable edge, and it is also the one moment a long session may have lost
 * the document to its own compaction.
 *
 * Both texts come from one source (agent-instructions.ts embeds the standing
 * rules verbatim in the full document), so the card cannot drift from the
 * file it summarises.
 *
 * ─── Why not re-send the whole thing every turn ───────────────────────────
 *
 * It is ~33 KB. On a backend that re-spawns per turn that is the document on
 * every message of every pane, forever — which buys back the rules and pays
 * for them in exactly the context pressure that caused the compaction that
 * lost them in the first place. The card is a few hundred tokens and carries
 * the lines whose COST OF NOT KNOWING is irreversible.
 */
export function turnPreamble(opts: {
  /** The user's message. */
  prompt: string;
  /**
   * Has THIS RUNNER PROCESS already put the full document in-thread?
   *
   * Per PROCESS, not per session, and that distinction is load-bearing twice:
   *
   *   · A resumed session whose original injection was compacted away gets the
   *     whole document back the next time its pane starts, so the how-to half
   *     — publish, the browser handoff, crons — is not lost for good.
   *   · `cursor-agent --resume <id-it-has-never-seen>` does not fail. It opens
   *     a BRAND NEW session under that id, and muxpad hands it a locally-minted
   *     placeholder id the moment a pane connects — so a cursor pane that
   *     restarted before anybody typed used to look like a resume forever and
   *     never saw the document at all. Keying on the process makes that
   *     unobservable difference stop mattering.
   *
   * The cost is the document once per pane start, not once per turn.
   */
  instructionsInThread: boolean;
  /** Mode contract, where a backend has one. Appended after the rules. */
  modeOverlay?: string | null;
  /** Test seam: the full instruction document. */
  instructions?: string | null;
  /** Test seam: the standing-rules card. */
  standing?: string;
}): string {
  const blocks: string[] = [];
  const full = opts.instructions === undefined ? readAgentInstructions() : opts.instructions;
  const card = opts.standing ?? STANDING_RULES;

  if (!opts.instructionsInThread && full?.trim()) {
    // The first turn of a runner gets everything — the capabilities, the worked
    // examples, the reasoning. The standing rules are inside it (one source),
    // so this never carries both.
    blocks.push(wrapAgentInstructions(full));
  } else if (card.trim()) {
    // NO full document to send is not a reason to send NOTHING. The document is
    // read off disk and is regenerated at boot; a missing, empty or unreadable
    // file, or a data dir holding only the user's own notes, used to mean a
    // fresh session with zero rules — the exact state the Slack incident was
    // sent from. The card is compiled in and cannot go missing, so it is the
    // floor.
    // …and every turn after it gets the part that must not be forgotten.
    // Wrapped in the SAME delimiter as the full block: a backend's transcript
    // then shows one recognisable kind of muxpad injection rather than two,
    // and anything that strips muxpad plumbing from a rendered transcript
    // keeps working unchanged.
    blocks.push(wrapAgentInstructions(card));
  }
  if (opts.modeOverlay?.trim())
    blocks.push(`<muxpad-mode>\n${opts.modeOverlay.trim()}\n</muxpad-mode>`);
  return blocks.length ? `${blocks.join('\n\n')}\n\n${opts.prompt}` : opts.prompt;
}
