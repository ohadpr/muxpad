// THE PLATFORM HALF. Deliberately dumb: every decision lives in session.ts,
// and everything here is "ask the browser, hand back bytes".
//
// ─── Things this file knows that cost somebody a day ───────────────────────
//
// · `cursor: 'always'` is why the feature works at all. Without it the pointer
//   is not in the pixels and "this one, here" means nothing. It is not in
//   TypeScript's MediaTrackConstraints, hence the cast — and if a browser
//   rejects it we LOG rather than carrying on silently, because a review with
//   no pointer looks like a review with a broken cursor finder.
//
// · A `getDisplayMedia` call must come from a user gesture, and it opens the
//   browser's own picker. NEVER call it from a probe, a retry or a background
//   check: a headless probe reached the picker once and hung for thirty
//   minutes with nothing on screen to cancel.
//
// · The AudioContext is created and resumed BEFORE the awaits that follow it.
//   A context constructed after an await starts suspended, and a suspended
//   context's analyser reads exactly zero — which looks precisely like a dead
//   microphone. The spike lost an evening to that, twice.
//
// · The capture track ENDS when the user clicks Chrome's own "Stop sharing"
//   bar, and that bar is more prominent than anything muxpad draws. A review
//   that kept running against a dead stream would sample black frames, so the
//   grabber reports it and the session stops itself.

import { drawMark } from './mark';
import type { AudioTap, FrameGrabber, Grabbed } from './session';

/** The long edge of an uploaded frame. 1280px holds legible UI text at JPEG
 *  q0.7 for ~70 KB, measured. */
export const FRAME_WIDTH = 1280;
export const FRAME_QUALITY = 0.7;

/** The greyscale map's size — the basis of both the hash and the cursor diff.
 *  48×36 is 1728 cells, so one cell is ~27px of a 1280px frame: coarse enough
 *  to ignore antialiasing, fine enough that a ring lands on the right button. */
export const GRAY_W = 48;
export const GRAY_H = 36;

function toBlob(canvas: HTMLCanvasElement, quality = FRAME_QUALITY): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
}

export interface ScreenCaptureOpts {
  log?: (line: string) => void;
  /** Called when the stream ends on its own — the user pressed the browser's
   *  own "Stop sharing". */
  onEnded?: () => void;
}

/**
 * Open the picker, and hand back something that can sample it.
 *
 * Throws on cancel (a `NotAllowedError`), which is a normal outcome: the picker
 * IS the consent moment, and declining it is a decision, not a failure.
 */
export async function startScreenCapture(opts: ScreenCaptureOpts = {}): Promise<FrameGrabber> {
  const md = navigator.mediaDevices;
  if (!md?.getDisplayMedia) throw new Error('This browser can’t share a screen.');
  const stream = await md.getDisplayMedia({
    // `cursor` is not in the TS lib; it is in the spec and in Chrome, and it is
    // the single most load-bearing constraint in this feature.
    video: { cursor: 'always', frameRate: 8 } as MediaTrackConstraints,
    audio: false,
  });
  const track = stream.getVideoTracks()[0];
  if (track) {
    const settings = track.getSettings() as MediaTrackSettings & { cursor?: string };
    if (settings.cursor && settings.cursor !== 'always')
      opts.log?.(
        `the browser refused cursor:always (got ${settings.cursor}) — frames may not show the pointer`,
      );
    track.addEventListener('ended', () => opts.onEnded?.());
  }

  // EVERYTHING BELOW CAN THROW, and the stream is already live by now: a
  // canvas that will not give a 2d context, a video element that refuses — any
  // of them used to leave a screen share running with nobody holding it and
  // the browser's "you are sharing" bar up over nothing.
  const release = () => {
    for (const t of stream.getTracks()) t.stop();
  };
  try {
    return await buildGrabber(stream, track ?? null, opts);
  } catch (e) {
    release();
    throw e;
  }
}

async function buildGrabber(
  stream: MediaStream,
  track: MediaStreamTrack | null,
  opts: ScreenCaptureOpts,
): Promise<FrameGrabber> {
  const video = document.createElement('video');
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  await video.play().catch(() => {
    // A paused element still paints frames once metadata has arrived; a
    // rejected play() here is not fatal and must not lose the session.
  });
  // The first frame is not necessarily available the instant play() resolves.
  await new Promise<void>((resolve) => {
    if (video.videoWidth > 0) return resolve();
    const done = () => resolve();
    video.addEventListener('loadedmetadata', done, { once: true });
    setTimeout(done, 1500);
  });

  const big = document.createElement('canvas');
  const small = document.createElement('canvas');
  small.width = GRAY_W;
  small.height = GRAY_H;
  const bigCtx = big.getContext('2d');
  const smallCtx = small.getContext('2d', { willReadFrequently: true });
  if (!bigCtx || !smallCtx) throw new Error('This browser can’t read a canvas.');

  const size = () => {
    const vw = video.videoWidth || FRAME_WIDTH;
    const vh = video.videoHeight || Math.round((FRAME_WIDTH * 9) / 16);
    const w = Math.min(FRAME_WIDTH, vw);
    return { w, h: Math.max(1, Math.round((vh / vw) * w)) };
  };

  return {
    async grab(): Promise<Grabbed | null> {
      if (track && track.readyState === 'ended') return null;
      const { w, h } = size();
      if (big.width !== w || big.height !== h) {
        big.width = w;
        big.height = h;
      }
      bigCtx.drawImage(video, 0, 0, w, h);
      smallCtx.drawImage(big, 0, 0, GRAY_W, GRAY_H);
      const px = smallCtx.getImageData(0, 0, GRAY_W, GRAY_H).data;
      const gray = new Uint8Array(GRAY_W * GRAY_H);
      for (let i = 0; i < gray.length; i++) {
        // Rec. 601 luma, integer-weighted — the cheapest thing that tracks
        // perceived brightness rather than the blue channel's opinion of it.
        const o = i * 4;
        gray[i] =
          ((px[o] as number) * 77 + (px[o + 1] as number) * 150 + (px[o + 2] as number) * 29) >> 8;
      }
      const jpeg = await toBlob(big);
      return jpeg ? { jpeg, gray: { w: GRAY_W, h: GRAY_H, data: gray }, w, h } : null;
    },

    async mark(frame, cursor) {
      if (!cursor) return frame.jpeg;
      let bitmap: ImageBitmap;
      try {
        bitmap = await createImageBitmap(frame.jpeg);
      } catch {
        return frame.jpeg;
      }
      const out = document.createElement('canvas');
      out.width = frame.w;
      out.height = frame.h;
      const ctx = out.getContext('2d');
      if (!ctx) return frame.jpeg;
      ctx.drawImage(bitmap, 0, 0, frame.w, frame.h);
      drawMark(ctx, bitmap, frame.w, frame.h, cursor);
      bitmap.close?.();
      // A marked frame is re-encoded slightly higher: the inset is the part a
      // reader actually squints at, and JPEG artefacts on a 4× blow-up of an
      // already-lossy frame are the difference between legible and not.
      return (await toBlob(out, 0.82)) ?? frame.jpeg;
    },

    stop() {
      for (const t of stream.getTracks()) t.stop();
      video.srcObject = null;
    },
  };
}

