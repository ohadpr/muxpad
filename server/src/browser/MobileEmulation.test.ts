import { describe, expect, it } from 'vitest';
import {
  MOBILE_DEVICE,
  emulationParams,
  phoneViewport,
  shouldReloadForSignals,
  typedInputExpression,
} from './MobileEmulation.js';

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

describe('reloading when the screen signals change', () => {
  it('refetches a page nobody has touched — that is what gives a phone layout', () => {
    expect(shouldReloadForSignals({ signalsChanged: true, hasTypedInput: false })).toBe(true);
  });

  it('NEVER refetches a page with something typed into it', () => {
    // THE BUG THIS IS. An agent walked a parking-citation payment to the card
    // step and summoned a person; the handoff was opened on a phone; the
    // signals flipped desktop→mobile; the page reloaded; the card fields
    // emptied, the captcha rotated and the portal fell back to step 1. Three
    // times. It read as the site signing the person out.
    expect(shouldReloadForSignals({ signalsChanged: true, hasTypedInput: true })).toBe(false);
  });

  it('does not reload for a pure resize either way', () => {
    // Turning a phone is not a new page.
    expect(shouldReloadForSignals({ signalsChanged: false, hasTypedInput: false })).toBe(false);
    expect(shouldReloadForSignals({ signalsChanged: false, hasTypedInput: true })).toBe(false);
  });
});

describe('the probe that asks whether a page holds anything', () => {
  /**
   * The expression runs in a browser; this runs it against a hand-built
   * document, so the DECISIONS it makes are under test even though the
   * server project has no DOM. The selector string is checked separately
   * below — that part a fake cannot vouch for.
   */
  const ask = (elements: unknown[]): boolean => {
    const doc = {
      querySelectorAll: (sel: string) => (sel === 'iframe' ? [] : elements),
    };
    return Boolean(new Function('document', `return ${typedInputExpression()}`)(doc));
  };
  const field = (o: Record<string, unknown>) => ({
    type: 'text',
    value: '',
    defaultValue: '',
    checked: false,
    isContentEditable: false,
    textContent: '',
    ...o,
  });

  it('sees a typed value, a ticked box and an edited block', () => {
    expect(ask([field({ value: '4242424242424242' })])).toBe(true);
    expect(ask([field({ type: 'checkbox', checked: true })])).toBe(true);
    expect(ask([field({ isContentEditable: true, textContent: 'half a comment' })])).toBe(true);
  });

  it('is not fooled by an empty form, or by a value the page itself put there', () => {
    expect(ask([])).toBe(false);
    expect(ask([field({}), field({ type: 'checkbox' })])).toBe(false);
    // A default the server rendered is not something a person would lose.
    expect(ask([field({ value: 'United States', defaultValue: 'United States' })])).toBe(false);
  });

  it('ignores the controls nobody types into', () => {
    expect(ask([field({ type: 'hidden', value: 'csrf-token' })])).toBe(false);
    expect(ask([field({ type: 'submit', value: 'Pay $107.26' })])).toBe(false);
    expect(ask([field({ type: 'button', value: 'Cancel' })])).toBe(false);
  });

  it('answers TRUE when it cannot tell, because the cost is asymmetric', () => {
    // Losing a layout is a bad minute; losing a filled checkout is an evening.
    const exploding = {
      querySelectorAll: () => {
        throw new Error('cross-origin');
      },
    };
    expect(Boolean(new Function('document', `return ${typedInputExpression()}`)(exploding))).toBe(
      true,
    );
  });

  it('asks about every control a person can put something into', () => {
    // The one thing the fake above cannot vouch for: the selector itself.
    for (const control of ['input', 'textarea', 'select', 'contenteditable'])
      expect(typedInputExpression(), control).toContain(control);
    // And it looks inside same-origin frames, which is where card fields live.
    expect(typedInputExpression()).toContain('iframe');
  });
});
