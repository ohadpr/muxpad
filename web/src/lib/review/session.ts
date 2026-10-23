// THE CONTROLLER: a review, from "pick a window" to a list of notes.
//
// ─── Everything that touches a platform is INJECTED ────────────────────────
//
// Not for purity — for the two days the spike lost to instruments that lied.
// An AudioContext created after an `await` is suspended, so a level meter read
// zero while the mic worked; a rAF loop guarded on a variable assigned later
// never ran, so it read zero again; a speech recognizer restarted on every
// error 1116 times in five seconds. Every one of those was invisible from
// inside the page and obvious the moment the tap could be driven by hand.
//
// So `ReviewDeps` is the whole platform: the two capture calls, the audio tap,
// the frame grabber, the three server calls and the clock. The production
// implementations are in capture.ts (thin, browser-only); everything that makes
// a DECISION is here and is exercised with fakes.
//
// ─── The order of operations, and why ──────────────────────────────────────
//
//   utterance ends  →  TRANSCRIBE  →  pick frames  →  mark + upload  →  split
//
// Transcription comes FIRST because about one clip in five is a cough, a chair,
// or a passing "hmm" — and a clip that turns out to say nothing must not have
// cost four uploaded JPEGs and a row in the attachments table. Marking and
// uploading only happen once there are words to attach them to.
//
// The split pass is LAST, and cannot fail the note: it runs on the text we
// already have and its worst outcome is one note instead of three.

import type { ReviewNote, ReviewSplit } from '@muxpad/shared';
import { type GrayMap, findCursor } from './cursor';
import { FrameRing, type FrameSample, aHash } from './frames';
import { Segmenter, meterLevel, rmsOf } from './segment';
import { concatPcm, encodeWav, resample } from './wav';

/** One sampled frame, as the grabber hands it over. */
export interface Grabbed {
  /** The frame, already encoded — ~70 KB at 1280px q0.7. Kept rather than the
   *  raw pixels because a minute of RGBA frames is half a gigabyte. */
  jpeg: Blob;
  /** The small greyscale map, for the hash and the cursor diff. */
  gray: GrayMap;
  w: number;
  h: number;
}

export interface FrameGrabber {
  /** One sample, or null when the stream has nothing to give (a window that
   *  was minimised, a stream that ended). */
  grab(): Promise<Grabbed | null>;
  /** Re-encode a frame with the pointer ringed and a close-up inset. */
  mark(frame: Grabbed, cursor: { x: number; y: number } | null): Promise<Blob>;
  stop(): void;
}

export interface AudioTap {
  /** Called with every block of microphone PCM. `atMs` is on the session
   *  clock — the SAME clock frames are stamped with, which is the entire basis
   *  of pairing. */
  onBlock(cb: (atMs: number, samples: Float32Array, sampleRate: number) => void): void;
  stop(): void;
}

export interface ReviewDeps {
  /** getDisplayMedia + a grabber bound to it. Throws/rejects if the user
   *  cancels the picker, which is a normal outcome and not an error. */
  startCapture(): Promise<FrameGrabber>;
  /** getUserMedia + an audio tap. */
  startAudio(): Promise<AudioTap>;
  /** Upload one marked frame; resolves to its attachment path. */
  uploadFrame(blob: Blob, name: string): Promise<string>;
  transcribe(audio: Blob): Promise<string>;
  split(text: string, frames: number): Promise<ReviewSplit[]>;
  now(): number;
  /** Something to log a lost note to. The spike's diagnostics panel earned its
   *  place; without it a review that produced nothing said nothing about why. */
  log?: (line: string) => void;
}

export type ReviewPhase = 'idle' | 'starting' | 'recording' | 'stopping' | 'stopped' | 'failed';

/** A note on the page, which knows things the wire shape does not: whether it
 *  is still being worked on, and whether it failed. */
export interface ReviewItem extends ReviewNote {
  status: 'pending' | 'ready' | 'failed';
  /** Why it failed, for the panel. */
  error?: string;
}

export interface ReviewState {
  phase: ReviewPhase;
  /** 0..1, for the mic meter. A review with a dead microphone must be visible
   *  in the first second, not after it is over (§3.2, the device trap). */
  level: number;
  speaking: boolean;
  items: ReviewItem[];
  startedAt: number | null;
  /** Set when the phase is 'failed'. */
  error?: string;
  /** Frames sampled / frames kept, for the UI's small print. */
  sampled: number;
  kept: number;
  /** Something is still being transcribed or uploaded. Send must wait for it:
   *  a note that has not come back yet is a note the user SAID, and sending
   *  without it drops it with no trace. */
  pending: boolean;
}

