// CUTTING SPEECH INTO UTTERANCES, WITH A LEVEL METER AND NOTHING ELSE.
//
// A review is "talk while you point", so the unit of everything downstream is
// one utterance: it is what gets transcribed, what gets split into
// instructions, and what picks its own frames out of the ring buffer.
//
// ─── Why the boundary is cut HERE and not by the transcriber ───────────────
//
// The spike's segmentation came from Chrome's Web Speech "final" events, and
// those handed back ONE twelve-second paragraph containing four instructions
// (see §3.1.3 of the plan). A transcriber's idea of a sentence is not a
// boundary we can rely on, and the better signal was sitting right there in the
// audio the whole time: the gap you leave when you stop talking to look at the
// next thing.
//
// Cutting on silence BEFORE transcription also buys three things for free:
//   · the audio we upload is already utterance-shaped, so timings need no
//     reconstruction — `startMs`/`endMs` are measured, not inferred;
//   · the transcriber sees a clean clip instead of a stream, which is what the
//     cheap batch endpoints are good at; and
//   · the level that drives this is the same number the UI needs for a mic
//     meter, and a dead microphone is then visible in the first second rather
//     than after a wasted review (§3.2, the device trap).
//
// Everything here is a pure function of (time, level) pairs. No AudioContext,
// no timers, no await — so the thresholds can be exercised against a synthetic
// envelope and the tuning argued about with numbers.

/** RMS that counts as the START of speech. Measured against a laptop mic at
 *  arm's length: room tone sits under 0.004, speech peaks 0.05–0.2. */
export const SPEECH_RMS = 0.015;

/** RMS that still counts as speech once you are talking. Hysteresis is not a
 *  nicety — a single threshold cuts an utterance at every plosive gap. */
export const SILENCE_RMS = 0.007;

/** Silence that ends an utterance. 700ms is the pause you leave when moving
 *  the cursor to the next thing; shorter chops "make this — " off its own
 *  sentence, longer glues two instructions into one and makes the split pass
 *  do work the audio could have done. */
export const SILENCE_CUT_MS = 700;

/** Shorter than this is a cough, a click, or a chair. Dropped without an
 *  upload, because a transcription of a chair costs money and says nothing.
 *  Measured over the VOICED span — first loud sample to last — so the lead and
 *  tail padding cannot pad a click up over the threshold. */
export const MIN_SPEECH_MS = 350;

/** A hard ceiling, so a long unbroken monologue still produces notes while you
 *  are talking rather than one wall at the end. The split pass exists for
 *  exactly this clip. */
export const MAX_UTTERANCE_MS = 15_000;

/** A small tail past the last loud sample, so a trailing consonant is not
 *  clipped off the audio we send. */
export const TAIL_MS = 180;

/** A pre-roll, so the attack of the first word is in the clip. */
export const LEAD_MS = 150;

export type SegmentEvent =
  /** Speech started. The ring buffer uses this to stop deduping frames. */
  | { type: 'start'; atMs: number }
  /** An utterance to transcribe. `continues` means the hard ceiling cut it and
   *  the speaker is still going — the next one starts immediately. */
  | { type: 'end'; startMs: number; endMs: number; continues: boolean }
  /** Too short to be speech. The caller drops the buffered audio. */
  | { type: 'drop'; startMs: number; endMs: number };

export interface SegmenterOpts {
  speechRms?: number;
  silenceRms?: number;
  silenceCutMs?: number;
  minSpeechMs?: number;
  maxUtteranceMs?: number;
}

/**
 * The state machine. Feed it a level every few tens of ms; it answers with an
 * event or null.
 *
 * It never looks at a clock of its own — `atMs` is the caller's session clock,
 * which is the same clock the frame ring stamps samples with. That shared clock
 * is the entire basis of pairing, so there must not be two of them.
 */
export class Segmenter {
  private readonly speechRms: number;
  private readonly silenceRms: number;
  private readonly silenceCutMs: number;
  private readonly minSpeechMs: number;
  private readonly maxUtteranceMs: number;

