import { describe, expect, it } from 'vitest';
import { MOBILE_DEVICE, emulationParams, phoneViewport } from './MobileEmulation.js';

/**
 * Showing a phone a phone site.
 *
 * A 1280px desktop page pinch-zoomed on a 390px screen is legible in the way a
 * newspaper read through a keyhole is legible. Sites already have a layout for
 * this; they just need to be told. So when a person takes the wheel from a
 * phone, the browser starts behaving like one.
 *
 * It is a TOGGLE, not a mode the browser lives in: an agent scraping a desktop
 * site should not silently get the mobile layout, which is frequently a
 * different, smaller site with things missing.
 */

describe('what mobile emulation sends', () => {
  it('sets phone metrics, touch, and a phone user agent together', () => {
    // All three or none. Metrics alone gives a narrow desktop page — many sites
    // switch on the user agent, and plenty switch on touch support.
    const p = emulationParams(true);
    expect(p.metrics).toMatchObject({
      width: MOBILE_DEVICE.width,
      height: MOBILE_DEVICE.height,
      deviceScaleFactor: MOBILE_DEVICE.scale,
      mobile: true,
    });
    expect(p.touch).toMatchObject({ enabled: true });
    expect(p.userAgent?.userAgent).toMatch(/iPhone|Mobile/i);
  });

  it('clears all three on the way back', () => {
    const p = emulationParams(false);
    expect(p.metrics).toBeNull();
    expect(p.touch).toMatchObject({ enabled: false });
    expect(p.userAgent).toBeNull();
  });

  it('uses a device narrow enough to trigger a mobile layout', () => {
    // Sites commonly break at 768px. A "mobile" width above that gets the
    // desktop layout anyway, which is the whole thing this avoids.
    expect(MOBILE_DEVICE.width).toBeLessThan(768);
  });
});

describe('the page takes the shape of the screen looking at it', () => {
  /**
   * A fixed 390x844 is wrong the moment somebody turns their phone: the page
   * keeps its portrait shape, the viewer is twice as wide as it is tall, and the
   * difference is a black half-screen beside a column of website. That is what a
   * landscape screenshot of this showed.
   */
  it('takes the viewer’s size when it is given one', () => {
    expect(phoneViewport({ width: 844, height: 390 })).toEqual({ width: 844, height: 390 });
  });

  it('falls back to a phone when nothing is offered', () => {
    expect(phoneViewport(null)).toEqual({
      width: MOBILE_DEVICE.width,
      height: MOBILE_DEVICE.height,
    });
    expect(phoneViewport(undefined)).toEqual({
      width: MOBILE_DEVICE.width,
      height: MOBILE_DEVICE.height,
    });
  });

  it('refuses a zero, which collapses the layout rather than shrinking it', () => {
    expect(phoneViewport({ width: 0, height: 0 })).toEqual({
      width: MOBILE_DEVICE.width,
      height: MOBILE_DEVICE.height,
    });
  });

  it('refuses something enormous, which is a request to allocate a surface', () => {
    // These go straight into the renderer's viewport.
    expect(phoneViewport({ width: 99_999, height: 99_999 }).width).toBe(MOBILE_DEVICE.width);
  });

  it('refuses nonsense without taking the browser with it', () => {
    expect(phoneViewport({ width: Number.NaN, height: Number.POSITIVE_INFINITY })).toEqual({
      width: MOBILE_DEVICE.width,
      height: MOBILE_DEVICE.height,
    });
  });

  it('carries the size into the metrics, screen included', () => {
    // screenWidth/Height matter too: sites read screen.width, and a page told it
    // is on a 390px screen inside an 844px viewport lays out for neither.
    const p = emulationParams(true, { width: 844, height: 390 });
    expect(p.metrics).toMatchObject({
      width: 844,
      height: 390,
      screenWidth: 844,
      screenHeight: 390,
    });
  });

  it('still clears everything when mobile is off', () => {
    expect(emulationParams(false, { width: 844, height: 390 }).metrics).toBeNull();
  });
});
