import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ONE_SEND_CAP_MS, freshGuard, isDoubleFire } from './one-send';

describe('one gesture, one message', () => {
  it('lets the first send through', () => {
    expect(isDoubleFire(freshGuard(), 'open the garage', 0)).toBe(false);
  });

  it('refuses the ghost click that follows it', () => {
    // iOS: touchend dismisses the keyboard, the viewport reflows, and the
    // synthesized click lands on the same button ~300ms later.
    const g = { text: 'open the garage', at: 1000 };
    expect(isDoubleFire(g, 'open the garage', 1300)).toBe(true);
  });

  it('lets a DIFFERENT message through immediately', () => {
    const g = { text: 'open the garage', at: 1000 };
    expect(isDoubleFire(g, 'close the garage', 1010)).toBe(false);
  });

  it('lets the same words through once the composer has been edited', () => {
    // Releasing is what typing does. Sending "yes" twice on purpose is fine —
    // you had to type it again, and that clears the guard.
    expect(isDoubleFire(freshGuard(), 'yes', 1010)).toBe(false);
  });

  it('never wedges the composer, even if a release is missed', () => {
    const g = { text: 'yes', at: 0 };
    expect(isDoubleFire(g, 'yes', ONE_SEND_CAP_MS - 1)).toBe(true);
    expect(isDoubleFire(g, 'yes', ONE_SEND_CAP_MS)).toBe(false);
  });
});

describe('the composer is actually wired to it', () => {
  const SRC = readFileSync(join(__dirname, '..', 'components', 'ChatPane.tsx'), 'utf8');

  it('checks the guard before the frame leaves, not after', () => {
    const send = SRC.slice(SRC.indexOf('const sendMessage = () => {'));
    const body = send.slice(0, send.indexOf('\n  const stop ='));
    const guard = body.indexOf('isDoubleFire(');
    const fire = body.indexOf('deliver(outgoing)');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(fire);
    // …and arms it, or the second click of the gesture sees nothing.
    expect(body).toMatch(/sendGuard\.current = \{ text: outgoing/);
  });

  it('releases it on every path that gives the draft back', () => {
    // An edit…
    const edit = SRC.slice(SRC.indexOf('onChange={(text, caret) => {'));
    expect(edit.slice(0, edit.indexOf('}}'))).toMatch(/releaseSendGuard\(\)/);
    // …a socket that died before the ack, and the watchdog's verdict. Both
    // put the text back in the composer, where re-sending it is a NEW
    // message rather than the ghost half of the old gesture.
    expect((SRC.match(/sendGuard\.current = freshGuard\(\)/g) ?? []).length).toBe(3);
    for (const restore of [
      'setInput((prev) => prev || lost);',
      'setInput((prev) => prev || text);',
    ]) {
      const i = SRC.indexOf(restore);
      expect(i, restore).toBeGreaterThan(-1);
      expect(SRC.slice(i, i + 260)).toMatch(/sendGuard\.current = freshGuard\(\)/);
    }
  });
});
