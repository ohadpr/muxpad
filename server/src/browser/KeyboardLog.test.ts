import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  KEYBOARD_LOG_CAP,
  appendKeyboardLog,
  keyboardLogLine,
  keyboardLogPath,
} from './KeyboardLog.js';

const dir = () => mkdtempSync(`${tmpdir()}/kblog-`);

describe('the line a keyboard report becomes', () => {
  it('keeps the events in the order they happened', () => {
    // The whole value of the log is the ORDER: a shrink then a growth with no
    // blur between them is a different bug from a blur.
    const line = keyboardLogLine(0, { events: [{ what: 'sink focus' }, { what: 'viewport' }] });
    expect(line).not.toBeNull();
    const parsed = JSON.parse(line as string);
    expect(parsed.events.map((e: { what: string }) => e.what)).toEqual(['sink focus', 'viewport']);
  });

  it('stamps a readable time, because it is read by eye', () => {
    const parsed = JSON.parse(keyboardLogLine(0, { events: [{ what: 'tap' }] }) as string);
    expect(parsed.at).toBe('1970-01-01T00:00:00.000Z');
  });

  it('ends in a newline so one report is one line', () => {
    expect(keyboardLogLine(0, { events: [{ what: 'tap' }] })?.endsWith('\n')).toBe(true);
  });

  it('refuses a report with nothing in it', () => {
    expect(keyboardLogLine(0, { events: [] })).toBeNull();
    expect(keyboardLogLine(0, {})).toBeNull();
    expect(keyboardLogLine(0, { events: 'not an array' })).toBeNull();
  });

  it('bounds what a page can send', () => {
    // This arrives over a socket from a page, so its length is not muxpad's to
    // assume.
    const many = Array.from({ length: 500 }, (_, i) => ({ what: `e${i}` }));
    const parsed = JSON.parse(keyboardLogLine(0, { events: many }) as string);
    expect(parsed.events.length).toBeLessThanOrEqual(60);
  });
});

describe('writing the log', () => {
  it('appends rather than replacing — a timeline of one tap is not a timeline', () => {
    const d = dir();
    appendKeyboardLog(d, 'default', { events: [{ what: 'one' }] });
    appendKeyboardLog(d, 'default', { events: [{ what: 'two' }] });
    const lines = readFileSync(keyboardLogPath(d, 'default'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
  });

  it('keeps one file per profile', () => {
    const d = dir();
    expect(keyboardLogPath(d, 'default')).not.toBe(keyboardLogPath(d, 's-abc'));
  });

  it('drops the FRONT when it grows too big, keeping the recent tap', () => {
    // A log that stops accepting entries once full would drop precisely the tap
    // somebody just made, which is the only one anybody wants to see.
    const d = dir();
    writeFileSync(keyboardLogPath(d, 'default'), `${'x'.repeat(KEYBOARD_LOG_CAP + 10)}\n`);
    appendKeyboardLog(d, 'default', { events: [{ what: 'the recent one' }] });
    const text = readFileSync(keyboardLogPath(d, 'default'), 'utf8');
    expect(text).toContain('the recent one');
    expect(statSync(keyboardLogPath(d, 'default')).size).toBeLessThan(KEYBOARD_LOG_CAP);
  });

  it('reports failure instead of throwing when it cannot write', () => {
    // It runs on the socket path that carries taps and typing. A note about a
    // keyboard must never be able to break the browser.
    expect(appendKeyboardLog('/proc/nonexistent/nope', 'default', { events: [{ w: 1 }] })).toBe(
      false,
    );
  });

  it('writes nothing for an empty report', () => {
    expect(appendKeyboardLog(dir(), 'default', { events: [] })).toBe(false);
  });
});
