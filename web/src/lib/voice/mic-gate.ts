// PHANTOM BARGE-INS, AND THE TWO CHEAP FILTERS THAT KILL MOST OF THEM.
//
// Safari's acoustic echo canceller covers audio the page RENDERS, which is
// exactly our case — the remote track plays through an <audio> element, so AEC
// sees it. It is still not perfect on a phone held at arm's length with the
// speaker on, and the residue is transcribed. The failure mode is specific and
// nasty: the model hears its own tail, treats it as the user interrupting,
// stops talking, and the user watches it talk over itself in a loop.
//
// ═══ WHAT ACTUALLY RUNS, AS OF TODAY — read this before the history below ═══
//
// This class has exactly ONE caller: session.ts's cancel backstop
// (`judgeForCancel`), and it always passes `cancelShaped: true`. So the live
// behaviour is two tests and only two:
//
//   1. A 120ms ABSOLUTE FLOOR ({@link MIN_CANCEL_UTTERANCE_MS}), against a
//      transcriber hallucinating a word onto a burst of noise.
//   2. While the post-playback window is armed, an ECHO TEST AGAINST THE
//      MODEL'S OWN TRANSCRIPT — did it just say these words itself? Clearing
//      it disarms the window entirely.
//
// The other two knobs below — {@link MIN_UTTERANCE_MS} and the time-only
// echo-gated branch it pairs with — are UNREACHABLE in production. They are
// the general-purpose half of the class, kept because they are the correct
// answer for a non-cancel consumer and exercised by mic-gate.test.ts, but
// nothing calls `judge` without `cancelShaped` today. This block exists
// because the header used to describe them as the running behaviour, which was
// false in a file whose entire history is people believing its comments.
//
// Both tests are on the TRANSCRIPT side rather than the audio side (there is no
// audio to gate on WebRTC — the track goes straight to the peer, and muting it
// would deafen the model rather than filter it).
//
// And note what this does NOT do: it does not gate what the MODEL hears. The
// model is full-duplex and handles its own turn-taking, and fighting it there
// would be both impossible and wrong. This gates only OUR reading of the
// transcript — specifically, whether an utterance is substantial enough to
// count as the user changing their mind, which is the thing that stops a
// running agent turn and throws away minutes of work.
//
// ─── The two filters as originally designed, and why they were replaced ───
//
//   1. POST-PLAYBACK GATE. For a short window after the model stops producing
//      output transcript, treat input as suspect. DISARMED BY REAL SPEECH: the
//      first utterance that clears the gate drops it entirely, so a genuine
//      interruption is delayed by at most one utterance and never by a policy.
//   2. MINIMUM DURATION. Sub-300ms utterances are lip smacks, "mm", breath,
//      and echo fragments. Real interruptions are longer, every time.
//
// The second of those turned out to be measuring nothing at all — see below.
//
// ═══ AND THE CASE BOTH FILTERS WERE GETTING EXACTLY WRONG ═══
//
// The backstop they guard exists for ONE utterance: a bare spoken "stop". Both
// filters were declining precisely that, and the first was declining it ALWAYS.
//
// MEASURED, off captured live gpt-live-1 runs rather than reasoned about:
//
//   · `end_ms - start_ms` ON A DELTA IS NOT A DURATION. It is a fixed 200ms
//     quantisation bucket. Across two live sessions every one of 32 input
//     deltas was exactly 200ms wide and every boundary fell on a multiple of
//     200 — a 7-second sentence arrives as 17 deltas of 200ms, not as deltas
//     whose widths track the words.
//   · A BARE "stop" IS ONE DELTA. In the captured cancel run, 525ms of audio
//     (`say -v Samantha "Stop."`, duration confirmed with `afinfo`) produced
//     exactly one input delta: `{"delta":" Stop"}`.
//
// Together those say a bare spoken "stop" reports a 200ms span — every time,
// whoever says it, however slowly. Against a 300ms floor that is not a coin
// toss, it is a DETERMINISTIC REJECTION of every single-delta utterance, which
// is what a one-word cancel always is. The filter was never measuring speech.
// It was counting deltas, and it demanded at least two.
//
//   · The echo gate then took the rest: "stop" said OVER the model — the normal
//     way any human cancels anything — starts, by definition, inside the 700ms
//     post-playback window. Barging in is not an edge case here; it is the case.
//
// So the backstop was reachable only when the user waited for silence and then
// said something longer than one word, which is not what anyone does when the
// agent is doing the wrong thing.
//
// THE FIX IS NOT A SMALLER NUMBER. Both filters are proxies for a question the
// TEXT answers directly once cancel.ts has ruled on it, and the proxies are
// only needed because the text is usually uninformative:
//
//   · "is this noise?" — a lip smack, a breath, a cough does not transcribe as
//     the exact string "stop". Duration is a proxy for substance; a
//     whole-utterance match against a closed set of cancel imperatives is a
//     better one, so a cancel-shaped utterance is not asked to be long. What
//     survives is a small absolute floor against a transcriber HALLUCINATING a
//     word onto a burst of noise, which is a real failure and a short one.
//   · "is this the model's own voice?" — time is a proxy for provenance. The
//     direct test is whether the model actually said this, and we have the
//     model's output transcript. So a cancel-shaped utterance inside the
//     window is gated only if the model's own recent speech CONTAINS it.
//
// WHAT THE MEASUREMENT DOES AND DOES NOT SETTLE. It settles the shape: any
// floor above one 200ms quantum rejects every single-delta utterance outright,
// so the floor on the cancel path must sit below 200. It does NOT give a real
// distribution of spoken-"stop" lengths, because the API never reports one —
// the stamps are its own segmentation grid and the phonetics are invisible
// through them. That is fine, because nothing below depends on a duration: the
// cancel path is decided by TEXT, and the surviving floor only has to reject a
// span too small to be even one quantum.

