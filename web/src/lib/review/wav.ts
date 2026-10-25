// WHY WE ENCODE OUR OWN WAV, WHEN MediaRecorder EXISTS.
//
// The clips this feature uploads are cut on SILENCE (segment.ts), at a boundary
// the audio decides — and MediaRecorder cannot cut there. Its `dataavailable`
// slices are container-relative: the first blob carries the webm/ogg headers
// and every later one does not, so a slice taken at an arbitrary moment is only
// decodable when concatenated with its predecessors. Stopping and restarting
// the recorder for every utterance works, roughly, and loses the first ~100ms
// of each one to the restart — which is exactly the part that carries the first
// word.
//
// So the page keeps raw PCM from an AnalyserNode-adjacent tap and writes a WAV
// per utterance. A WAV is 44 bytes of header and the samples; at 16 kHz mono
// 16-bit that is 32 KB/s, so a ten-second remark is 320 KB — the same order as
// one of the JPEG frames it travels with, and every batch transcription
// endpoint accepts it without negotiation.
//
// 16 kHz because every speech recognizer downsamples to it anyway; sending 48
// kHz would triple the upload to be thrown away upstream.

/** The rate we resample to. Speech recognizers work at 16 kHz. */
export const WAV_SAMPLE_RATE = 16_000;

/**
 * Nearest-neighbour resample. NOT a good resampler — it is the right one here:
 * the consumer is a speech model, the source is a 48 kHz mic, and the aliasing
 * a box filter would remove sits above the band the model uses. A real
 * polyphase filter would cost a dependency and buy nothing measurable.
 */
export function resample(
  samples: Float32Array,
  fromRate: number,
  toRate: number = WAV_SAMPLE_RATE,
): Float32Array {
  if (fromRate === toRate || samples.length === 0) return samples;
  const ratio = fromRate / toRate;
  const out = new Float32Array(Math.max(1, Math.floor(samples.length / ratio)));
  for (let i = 0; i < out.length; i++) out[i] = samples[Math.floor(i * ratio)] as number;
  return out;
}

/** Join PCM blocks into one buffer. The capture tap hands over a few hundred
 *  128-sample blocks per second; an utterance is however many of those. */
export function concatPcm(blocks: readonly Float32Array[]): Float32Array {
  let total = 0;
  for (const b of blocks) total += b.length;
  const out = new Float32Array(total);
  let at = 0;
  for (const b of blocks) {
    out.set(b, at);
    at += b.length;
  }
  return out;
}

/**
 * One mono 16-bit WAV, header and all.
 *
 * Clamping is load-bearing: a mic that clips hands back values outside ±1, and
 * `Math.round(1.4 * 32767)` wraps to a large negative in Int16 — audible as a
 * crack, and in a transcript as a word nobody said.
 */
export function encodeWav(pcm: Float32Array, sampleRate: number = WAV_SAMPLE_RATE): Blob {
  const bytes = new ArrayBuffer(44 + pcm.length * 2);
  const view = new DataView(bytes);
  const ascii = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + pcm.length * 2, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits
  ascii(36, 'data');
  view.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) {
    const v = Math.max(-1, Math.min(1, pcm[i] as number));
    view.setInt16(44 + i * 2, Math.round(v * 32767), true);
  }
  return new Blob([bytes], { type: 'audio/wav' });
}

/** Seconds of audio in a PCM buffer, for logs and for the UI's duration. */
export function pcmDurationMs(pcm: Float32Array, sampleRate = WAV_SAMPLE_RATE): number {
  return Math.round((pcm.length / sampleRate) * 1000);
}