  private startMs: number | null = null;
  private firstLoudMs = 0;
  private lastLoudMs = 0;
  private peak = 0;

  constructor(opts: SegmenterOpts = {}) {
    this.speechRms = opts.speechRms ?? SPEECH_RMS;
    this.silenceRms = opts.silenceRms ?? SILENCE_RMS;
    this.silenceCutMs = opts.silenceCutMs ?? SILENCE_CUT_MS;
    this.minSpeechMs = opts.minSpeechMs ?? MIN_SPEECH_MS;
    this.maxUtteranceMs = opts.maxUtteranceMs ?? MAX_UTTERANCE_MS;
  }

  /** Is somebody talking right now? The frame ring asks this to decide whether
   *  a byte-identical screen is a duplicate (idle) or an anchor (speech). */
  get speaking(): boolean {
    return this.startMs !== null;
  }

  /** Loudest level seen in the utterance so far — the meter's peak hold. */
  get peakRms(): number {
    return this.peak;
  }

  feed(atMs: number, rms: number): SegmentEvent | null {
    if (this.startMs === null) {
      if (rms < this.speechRms) return null;
      this.startMs = Math.max(0, atMs - LEAD_MS);
      this.firstLoudMs = atMs;
      this.lastLoudMs = atMs;
      this.peak = rms;
      return { type: 'start', atMs: this.startMs };
    }

    if (rms > this.peak) this.peak = rms;
    if (rms >= this.silenceRms) {
      this.lastLoudMs = atMs;
      // The ceiling cut. End at NOW (not at lastLoud — we are mid-word) and
      // open the next utterance in the same breath, because the speaker has
      // not stopped and the next clip must not lose its first second.
      if (atMs - this.startMs >= this.maxUtteranceMs) {
        const started = this.startMs;
        this.startMs = atMs;
        this.firstLoudMs = atMs;
        this.peak = rms;
        return { type: 'end', startMs: started, endMs: atMs, continues: true };
      }
      return null;
    }

    if (atMs - this.lastLoudMs < this.silenceCutMs) return null;

    const started = this.startMs;
    const ended = this.lastLoudMs + TAIL_MS;
    const voiced = this.lastLoudMs - this.firstLoudMs;
    this.startMs = null;
    this.peak = 0;
    return voiced < this.minSpeechMs
      ? { type: 'drop', startMs: started, endMs: ended }
      : { type: 'end', startMs: started, endMs: ended, continues: false };
  }

  /** Stop pressed. Closes whatever is open so the last thing said is not the
   *  one thing lost — the commonest way to end a review is mid-sentence. */
  flush(atMs: number): SegmentEvent | null {
    if (this.startMs === null) return null;
    const started = this.startMs;
    const ended = Math.max(this.lastLoudMs + TAIL_MS, atMs);
    const voiced = this.lastLoudMs - this.firstLoudMs;
    this.startMs = null;
    this.peak = 0;
    return voiced < this.minSpeechMs
      ? { type: 'drop', startMs: started, endMs: ended }
      : { type: 'end', startMs: started, endMs: ended, continues: false };
  }
}

/** RMS of a block of samples. Separate from the class so the meter and the
 *  segmenter cannot disagree about what "level" means. */
export function rmsOf(samples: Float32Array | readonly number[]): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i] as number;
    sum += v * v;
  }
  return samples.length === 0 ? 0 : Math.sqrt(sum / samples.length);
}

/**
 * The meter's 0..1, which is NOT the raw RMS.
 *
 * Speech RMS lives in 0.01–0.2, so a linear bar is a bar that never moves. dB
 * over a 50 dB floor is what reads as "my mic is working".
 */
export function meterLevel(rms: number, floorDb = -50): number {
  if (rms <= 0) return 0;
  const db = 20 * Math.log10(rms);
  return Math.max(0, Math.min(1, (db - floorDb) / -floorDb));
}