/** How often to sample the screen while somebody is talking. Three a second
 *  was the measured answer: a twelve-second utterance with four asks produced
 *  four usable anchors. */
export const SAMPLE_MS = 333;

/** And while nobody is talking. Cheap, and only here so the ring is not empty
 *  the instant speech starts. */
export const IDLE_SAMPLE_MS = 2000;

/** How much microphone history to keep. Longer than the longest utterance plus
 *  the pre-roll, and no longer — this is the one unbounded-growth risk in a
 *  review that runs for half an hour. */
export const PCM_WINDOW_MS = 30_000;

/** Frames uploaded at once. Two is the same ceiling the composer's upload queue
 *  uses; a review is not a reason to saturate the link. */
const UPLOAD_CONCURRENCY = 2;

let seq = 0;
const nextId = () => `rv${Date.now().toString(36)}${(seq++).toString(36)}`;

export class ReviewSession {
  private readonly deps: ReviewDeps;
  private readonly listeners = new Set<(s: ReviewState) => void>();

  private grabber: FrameGrabber | null = null;
  private tap: AudioTap | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  private readonly ring = new FrameRing<Grabbed>();
  private readonly segmenter = new Segmenter();
  /** The last few greyscale maps, so a frame's cursor can be found from its
   *  neighbours (cursor.ts: the position in frame N is the region that changed
   *  in BOTH adjacent diffs). */
  private maps: Array<{ atMs: number; gray: GrayMap }> = [];

  /** Microphone history: blocks plus the session time of the first sample. */
  private pcm: Array<{ atMs: number; samples: Float32Array }> = [];
  private sampleRate = 48_000;

  /**
   * WHICH REVIEW THIS IS.
   *
   * Bumped by every `start` and every `stop`. Everything asynchronous — the
   * two device handshakes, the sampling loop, an utterance in flight —
   * captures it and checks it on the way back, because all three can outlive
   * the review that launched them. Three bugs, all found in review, all the
   * same shape:
   *
   *   · Stop pressed while the microphone handshake was still pending: `stop`
   *     returned (the phase was `starting`, not `recording`) and `start` then
   *     carried on into `recording` with both devices live and nobody holding
   *     them — the component had already unmounted.
   *   · Start pressed while a stop was awaiting its last transcription: the
   *     new capture was opened, then the OLD stop's `grabber.stop()` closed
   *     it, leaving the previous screen share running forever.
   *   · An utterance resolving into a review that had already been reset.
   */
  private generation = 0;

  private startedAt: number | null = null;
  private state: ReviewState = {
    phase: 'idle',
    level: 0,
    speaking: false,
    items: [],
    startedAt: null,
    sampled: 0,
    kept: 0,
    pending: false,
  };

  constructor(deps: ReviewDeps) {
    this.deps = deps;
  }

  get current(): ReviewState {
    return this.state;
  }

  subscribe(cb: (s: ReviewState) => void): () => void {
    this.listeners.add(cb);
    cb(this.state);
    return () => this.listeners.delete(cb);
  }

  private set(patch: Partial<ReviewState>) {
    // `pending` is derived, never passed in: one source of truth for "is
    // anything still in flight", and it cannot drift from the set that holds
    // the work.
    this.state = { ...this.state, ...patch, pending: this.inFlight.size > 0 };
    for (const cb of this.listeners) cb(this.state);
  }

  private log(line: string) {
    this.deps.log?.(line);
  }

  /** Session clock: ms since the review started. */
  private at(): number {
    return this.startedAt === null ? 0 : this.deps.now() - this.startedAt;
  }

