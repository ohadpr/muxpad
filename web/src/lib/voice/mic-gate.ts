// PHANTOM BARGE-INS, AND THE TWO CHEAP FILTERS THAT KILL MOST OF THEM.
//
// Safari's acoustic echo canceller covers audio the page RENDERS, which is
// exactly our case — the remote track plays through an <audio> element, so AEC
// sees it. It is still not perfect on a phone held at arm's length with the
// speaker on, and the residue is transcribed. The failure mode is specific and
// nasty: the model hears its own tail, treats it as the user interrupting,
// stops talking, and the user watches it talk over itself in a loop.
//
// TWO FILTERS, both on the TRANSCRIPT side rather than the audio side (there
// is no audio to gate on WebRTC — the track goes straight to the peer, and
// muting it would deafen the model rather than filter it):
//
//   1. POST-PLAYBACK GATE. For a short window after the model stops producing
//      output transcript, treat input as suspect. DISARMED BY REAL SPEECH: the
//      first utterance that clears the gate drops it entirely, so a genuine
//      interruption is delayed by at most one utterance and never by a policy.
//   2. MINIMUM DURATION. Sub-300ms utterances are lip smacks, "mm", breath,
//      and echo fragments. Real interruptions are longer, every time.
//
// Note what this does NOT do: it does not gate what the MODEL hears. The model
// is full-duplex and handles its own turn-taking, and fighting it there would
// be both impossible and wrong. This gates only OUR reading of the transcript
// — specifically, whether an utterance is substantial enough to count as the
// user changing their mind, which is the thing that stops a running agent turn
// and throws away minutes of work.

/** How long after the model stops speaking to distrust the microphone. */
export const POST_PLAYBACK_GATE_MS = 700;

/** Shorter than this is not an interruption. */
export const MIN_UTTERANCE_MS = 300;

export type GateVerdict = 'accept' | 'too-short' | 'echo-gated';

export interface MicGateOpts {
  postPlaybackMs?: number;
  minUtteranceMs?: number;
}

export interface GatedUtterance {
  startMs: number;
  endMs: number;
  text: string;
}

export class MicGate {
  private readonly postPlaybackMs: number;
  private readonly minUtteranceMs: number;
  /** Session-clock ms until which input is suspect; 0 = gate down. */
  private gateUntil = 0;

  constructor(opts: MicGateOpts = {}) {
    this.postPlaybackMs = opts.postPlaybackMs ?? POST_PLAYBACK_GATE_MS;
    this.minUtteranceMs = opts.minUtteranceMs ?? MIN_UTTERANCE_MS;
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
   */
  judge(u: GatedUtterance): GateVerdict {
    if (u.endMs - u.startMs < this.minUtteranceMs) return 'too-short';
    if (this.isArmed(u.startMs)) return 'echo-gated';
    this.disarm();
    return 'accept';
  }

  reset(): void {
    this.gateUntil = 0;
  }
}
