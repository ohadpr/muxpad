/**
 * Showing a phone a phone site.
 *
 * A 1280px desktop page pinch-zoomed on a 390px screen is legible the way a
 * newspaper read through a keyhole is legible. Sites already have a layout for
 * this and simply need to be told, so when a person takes the wheel from a
 * phone the browser starts behaving like one.
 *
 * A TOGGLE, not a mode the browser lives in. An agent scraping a desktop site
 * must not silently get the mobile layout — it is frequently a different,
 * smaller site with things missing, and a scrape that quietly loses half the
 * page is worse than one that fails.
 */

/** A mainstream phone. Narrow enough to trip the layout breakpoints sites use. */
export const MOBILE_DEVICE = {
  width: 390,
  height: 844,
  scale: 3,
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
} as const;

export interface EmulationParams {
  /** Params for Emulation.setDeviceMetricsOverride, or null to clear. */
  metrics: Record<string, unknown> | null;
  touch: { enabled: boolean; maxTouchPoints?: number };
  /** Params for Emulation.setUserAgentOverride, or null to clear. */
  userAgent: { userAgent: string } | null;
}

/**
 * All three signals, together.
 *
 * Metrics alone yields a narrow DESKTOP page: many sites switch on the user
 * agent and plenty switch on touch support, so sending one without the others
 * gets a layout that matches nothing.
 */
export function emulationParams(mobile: boolean): EmulationParams {
  if (!mobile) {
    return { metrics: null, touch: { enabled: false }, userAgent: null };
  }
  return {
    metrics: {
      width: MOBILE_DEVICE.width,
      height: MOBILE_DEVICE.height,
      deviceScaleFactor: MOBILE_DEVICE.scale,
      mobile: true,
      screenWidth: MOBILE_DEVICE.width,
      screenHeight: MOBILE_DEVICE.height,
    },
    touch: { enabled: true, maxTouchPoints: 5 },
    userAgent: { userAgent: MOBILE_DEVICE.userAgent },
  };
}
