import { describe, expect, it } from 'vitest';
import { MOD, imageToPageCoords, keyEvents, mouseEvent, probeEditable } from './BrowserInput.js';

/**
 * Translating what the human did in their muxpad session into CDP input.
 *
 * Every value here was validated against a real headless Chrome in the spike:
 * typing, a cross-origin iframe payment form, and a drag widget that only
 * reports success on a genuine press/move/release with travel. The tests exist
 * so that stays true.
 */

describe('mouse', () => {
  it('carries the button mask while dragging, or the page sees a hover', () => {
    // A drag widget listens for pointerdown/move/up. Send the moves with
    // buttons: 0 and the browser synthesises a hover — the knob never follows
    // the cursor and the widget silently never completes.
    const move = mouseEvent({ type: 'mouseMoved', x: 10, y: 20, buttons: 1 });
    expect(move).toMatchObject({ type: 'mouseMoved', x: 10, y: 20, buttons: 1, button: 'left' });
  });

  it('reports no button for a plain hover', () => {
    expect(mouseEvent({ type: 'mouseMoved', x: 1, y: 2, buttons: 0 })).toMatchObject({
      buttons: 0,
      button: 'none',
    });
  });

  it('only sends wheel deltas on a wheel event', () => {
    expect(mouseEvent({ type: 'mouseWheel', x: 0, y: 0, deltaY: 120 })).toMatchObject({
      deltaY: 120,
    });
    expect(mouseEvent({ type: 'mousePressed', x: 0, y: 0, buttons: 1 })).not.toHaveProperty(
      'deltaY',
    );
  });

  it('defaults clickCount so a press actually registers as a click', () => {
    expect(mouseEvent({ type: 'mousePressed', x: 0, y: 0, buttons: 1 }).clickCount).toBe(1);
    expect(mouseEvent({ type: 'mouseMoved', x: 0, y: 0 }).clickCount).toBe(0);
  });

  it('rounds coordinates — CDP wants numbers the compositor can hit', () => {
    expect(mouseEvent({ type: 'mousePressed', x: 10.4, y: 20.6, buttons: 1 })).toMatchObject({
      x: 10,
      y: 21,
    });
  });
});

describe('keyboard', () => {
  it('sends a printable character with its text, or the field stays empty', () => {
    // dispatchKeyEvent without `text` produces a keydown the page can observe
    // and no actual input. This is the single most common way a hand-rolled
    // input relay appears to work and types nothing.
    const [down, up] = keyEvents({ key: 'a' });
    expect(down).toMatchObject({ type: 'keyDown', key: 'a', text: 'a', code: 'KeyA' });
    expect(up).toMatchObject({ type: 'keyUp', key: 'a' });
  });

  it('gives named keys their virtual key code and no text', () => {
    const [down] = keyEvents({ key: 'ArrowLeft' });
    expect(down).toMatchObject({ type: 'rawKeyDown', key: 'ArrowLeft', windowsVirtualKeyCode: 37 });
    expect(down).not.toHaveProperty('text');
  });

  it('sends Enter as a carriage return, which is what forms listen for', () => {
    const [down] = keyEvents({ key: 'Enter' });
    expect(down).toMatchObject({ windowsVirtualKeyCode: 13, text: '\r' });
  });

  it('maps digits and letters to the right physical code', () => {
    expect(keyEvents({ key: '4' })[0]).toMatchObject({ code: 'Digit4', windowsVirtualKeyCode: 52 });
    expect(keyEvents({ key: 'Z' })[0]).toMatchObject({ code: 'KeyZ', windowsVirtualKeyCode: 90 });
    expect(keyEvents({ key: ' ' })[0]).toMatchObject({ code: 'Space', windowsVirtualKeyCode: 32 });
  });

  it('treats a modified printable as a shortcut, not as typing', () => {
    // cmd-A must select all, not insert the letter "a".
    const [down] = keyEvents({ key: 'a', modifiers: MOD.meta });
    expect(down.type).toBe('rawKeyDown');
    expect(down).not.toHaveProperty('text');
  });

  it('still types a capital letter, because shift alone is not a shortcut', () => {
    const [down] = keyEvents({ key: 'A', modifiers: MOD.shift });
    expect(down).toMatchObject({ type: 'keyDown', text: 'A' });
  });

  it('passes modifiers through on both down and up', () => {
    const [down, up] = keyEvents({ key: 'ArrowLeft', modifiers: MOD.shift });
    expect(down.modifiers).toBe(MOD.shift);
    expect(up.modifiers).toBe(MOD.shift);
  });
});

describe('coordinates', () => {
  // The viewer renders a JPEG that may be scaled to fit a phone. A click at
  // image pixel (x,y) has to land on the same thing the human saw.
  it('is identity when the image is shown at natural size', () => {
    expect(imageToPageCoords({ x: 100, y: 50 }, { naturalWidth: 1280, deviceWidth: 1280 })).toEqual(
      { x: 100, y: 50 },
    );
  });

  it('scales up when the image is displayed smaller than the page', () => {
    expect(imageToPageCoords({ x: 100, y: 50 }, { naturalWidth: 640, deviceWidth: 1280 })).toEqual({
      x: 200,
      y: 100,
    });
  });

  it('refuses to divide by zero while a frame is mid-decode', () => {
    // naturalWidth is 0 for the instant between assigning src and decoding. A
    // NaN here reaches CDP as a protocol error and the click is simply lost.
    expect(imageToPageCoords({ x: 10, y: 10 }, { naturalWidth: 0, deviceWidth: 1280 })).toBeNull();
  });
});

describe('deciding whether a keyboard belongs on the screen', () => {
  const never = async () => {
    throw new Error('should not have waited');
  };

  it('believes a yes immediately, without a second round trip', async () => {
    let reads = 0;
    const yes = async () => {
      reads++;
      return true;
    };
    expect(await probeEditable(yes, never)).toBe(true);
    expect(reads).toBe(1);
  });

  it('asks again before believing a no', async () => {
    // A page that focuses its input in a click handler answers "no" on the
    // first read. Believing it takes the keyboard away from somebody who just
    // tapped a login box.
    const answers = [false, true];
    const waits: number[] = [];
    const read = async () => answers.shift() ?? false;
    expect(
      await probeEditable(read, async (ms) => {
        waits.push(ms);
      }),
    ).toBe(true);
    expect(waits).toEqual([150]);
  });

  it('says no when it is still no', async () => {
    expect(await probeEditable(async () => false, async () => {})).toBe(false);
  });
});