/** How long after the model stops speaking to distrust the microphone. */
export const POST_PLAYBACK_GATE_MS = 700;

/**
 * Shorter than this is not an interruption.
 *
 * UNREACHABLE IN PRODUCTION, and named as such so nobody tunes it expecting an
 * effect. Read it as "at least two transcript deltas" — the measurement in the
 * header showed the API reports a fixed 200ms quantisation grid, so this floor
 * rejects every single-delta utterance, which is what a one-word cancel always
 * is. That is why the cancel path stopped consulting it, and the cancel path is
 * the only path that reaches this class today.
 *
 * Kept rather than deleted because it is the right answer for a consumer that
 * is NOT asking about a cancel — a judgement about substance where no closed
 * set of words can answer the question directly. There is no such consumer yet.
 */
export const MIN_UTTERANCE_MS = 300;

/**
 * The floor for an utterance that cancel.ts has already matched, whole, against
 * its closed set.
 *
 * NOT a model of how long "stop" takes to say — the API cannot tell us that.
 * It is below one 200ms quantisation bucket, which is what a real one-word
 * utterance reports, and above zero, which is what a degenerate or empty
 * segment reports. Anything at or above 200 would reject every bare cancel
 * there is; anything at zero would let a zero-width artefact kill a turn.
 */
export const MIN_CANCEL_UTTERANCE_MS = 120;

/** How far back to look in the model's own transcript for the words we just
 *  heard. One utterance's worth — the echo arrives within a beat or not at
 *  all, and a longer memory starts gating genuine cancels. */
export const ECHO_LOOKBACK_MS = 4000;

export type GateVerdict = 'accept' | 'too-short' | 'echo-gated';

export interface MicGateOpts {
  postPlaybackMs?: number;
  minUtteranceMs?: number;
  minCancelUtteranceMs?: number;
}

export interface GatedUtterance {
  startMs: number;
  endMs: number;
  text: string;
}

export interface JudgeOpts {
  /**
   * cancel.ts has matched this utterance, WHOLE, against its closed set.
   *
   * The caller knows this before it asks (session.ts checks the arrival policy
   * first), and it is the strongest evidence available about what the
   * utterance is — far stronger than its length. It does not weaken the gate,
   * it redirects it: see the header.
   */
  cancelShaped?: boolean;
  /** The model's own recent speech. The direct test for "is this my own voice
   *  coming back?", used in place of the time window when `cancelShaped`. */
  recentOutput?: string;
}

/** Lowercase, strip punctuation, collapse whitespace — enough to compare what
 *  was heard against what was said without a shared normaliser. */
function flatten(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Did the model just say this itself?
 *
 * Whole words only: the session's own "Stopped. The agent has been
 * interrupted" must not swallow a user's "stop", and it does not — "stopped"
 * does not contain "stop" at a word boundary.
 */
export function looksLikeEcho(utterance: string, recentOutput: string): boolean {
  const said = flatten(recentOutput);
  const heard = flatten(utterance);
  if (!said || !heard) return false;
  const escaped = heard.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^| )${escaped}( |$)`, 'u').test(said);
}

export class MicGate {
  private readonly postPlaybackMs: number;
  private readonly minUtteranceMs: number;
  private readonly minCancelMs: number;
  /** Session-clock ms until which input is suspect; 0 = gate down. */
  private gateUntil = 0;

  constructor(opts: MicGateOpts = {}) {
    this.postPlaybackMs = opts.postPlaybackMs ?? POST_PLAYBACK_GATE_MS;
    this.minUtteranceMs = opts.minUtteranceMs ?? MIN_UTTERANCE_MS;
    this.minCancelMs = opts.minCancelUtteranceMs ?? MIN_CANCEL_UTTERANCE_MS;
  }

  /** The model produced output transcript up to `endMs` — arm the gate. */
  observedOutput(endMs: number): void {
    this.gateUntil = Math.max(this.gateUntil, endMs + this.postPlaybackMs);
  }

  isArmed(atMs: number): boolean {
    return atMs < this.gateUntil;
  }

  /** Real speech got through — stop distrusting the microphone. */
  disarm(): void {
    this.gateUntil = 0;
  }

  /**
   * Should this utterance count as the user speaking?
   *
   * The duration test comes FIRST and applies whether or not the gate is
   * armed: a 120ms blip is noise in any acoustic situation. The echo test only
   * applies while the gate is up, and clearing it disarms the gate — so the
   * cost of a false positive is bounded at one utterance.
   *
   * A CANCEL-SHAPED UTTERANCE TAKES A DIFFERENT ROUTE THROUGH BOTH, because
   * both tests are proxies for questions its text already answers. See the
   * header — this is the one utterance the whole backstop exists for, and it
   * was the one both filters were rejecting.
   */
  judge(u: GatedUtterance, opts: JudgeOpts = {}): GateVerdict {
    const floor = opts.cancelShaped ? this.minCancelMs : this.minUtteranceMs;
    if (u.endMs - u.startMs < floor) return 'too-short';
    if (this.isArmed(u.startMs)) {
      // Time says "this might be the model's voice". For a cancel we can ask
      // the model's transcript directly instead of guessing from the clock.
      // The `!cancelShaped` branch is the general-purpose answer and has no
      // caller today — see the header.
      if (!opts.cancelShaped) return 'echo-gated';
      if (looksLikeEcho(u.text, opts.recentOutput ?? '')) return 'echo-gated';
    }
    this.disarm();
    return 'accept';
  }

  reset(): void {
    this.gateUntil = 0;
  }
}
