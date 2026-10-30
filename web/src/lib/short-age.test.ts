import { describe, expect, it } from 'vitest';
import { activeAge, shortAge } from './short-age';

const s = (n: number) => n * 1000;
const m = (n: number) => n * 60_000;
const h = (n: number) => n * 3_600_000;

/**
 * An age in a column the eye passes over rather than reads: one unit, no
 * "ago", no punctuation.
 */
describe('shortAge', () => {
  it('rounds rather than truncates, because the failure is reading as zero', () => {
    // A row that says "0m" and a row that says nothing look the same at a
    // glance, and one of them is wrong.
    expect(shortAge(s(46))).toBe('1m');
    expect(shortAge(m(46))).toBe('1h');
    expect(shortAge(h(37))).toBe('2d');
  });

  it('never goes negative on a clock that disagrees with itself', () => {
    // Server stamp, client clock. They do not have to agree, and "-3s" is a
    // bug report waiting to happen.
    expect(shortAge(-5000)).toBe('0s');
  });

  it('uses one unit at each scale', () => {
    expect(shortAge(s(5))).toBe('5s');
    expect(shortAge(m(5))).toBe('5m');
    expect(shortAge(h(5))).toBe('5h');
    expect(shortAge(h(72))).toBe('3d');
  });
});

/**
 * The band decays at sixteen hours, so its ages live in minutes and hours and
 * a seconds column is noise that changes under the pointer.
 */
describe('activeAge', () => {
  it('says `now` for a chat you are in the middle of', () => {
    // The honest answer, and the only one that does not tick.
    expect(activeAge(0)).toBe('now');
    expect(activeAge(s(80))).toBe('now');
  });

  it('counts in minutes and hours past that', () => {
    expect(activeAge(m(12))).toBe('12m');
    expect(activeAge(h(3))).toBe('3h');
  });

  it('is still readable at the decay boundary, which is sixteen hours', () => {
    expect(activeAge(h(16))).toBe('16h');
  });
});
