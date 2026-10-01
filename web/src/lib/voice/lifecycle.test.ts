// THE BUG THAT MADE VOICE MODE SILENT, PINNED DOWN.
//
// `unlockPlayback` is four lines of DOM and it cost the feature its entire
// point: the user could talk to the model, watch its transcript scroll past,
// watch the agent work — and never hear one sound, with nothing logged
// anywhere. The cause is a piece of HTMLMediaElement behaviour that is easy to
// disbelieve and is faithfully modelled by the fake below:
//
//   `play()` ON AN ELEMENT WITH NO SOURCE NEVER SETTLES.
//
// Not "rejects". Not "resolves and does nothing". The resource selection
// algorithm ends in NETWORK_EMPTY with the element waiting for a source to
// appear, and the promise stays pending for the life of the page. Verified in
// Chrome 140; the same shape in Safari. So `await el.play()` in a function that
// unmutes AFTERWARDS never unmutes anything.
//
// These tests use a hand-written fake rather than jsdom's HTMLMediaElement,
// which has no playback model at all (`play()` throws "Not implemented") and
// would therefore agree with any implementation, correct or not.

import { describe, expect, it } from 'vitest';
import { isSilentlyBlocked, unlockPlayback } from './lifecycle';

interface FakeAudio {
  muted: boolean;
  volume: number;
  paused: boolean;
  src: string;
  srcObject: MediaStream | null;
  playCalls: number;
  play(): Promise<void>;
  pause(): void;
  load(): void;
  removeAttribute(name: string): void;
  /** Was the element ever actually played? The iOS "blessing" this function
   *  exists to obtain requires a real play, not an attempted one. */
  everPlayed: boolean;
}

/** Models the real element's playback rules, including the pending-forever one. */
function fakeAudio(opts: { refusePlay?: boolean } = {}): FakeAudio {
  const el: FakeAudio = {
    muted: false,
    volume: 1,
    paused: true,
    src: '',
    srcObject: null,
    playCalls: 0,
    everPlayed: false,
    play() {
      el.playCalls += 1;
      // No source of any kind: NETWORK_EMPTY, and the promise never settles.
      if (!el.src && !el.srcObject) return new Promise<void>(() => {});
      if (opts.refusePlay) return Promise.reject(new Error('NotAllowedError'));
      el.paused = false;
      el.everPlayed = true;
      return Promise.resolve();
    },
    pause() {
      el.paused = true;
    },
    load() {
      el.paused = true;
    },
    removeAttribute(name) {
      if (name === 'src') el.src = '';
    },
  };
  return el;
}

const asEl = (f: FakeAudio) => f as unknown as HTMLAudioElement;

describe('unlockPlayback', () => {
  it('leaves the element UNMUTED — the whole bug in one assertion', async () => {
    const el = fakeAudio();
    await unlockPlayback(asEl(el));
    expect(el.muted).toBe(false);
    expect(el.volume).toBe(1);
  });

  it('returns instead of hanging forever on a source-less element', async () => {
    const el = fakeAudio();
    // If `unlockPlayback` awaits a play() with no source, this never resolves
    // and the test times out — which is exactly what the shipped code did.
    const done = await Promise.race([
      unlockPlayback(asEl(el)).then(() => 'returned'),
      new Promise((r) => setTimeout(() => r('HUNG'), 250)),
    ]);
    expect(done).toBe('returned');
  });

  it('actually plays something, so the element is blessed for later playback', async () => {
    const el = fakeAudio();
    await unlockPlayback(asEl(el));
    expect(el.everPlayed).toBe(true);
    // ...and cleans up after itself, so the remote track can take the element.
    expect(el.src).toBe('');
    expect(el.srcObject).toBe(null);
  });

  it('unmutes even when playback is refused outright', async () => {
    const el = fakeAudio({ refusePlay: true });
    await unlockPlayback(asEl(el));
    expect(el.muted).toBe(false);
    expect(el.volume).toBe(1);
  });

  it('just plays when a stream is already attached', async () => {
    const el = fakeAudio();
    el.srcObject = {} as MediaStream;
    await unlockPlayback(asEl(el));
    expect(el.paused).toBe(false);
    expect(el.muted).toBe(false);
  });
});

describe('isSilentlyBlocked', () => {
  it('is false before any audio has arrived — there is nothing to be silent about', () => {
    const el = fakeAudio();
    expect(isSilentlyBlocked(asEl(el))).toBe(false);
  });

  it('catches the failure that actually shipped: playing, and muted', () => {
    const el = fakeAudio();
    el.srcObject = {} as MediaStream;
    el.paused = false;
    el.muted = true;
    // `paused` alone says everything is fine here. It is not fine.
    expect(el.paused).toBe(false);
    expect(isSilentlyBlocked(asEl(el))).toBe(true);
  });

  it('catches refused playback', () => {
    const el = fakeAudio();
    el.srcObject = {} as MediaStream;
    el.paused = true;
    expect(isSilentlyBlocked(asEl(el))).toBe(true);
  });

  it('catches a zeroed volume', () => {
    const el = fakeAudio();
    el.srcObject = {} as MediaStream;
    el.paused = false;
    el.volume = 0;
    expect(isSilentlyBlocked(asEl(el))).toBe(true);
  });

  it('is false for a healthy, audible element', () => {
    const el = fakeAudio();
    el.srcObject = {} as MediaStream;
    el.paused = false;
    expect(isSilentlyBlocked(asEl(el))).toBe(false);
  });
});