  /**
   * Start.
   *
   * CAPTURE BEFORE MICROPHONE, deliberately: the capture picker is the one step
   * the user can cancel, and cancelling it must not leave a live microphone
   * behind (a recording indicator over a review that never started is exactly
   * the kind of thing that stops people trusting a feature).
   */
  async start(): Promise<void> {
    // `stopping` too: a stop that is still waiting for its last transcription
    // owns both devices, and starting underneath it means two live captures
    // and one `stop()` call to share between them.
    if (
      this.state.phase === 'recording' ||
      this.state.phase === 'starting' ||
      this.state.phase === 'stopping'
    )
      return;
    const mine = ++this.generation;
    this.set({ phase: 'starting', items: [], sampled: 0, kept: 0 });
    let grabber: FrameGrabber;
    try {
      grabber = await this.deps.startCapture();
    } catch (e) {
      if (mine === this.generation) this.set({ phase: 'failed', error: msgOf(e) });
      throw e;
    }
    // CANCELLED WHILE THE PICKER WAS OPEN. Everything acquired so far has to
    // go: the user has pressed stop, or the pane has gone.
    if (mine !== this.generation) {
      grabber.stop();
      return;
    }
    let tap: AudioTap;
    try {
      tap = await this.deps.startAudio();
    } catch (e) {
      grabber.stop();
      if (mine === this.generation) this.set({ phase: 'failed', error: msgOf(e) });
      throw e;
    }
    if (mine !== this.generation) {
      grabber.stop();
      tap.stop();
      return;
    }

    this.grabber = grabber;
    this.tap = tap;
    this.ring.clear();
    this.maps = [];
    this.pcm = [];
    this.startedAt = this.deps.now();
    this.set({ phase: 'recording', startedAt: this.startedAt, level: 0, speaking: false });

    // ONE CLOCK, AND IT IS THE SESSION'S.
    //
    // The tap stamps blocks against its own origin, which is set before an
    // AudioWorklet finishes initialising — and the session's origin is set
    // after. Measured in review with a mocked 2s worklet startup: audio at
    // 2500ms against frames at 500ms, i.e. every note reaching for frames two
    // seconds too late. The tap's number is discarded here; what a block is
    // worth is WHEN IT ARRIVED on the same clock the frames are stamped with.
    tap.onBlock((_tapMs, samples, rate) => this.onAudio(this.at(), samples, rate));
    this.tick();
  }

  /** Stop, close whatever sentence was in flight, and release both devices. */
  async stop(): Promise<void> {
    // A stop DURING STARTUP must still count. The devices are being acquired
    // right now; bumping the generation is what tells `start` to let them go
    // when its awaits come back, and returning early here (as this used to)
    // left a review running that nobody had a handle on.
    if (this.state.phase === 'starting') {
      this.generation++;
      this.set({ phase: 'stopped', level: 0, speaking: false });
      return;
    }
    if (this.state.phase !== 'recording') return;
    // NO GENERATION BUMP HERE, and that is deliberate. A stop does not
    // ABANDON the review — it is about to wait for the work already in
    // flight (`settle` below), and invalidating that work is how the first
    // version of this fix left a pending note stuck with no text at all.
    // `reset()` is the one that discards; `start()` refuses to run until this
    // has finished, so nothing can overtake it meanwhile.
    this.set({ phase: 'stopping' });
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    const tail = this.segmenter.flush(this.at());
    this.tap?.stop();
    this.tap = null;
    // ── RELEASE THE SCREEN FIRST, then wait for the words ──────────────────
    //
    // The tail utterance has to be transcribed and its frames uploaded, which
    // is network time. Holding the screen share open across it means the
    // browser's "you are sharing" bar stays up for seconds after the user
    // pressed stop, over a review that is already over. The frames this note
    // needs are bytes we already hold; the grabber is only needed to MARK
    // them, so it is handed to the pending work and closed after.
    const grabber = this.grabber;
    this.grabber = null;
    try {
      // The last thing said is the commonest thing to lose, because the way a
      // review ends is "…and that's it" followed by reaching for the button.
      if (tail?.type === 'end') await this.onUtterance(tail.startMs, tail.endMs);
      // …and anything that ended on silence a moment earlier is still in
      // flight. Waiting for it is the difference between a note that arrives
      // and a note that is dropped by the Send the user presses next.
      await this.settle();
    } finally {
      grabber?.stop();
      this.set({ phase: 'stopped', level: 0, speaking: false });
    }
  }

  /** Every utterance that is still being transcribed or uploaded. */
  private readonly inFlight = new Set<Promise<void>>();

  /**
   * Wait for the work already started.
   *
   * A note is PENDING from the moment its silence ends until its text comes
   * back. `stop()` used to wait only for the sentence that was open when it
   * was pressed — so "…and the font is too small." followed, half a second
   * later, by Stop and then Send, sent a review with that note missing and no
   * sign it had ever existed.
   */
  private async settle(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.all([...this.inFlight]);
  }

  /** Is anything still being transcribed? The UI disables Send while true. */
  get pending(): boolean {
    return this.inFlight.size > 0;
  }

  /** Throw a note away. The panel's only edit in v1 — scrap or keep. */
  scrap(id: string) {
    this.set({ items: this.state.items.filter((n) => n.id !== id) });
  }

