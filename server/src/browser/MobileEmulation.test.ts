import { describe, expect, it } from 'vitest';
import { MOBILE_DEVICE, emulationParams } from './MobileEmulation.js';

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
