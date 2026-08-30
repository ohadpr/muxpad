import { describe, expect, it } from 'vitest';
import { RingBuffer } from './RingBuffer.js';

describe('RingBuffer', () => {
  it('returns appended chunks in order', () => {
    const r = new RingBuffer(1024);
    r.push('hello ');
    r.push('world');
    expect(r.snapshot()).toBe('hello world');
  });

  it('drops oldest bytes when over capacity', () => {
    const r = new RingBuffer(5);
    r.push('hello ');
    r.push('world');
    expect(r.snapshot().length).toBeLessThanOrEqual(5);
    expect(r.snapshot().endsWith('world')).toBe(true);
  });

  it('handles a single push that exceeds capacity', () => {
    const r = new RingBuffer(3);
    r.push('abcdef');
    expect(r.snapshot()).toBe('def');
  });

  it('ignores empty pushes', () => {
    const r = new RingBuffer(10);
    r.push('');
    r.push('hi');
    r.push('');
    expect(r.snapshot()).toBe('hi');
  });

  it('preserves all data when under capacity', () => {
    const r = new RingBuffer(100);
    for (let i = 0; i < 10; i++) r.push(`${i}`);
    expect(r.snapshot()).toBe('0123456789');
  });
});
