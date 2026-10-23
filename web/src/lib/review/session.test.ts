import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GrayMap } from './cursor';
import { type Grabbed, IDLE_SAMPLE_MS, ReviewSession, SAMPLE_MS } from './session';

// THE WHOLE PLATFORM IS A FAKE HERE, which is the point: the spike's losses
// were all instruments that lied (a suspended AudioContext reading zero, a rAF
// loop that never started, a recognizer restarting 1116 times). Driving the tap
// and the grabber by hand is how those become assertions instead of mysteries.

const RATE = 48_000;
const BLOCK = 2048; // ~43ms, the tap's real posting size
const LOUD = 0.08;
const ROOM = 0.002;

/** A greyscale map with a 2×2 "cursor" at (cx, cy) — the same stand-in
 *  cursor.test.ts uses, so a found pointer here means the real finder ran. */
function gray(cx: number | null, cy: number | null): GrayMap {
  const w = 48;
  const h = 36;
  const data = new Uint8Array(w * h).fill(40);
  if (cx !== null && cy !== null)
    for (let dy = 0; dy < 2; dy++)
      for (let dx = 0; dx < 2; dx++) data[(cy + dy) * w + (cx + dx)] = 230;
  return { w, h, data };
}

function harness(
  over: Partial<{
    transcribe: (audio: Blob) => Promise<string>;
    split: (text: string, frames: number) => Promise<Array<{ text: string; frame: number | null }>>;
    uploadFrame: (blob: Blob, name: string) => Promise<string>;
  }> = {},
) {
  let clock = 1_000_000;
  const logs: string[] = [];
  const uploaded: string[] = [];
  let audioCb: ((atMs: number, s: Float32Array, rate: number) => void) | null = null;
  let cursorAt = 4;
  const marked: Array<{ cursor: { x: number; y: number } | null }> = [];
  const grabs: number[] = [];

  const grabber = {
    grab: vi.fn(async (): Promise<Grabbed | null> => {
      grabs.push(clock);
      // The pointer walks across the screen, so consecutive frames differ in
      // exactly one small region — which is what the cursor finder looks for.
      cursorAt += 3;
      return {
        jpeg: new Blob([new Uint8Array(16)], { type: 'image/jpeg' }),
        gray: gray(cursorAt % 40, 10),
        w: 1280,
        h: 720,
      };
    }),
    mark: vi.fn(async (frame: Grabbed, cursor: { x: number; y: number } | null) => {
      marked.push({ cursor });
      return frame.jpeg;
    }),
    stop: vi.fn(),
  };

  const tap = {
    onBlock: (cb: (atMs: number, s: Float32Array, rate: number) => void) => {
      audioCb = cb;
    },
    stop: vi.fn(),
  };

  const session = new ReviewSession({
    startCapture: async () => grabber,
    startAudio: async () => tap,
    uploadFrame: over.uploadFrame
      ? over.uploadFrame
      : async (_blob, name) => {
          uploaded.push(name);
          // The real route answers a path with four RANDOM bytes in it: nothing
          // in the answer says which frame it was.
          return `/data/attachments/${Math.random().toString(16).slice(2, 10)}.jpg`;
        },
    transcribe: over.transcribe ?? (async () => 'this button make it pink'),
    split: over.split ?? (async (text) => [{ text, frame: null }]),
    now: () => clock,
    log: (l) => logs.push(l),
  });

  /** Push `ms` of audio at a level, in realistic blocks, advancing the clock. */
  const speak = async (ms: number, rms: number) => {
    const blockMs = (BLOCK / RATE) * 1000;
    for (let d = 0; d < ms; d += blockMs) {
      const samples = new Float32Array(BLOCK).fill(rms);
      audioCb?.(
        session.current.startedAt === null ? 0 : clock - session.current.startedAt,
        samples,
        RATE,
      );
      clock += blockMs;
      await Promise.resolve();
    }
  };

  return { session, grabber, tap, logs, uploaded, marked, grabs, speak, tick: () => clock };
}