  /** Forget the review entirely (after sending, or on dismiss). */
  reset() {
    this.generation++;
    this.set({ phase: 'idle', items: [], startedAt: null, sampled: 0, kept: 0, level: 0 });
    this.ring.clear();
    this.maps = [];
    this.pcm = [];
  }

  // ── audio ───────────────────────────────────────────────────────────────

  private onAudio(atMs: number, samples: Float32Array, rate: number) {
    this.sampleRate = rate;
    this.pcm.push({ atMs, samples });
    // Bound the history. This is the only thing in a review that grows with
    // wall-clock time rather than with what the user did.
    const cutoff = atMs - PCM_WINDOW_MS;
    while (this.pcm.length > 1 && (this.pcm[0] as { atMs: number }).atMs < cutoff) this.pcm.shift();

    const rms = rmsOf(samples);
    const event = this.segmenter.feed(atMs, rms);
    this.set({ level: meterLevel(rms), speaking: this.segmenter.speaking });
    if (!event) return;
    // SPEECH JUST STARTED — resample NOW rather than waiting out the idle
    // timer. The sampling loop reschedules itself at whichever rate was
    // current when it last ran, so without this the first two seconds of an
    // utterance are covered by the pre-roll frame alone, and a short remark
    // ("this one, pink") can end before the fast rate ever takes effect.
    if (event.type === 'start') {
      if (this.timer !== null) clearTimeout(this.timer);
      this.timer = null;
      this.tick();
      return;
    }
    if (event.type === 'drop') {
      this.log(`dropped a ${event.endMs - event.startMs}ms noise`);
      return;
    }
    if (event.type === 'end') this.track(this.onUtterance(event.startMs, event.endMs));
  }

  /**
   * The microphone history between two session times, as one WAV.
   *
   * TRIMMED TO THE SPAN, not rounded out to whole blocks. A block is ~43ms of
   * 48 kHz audio, and taking every block that so much as touches the interval
   * both lengthens the clip and repeats audio across a ceiling cut — measured
   * in review as a 200ms WAV for a 100ms request. The arithmetic is in
   * SAMPLES, because that is the only unit in which the two ends are exact.
   */
  private sliceAudio(startMs: number, endMs: number): Blob | null {
    if (endMs <= startMs) return null;
    const rate = this.sampleRate;
    const parts: Float32Array[] = [];
    for (const block of this.pcm) {
      const blockMs = (block.samples.length / rate) * 1000;
      const blockEnd = block.atMs + blockMs;
      if (blockEnd <= startMs || block.atMs >= endMs) continue;
      // Where this block's own window overlaps the one asked for.
      const fromMs = Math.max(0, startMs - block.atMs);
      const toMs = Math.min(blockMs, endMs - block.atMs);
      const from = Math.max(0, Math.round((fromMs / 1000) * rate));
      const to = Math.min(block.samples.length, Math.round((toMs / 1000) * rate));
      if (to > from) parts.push(block.samples.subarray(from, to));
    }
    if (parts.length === 0) return null;
    const pcm = resample(concatPcm(parts), rate);
    return pcm.length === 0 ? null : encodeWav(pcm);
  }

  // ── frames ──────────────────────────────────────────────────────────────

  /**
   * One sample, then schedule the next.
   *
   * A SELF-RESCHEDULING timeout rather than an interval, because the sampling
   * rate changes with speech and because a grab that takes longer than the
   * interval must not queue up behind itself.
   */
  private tick() {
    const run = async () => {
      if (this.state.phase !== 'recording' || !this.grabber) return;
      const speaking = this.segmenter.speaking;
      try {
        const frame = await this.grabber.grab();
        if (frame) this.keep(frame, speaking);
      } catch (e) {
        this.log(`grab failed: ${msgOf(e)}`);
      }
      if (this.state.phase === 'recording')
        this.timer = setTimeout(run, speaking ? SAMPLE_MS : IDLE_SAMPLE_MS);
    };
    void run();
  }