/**
 * The microphone tap: blocks of PCM and nothing else.
 *
 * An AudioWorklet, with a ScriptProcessor fallback. The worklet is the modern
 * path and runs off the main thread; the fallback exists because `addModule`
 * needs a Blob URL to work without a build-time asset, and a CSP that forbids
 * `blob:` would otherwise take the whole feature out.
 */
export async function startMicTap(): Promise<AudioTap> {
  const md = navigator.mediaDevices;
  if (!md?.getUserMedia) throw new Error('This browser can’t capture audio.');
  const stream = await md.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  // THE MICROPHONE IS LIVE FROM HERE. An AudioContext constructor that throws
  // (no device, a locked-down browser) left the recording dot on with nothing
  // to turn it off — measured in review as a stop count of zero.
  try {
    return await buildTap(stream);
  } catch (e) {
    for (const t of stream.getTracks()) t.stop();
    throw e;
  }
}

async function buildTap(stream: MediaStream): Promise<AudioTap> {
  // Created and resumed up front — see the note at the top of this file.
  const ctx = new AudioContext();
  if (ctx.state === 'suspended') await ctx.resume();
  const source = ctx.createMediaStreamSource(stream);

  let onBlockCb: ((atMs: number, s: Float32Array, rate: number) => void) | null = null;
  const t0 = performance.now();
  const emit = (samples: Float32Array) => {
    onBlockCb?.(performance.now() - t0, samples, ctx.sampleRate);
  };

  let teardown = () => {};
  const worklet = `
    class Tap extends AudioWorkletProcessor {
      constructor() { super(); this.buf = new Float32Array(2048); this.at = 0; }
      process(inputs) {
        const ch = inputs[0] && inputs[0][0];
        if (!ch) return true;
        for (let i = 0; i < ch.length; i++) {
          this.buf[this.at++] = ch[i];
          if (this.at === this.buf.length) {
            this.port.postMessage(this.buf.slice(0));
            this.at = 0;
          }
        }
        return true;
      }
    }
    registerProcessor('muxpad-review-tap', Tap);
  `;
  let workletUrl: string | null = null;
  try {
    workletUrl = URL.createObjectURL(new Blob([worklet], { type: 'text/javascript' }));
    await ctx.audioWorklet.addModule(workletUrl);
    const node = new AudioWorkletNode(ctx, 'muxpad-review-tap');
    node.port.onmessage = (e: MessageEvent) => emit(e.data as Float32Array);
    source.connect(node);
    // A worklet with no destination is still pulled in Chrome, but not
    // everywhere; a muted gain node is the portable way to keep the graph
    // running without making a sound.
    const sink = ctx.createGain();
    sink.gain.value = 0;
    node.connect(sink).connect(ctx.destination);
    teardown = () => {
      node.port.onmessage = null;
      node.disconnect();
      sink.disconnect();
    };
  } catch {
    // The fallback path. The Blob URL is revoked in the `finally` below either
    // way — leaking one per failed start is small and permanent.
    const node = ctx.createScriptProcessor(2048, 1, 1);
    node.onaudioprocess = (e: AudioProcessingEvent) => {
      emit(new Float32Array(e.inputBuffer.getChannelData(0)));
    };
    source.connect(node);
    const sink = ctx.createGain();
    sink.gain.value = 0;
    node.connect(sink).connect(ctx.destination);
    teardown = () => {
      node.onaudioprocess = null;
      node.disconnect();
      sink.disconnect();
    };
  } finally {
    if (workletUrl) URL.revokeObjectURL(workletUrl);
  }

  return {
    onBlock(cb) {
      onBlockCb = cb;
    },
    stop() {
      onBlockCb = null;
      teardown();
      source.disconnect();
      // Releasing the tracks is what turns off the browser's recording dot;
      // leaving them live is how you get "still listening" over a finished
      // review.
      for (const t of stream.getTracks()) t.stop();
      void ctx.close();
    },
  };
}

/** Does this browser have the two calls a review needs? Used to hide the
 *  control rather than offer one that cannot work. */
export const REVIEW_SUPPORTED =
  typeof navigator !== 'undefined' &&
  !!navigator.mediaDevices?.getDisplayMedia &&
  !!navigator.mediaDevices?.getUserMedia;