describe('ReviewSession', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts recording, then releases both devices on stop', async () => {
    const h = harness();
    await h.session.start();
    expect(h.session.current.phase).toBe('recording');
    await h.session.stop();
    expect(h.session.current.phase).toBe('stopped');
    expect(h.tap.stop).toHaveBeenCalled();
    expect(h.grabber.stop).toHaveBeenCalled();
  });

  it('does NOT leave a live microphone behind when the picker is cancelled', async () => {
    // A recording indicator over a review that never started is exactly the
    // kind of thing that stops people trusting a feature.
    const startAudio = vi.fn();
    const session = new ReviewSession({
      startCapture: async () => {
        throw new DOMException('Permission denied', 'NotAllowedError');
      },
      startAudio: startAudio as never,
      uploadFrame: async () => '/p.jpg',
      transcribe: async () => '',
      split: async (t) => [{ text: t, frame: null }],
      now: () => 0,
    });
    await expect(session.start()).rejects.toThrow();
    expect(startAudio).not.toHaveBeenCalled();
    expect(session.current.phase).toBe('failed');
  });

  it('releases the screen when the MICROPHONE is the thing that fails', async () => {
    const grabber = { grab: vi.fn(), mark: vi.fn(), stop: vi.fn() };
    const session = new ReviewSession({
      startCapture: async () => grabber as never,
      startAudio: async () => {
        throw new DOMException('no mic', 'NotFoundError');
      },
      uploadFrame: async () => '/p.jpg',
      transcribe: async () => '',
      split: async (t) => [{ text: t, frame: null }],
      now: () => 0,
    });
    await expect(session.start()).rejects.toThrow();
    expect(grabber.stop).toHaveBeenCalled();
  });

  it('samples faster while somebody is talking', async () => {
    const h = harness();
    await h.session.start();
    await vi.advanceTimersByTimeAsync(10);
    const idle = h.grabber.grab.mock.calls.length;
    // Idle: one grab every two seconds.
    await vi.advanceTimersByTimeAsync(IDLE_SAMPLE_MS * 2);
    const afterIdle = h.grabber.grab.mock.calls.length - idle;
    expect(afterIdle).toBeLessThanOrEqual(3);

    // Talking: three a second.
    await h.speak(300, LOUD);
    const before = h.grabber.grab.mock.calls.length;
    await vi.advanceTimersByTimeAsync(SAMPLE_MS * 4);
    expect(h.grabber.grab.mock.calls.length - before).toBeGreaterThanOrEqual(3);
  });

  it('turns one utterance into a note with its frames', async () => {
    const h = harness();
    await h.session.start();
    await h.speak(1500, LOUD);
    await vi.advanceTimersByTimeAsync(SAMPLE_MS * 4);
    await h.speak(1200, ROOM); // the pause that ends the utterance
    await vi.advanceTimersByTimeAsync(50);
    await vi.waitFor(() => expect(h.session.current.items[0]?.status).toBe('ready'));

    const note = h.session.current.items[0];
    expect(note?.text).toBe('this button make it pink');
    expect(note?.frames.length).toBeGreaterThan(0);
    expect(note?.endMs).toBeGreaterThan(note?.startMs ?? 0);
  });

  it('shows the note PENDING while it is being transcribed', async () => {
    let release: (t: string) => void = () => {};
    const held = new Promise<string>((r) => {
      release = r;
    });
    const h = harness({ transcribe: () => held });
    await h.session.start();
    await h.speak(1500, LOUD);
    await h.speak(1200, ROOM);
    await vi.advanceTimersByTimeAsync(10);
    expect(h.session.current.items[0]?.status).toBe('pending');
    release('make it pink');
    await vi.waitFor(() => expect(h.session.current.items[0]?.status).toBe('ready'));
  });

  it('transcribes BEFORE uploading, and uploads nothing for a cough', async () => {
    // One clip in five is a chair. A clip that says nothing must not have cost
    // four JPEGs and four rows in the attachments table.
    const h = harness({ transcribe: async () => '' });
    await h.session.start();
    await h.speak(1500, LOUD);
    await vi.advanceTimersByTimeAsync(SAMPLE_MS * 3);
    await h.speak(1200, ROOM);
    await vi.waitFor(() => expect(h.session.current.items).toHaveLength(0));
    expect(h.uploaded).toHaveLength(0);
  });

  it('splits one breath into several notes, each with its own frame', async () => {
    const h = harness({
      split: async () => [
        { text: 'this video should be smaller', frame: 0 },
        { text: 'this button make it pink', frame: 1 },
      ],
    });
    await h.session.start();
    await h.speak(2500, LOUD);
    await vi.advanceTimersByTimeAsync(SAMPLE_MS * 6);
    await h.speak(1200, ROOM);
    await vi.waitFor(() => expect(h.session.current.items.length).toBe(2));
    const [a, b] = h.session.current.items;
    expect(a?.frames).toHaveLength(1);
    expect(b?.frames).toHaveLength(1);
    expect(a?.frames[0]).not.toBe(b?.frames[0]);
  });

  it('keeps the note when the frames fail to upload — the words are the ask', async () => {
    const h = harness({
      uploadFrame: async () => {
        throw new Error('disk full');
      },
    });
    await h.session.start();
    await h.speak(1500, LOUD);
    await vi.advanceTimersByTimeAsync(SAMPLE_MS * 3);
    await h.speak(1200, ROOM);
    await vi.waitFor(() => expect(h.session.current.items[0]?.status).toBe('ready'));
    expect(h.session.current.items[0]?.frames).toEqual([]);
    expect(h.logs.some((l) => l.includes('frame upload failed'))).toBe(true);
  });

  it('marks a failed transcription instead of silently losing the remark', async () => {
    const h = harness({
      transcribe: async () => {
        throw new Error('OpenAI refused the transcription (HTTP 401)');
      },
    });
    await h.session.start();
    await h.speak(1500, LOUD);
    await h.speak(1200, ROOM);
    await vi.waitFor(() => expect(h.session.current.items[0]?.status).toBe('failed'));
    expect(h.session.current.items[0]?.error).toContain('401');
  });

  it('closes the sentence that was still in flight when stop was pressed', async () => {
    // The commonest thing to lose: "…and that's it" followed by reaching for
    // the button.
    const h = harness();
    await h.session.start();
    await h.speak(1500, LOUD);
    expect(h.session.current.items).toHaveLength(0);
    await h.session.stop();
    await vi.waitFor(() => expect(h.session.current.items).toHaveLength(1));
  });

  it('finds the pointer and hands it to the marker', async () => {
    const h = harness();
    await h.session.start();
    await h.speak(1500, LOUD);
    await vi.advanceTimersByTimeAsync(SAMPLE_MS * 5);
    await h.speak(1200, ROOM);
    await vi.waitFor(() => expect(h.session.current.items[0]?.status).toBe('ready'));
    expect(h.marked.length).toBeGreaterThan(0);
    expect(h.marked.some((m) => m.cursor !== null)).toBe(true);
  });

  it('reports a level and a speaking flag for the meter', async () => {
    const h = harness();
    await h.session.start();
    await h.speak(300, LOUD);
    expect(h.session.current.speaking).toBe(true);
    expect(h.session.current.level).toBeGreaterThan(0.3);
    await h.speak(1200, ROOM);
    expect(h.session.current.speaking).toBe(false);
  });

  it('scraps one note and forgets the review on reset', async () => {
    const h = harness();
    await h.session.start();
    await h.speak(1500, LOUD);
    await h.speak(1200, ROOM);
    await vi.waitFor(() => expect(h.session.current.items).toHaveLength(1));
    h.session.scrap(h.session.current.items[0]?.id ?? '');
    expect(h.session.current.items).toHaveLength(0);
    await h.session.stop();
    h.session.reset();
    expect(h.session.current.phase).toBe('idle');
  });

  it('a grab that throws does not end the review', async () => {
    const h = harness();
    h.grabber.grab.mockRejectedValueOnce(new Error('stream ended'));
    await h.session.start();
    await vi.advanceTimersByTimeAsync(IDLE_SAMPLE_MS + 50);
    expect(h.session.current.phase).toBe('recording');
    expect(h.logs.some((l) => l.includes('grab failed'))).toBe(true);
  });
});