  private keep(frame: Grabbed, speaking: boolean) {
    const atMs = this.at();
    this.maps.push({ atMs, gray: frame.gray });
    if (this.maps.length > 8) this.maps.shift();
    // The cursor for the PREVIOUS sample, now that it has a successor: a
    // pointer's position is the region that changed in both adjacent diffs.
    // One sample of lag costs nothing — frames are chosen when an utterance
    // ends, long after.
    const n = this.maps.length;
    if (n >= 3) {
      const mid = this.maps[n - 2] as { atMs: number; gray: GrayMap };
      const found = findCursor(
        (this.maps[n - 3] as { gray: GrayMap }).gray,
        mid.gray,
        (this.maps[n - 1] as { gray: GrayMap }).gray,
      );
      const sample = this.ring.all().find((s) => s.atMs === mid.atMs);
      if (sample && found) sample.cursor = found;
    }
    const kept = this.ring.push(
      { atMs, hash: aHash(frame.gray.data), cursor: null, payload: frame },
      { speaking },
    );
    this.set({ sampled: this.state.sampled + 1, kept: this.state.kept + (kept ? 1 : 0) });
  }

  // ── one utterance → notes ───────────────────────────────────────────────

  /** Hold a piece of in-flight work so `stop()` can wait for it, and so the
   *  UI can say "still transcribing" instead of quietly dropping it. */
  private track(work: Promise<void>): Promise<void> {
    const held = work.finally(() => {
      this.inFlight.delete(held);
      this.set({});
    });
    this.inFlight.add(held);
    this.set({});
    return held;
  }

  private async onUtterance(startMs: number, endMs: number) {
    const mine = this.generation;
    const audio = this.sliceAudio(startMs, endMs);
    if (!audio) {
      this.log(`no audio for ${startMs}–${endMs}ms`);
      return;
    }
    const id = nextId();
    const pending: ReviewItem = {
      id,
      text: '',
      startMs,
      endMs,
      frames: [],
      status: 'pending',
    };
    this.set({ items: [...this.state.items, pending] });

    let text = '';
    try {
      text = await this.deps.transcribe(audio);
    } catch (e) {
      if (mine !== this.generation) return;
      this.replace(id, { status: 'failed', error: msgOf(e) });
      return;
    }
    // The review this belongs to is over and forgotten (reset, or a new one
    // started). Its note has nowhere to land.
    if (mine !== this.generation) return;
    if (!text.trim()) {
      // Nothing was said. Drop the row rather than leaving an empty note in a
      // panel the user is about to send.
      this.set({ items: this.state.items.filter((n) => n.id !== id) });
      this.log(`nothing said in ${startMs}–${endMs}ms`);
      return;
    }

    // Frames only now, once there are words to attach them to.
    const picked = this.ring.pick(startMs, endMs);
    const paths = await this.uploadFrames(picked);
    const splits = await this.deps.split(text, paths.length);
    if (mine !== this.generation) return;

    const items = splits.map((s, i) => ({
      id: i === 0 ? id : nextId(),
      text: s.text,
      startMs,
      endMs,
      frames:
        s.frame === null || !paths[s.frame]
          ? paths
          : // One instruction out of several: its own frame, the one that was on
            // screen while it was being said.
            [paths[s.frame] as string],
      status: 'ready' as const,
    }));
    this.set({
      items: this.state.items.flatMap((n) => (n.id === id ? items : [n])),
    });
  }

  private replace(id: string, patch: Partial<ReviewItem>) {
    this.set({
      items: this.state.items.map((n) => (n.id === id ? { ...n, ...patch } : n)),
    });
  }

  /**
   * Mark, upload, keep the order.
   *
   * THE ORDER IS BY INDEX, not by the path that comes back: the attachments
   * route names a file with four random bytes, so there is nothing in the
   * answer that says which frame it was. Two workers finishing out of order
   * would otherwise shuffle the pictures under a note — the one bug in this
   * file that would look like the cursor tracking being wrong.
   */
  private async uploadFrames(picked: readonly FrameSample<Grabbed>[]): Promise<string[]> {
    const out: Array<string | null> = picked.map(() => null);
    let next = 0;
    const workers = Array.from(
      { length: Math.min(UPLOAD_CONCURRENCY, picked.length) },
      async () => {
        for (;;) {
          const i = next++;
          const sample = picked[i];
          if (!sample) return;
          try {
            const marked = await (this.grabber?.mark(sample.payload, sample.cursor) ??
              Promise.resolve(sample.payload.jpeg));
            out[i] = await this.deps.uploadFrame(marked, `review-${sample.atMs}.jpg`);
          } catch (e) {
            // A frame that will not upload is a frame the note does without.
            // The words are the ask; the picture is the address.
            this.log(`frame upload failed: ${msgOf(e)}`);
          }
        }
      },
    );
    await Promise.all(workers);
    return out.filter((p): p is string => !!p);
  }
}

function msgOf(e: unknown): string {
  return e instanceof Error && e.message ? e.message : String(e);
}
