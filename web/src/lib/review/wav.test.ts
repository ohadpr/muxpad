import { describe, expect, it } from 'vitest';
import { WAV_SAMPLE_RATE, concatPcm, encodeWav, pcmDurationMs, resample } from './wav';

async function bytesOf(blob: Blob): Promise<DataView> {
  return new DataView(await blob.arrayBuffer());
}
const ascii = (v: DataView, at: number, len: number) =>
  Array.from({ length: len }, (_, i) => String.fromCharCode(v.getUint8(at + i))).join('');

describe('encodeWav', () => {
  it('writes a header a transcriber will accept', async () => {
    const v = await bytesOf(encodeWav(new Float32Array(100), 16_000));
    expect(ascii(v, 0, 4)).toBe('RIFF');
    expect(ascii(v, 8, 4)).toBe('WAVE');
    expect(ascii(v, 12, 4)).toBe('fmt ');
    expect(ascii(v, 36, 4)).toBe('data');
    expect(v.getUint16(20, true)).toBe(1); // PCM
    expect(v.getUint16(22, true)).toBe(1); // mono
    expect(v.getUint32(24, true)).toBe(16_000);
    expect(v.getUint32(28, true)).toBe(32_000); // byte rate
    expect(v.getUint16(34, true)).toBe(16);
    expect(v.getUint32(40, true)).toBe(200); // 100 samples × 2 bytes
    expect(v.byteLength).toBe(244);
  });

  it('CLAMPS a clipping mic instead of wrapping it', async () => {
    // 1.4 × 32767 overflows Int16 and wraps to a large NEGATIVE — audible as a
    // crack, and in a transcript as a word nobody said.
    const v = await bytesOf(encodeWav(new Float32Array([1.4, -1.9, 0.5]), 16_000));
    expect(v.getInt16(44, true)).toBe(32767);
    expect(v.getInt16(46, true)).toBe(-32767);
    expect(v.getInt16(48, true)).toBe(16384);
  });

  it('round-trips the duration it claims', () => {
    expect(pcmDurationMs(new Float32Array(WAV_SAMPLE_RATE * 2))).toBe(2000);
  });
});

describe('resample', () => {
  it('takes 48k down to 16k, keeping every third sample', () => {
    const src = new Float32Array(48).map((_, i) => i / 48);
    const out = resample(src, 48_000, 16_000);
    expect(out.length).toBe(16);
    expect(out[0]).toBeCloseTo(src[0] as number);
    expect(out[1]).toBeCloseTo(src[3] as number);
  });

  it('is a no-op at the target rate', () => {
    const src = new Float32Array([0.1, 0.2]);
    expect(resample(src, 16_000, 16_000)).toBe(src);
  });
});

describe('concatPcm', () => {
  it('joins the capture tap blocks in order', () => {
    const out = concatPcm([new Float32Array([1, 2]), new Float32Array([3]), new Float32Array([])]);
    expect(Array.from(out)).toEqual([1, 2, 3]);
  });

  it('is empty for no blocks', () => {
    expect(concatPcm([]).length).toBe(0);
  });
});
