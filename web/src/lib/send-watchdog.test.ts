import { describe, expect, it } from 'vitest';
import { MAX_PROBES, composerAfterLateAck, watchdogVerdict } from './send-watchdog';

const state = (over: Partial<Parameters<typeof watchdogVerdict>[0]> = {}) => ({
  acked: false,
  socketOpen: true,
  pongSinceProbe: true,
  probes: 0,
  ...over,
});

describe('what the send watchdog concludes', () => {
  it('keeps waiting on a live socket that has not answered yet', () => {
    // THE BUG. Six seconds of silence from a busy server used to mean "dead
    // socket, put the text back", and the message was already delivered — the
    // user saw it in the transcript AND in the composer.
    expect(watchdogVerdict(state())).toBe('probe');
  });

  it('restores when the link does not answer a probe', () => {
    // The case it exists for: a socket reading OPEN over a link that is gone.
    expect(watchdogVerdict(state({ pongSinceProbe: false }))).toBe('restore');
  });

  it('restores without probing a socket the browser already closed', () => {
    expect(watchdogVerdict(state({ socketOpen: false, pongSinceProbe: false }))).toBe('restore');
  });

  it('never restores once delivery is evidenced, even on a dead socket', () => {
    // A restore here would offer the user a second copy of a message the
    // server already has. Losing the socket after delivery is not losing the
    // message.
    expect(watchdogVerdict(state({ acked: true, socketOpen: false }))).toBe('wait');
    expect(watchdogVerdict(state({ acked: true, pongSinceProbe: false }))).toBe('wait');
  });

  it('gives up after a bounded number of answered probes', () => {
    // A server answering pings while failing to process sends must not hold
    // the text hostage forever.
    for (let p = 0; p < MAX_PROBES - 1; p++) {
      expect(watchdogVerdict(state({ probes: p }))).toBe('probe');
    }
    expect(watchdogVerdict(state({ probes: MAX_PROBES - 1 }))).toBe('restore');
    expect(watchdogVerdict(state({ probes: MAX_PROBES + 3 }))).toBe('restore');
  });
});

describe('undoing a restore that turned out to be wrong', () => {
  it('clears exactly what the watchdog put back', () => {
    expect(composerAfterLateAck('hello', 'hello')).toBe('');
  });

  it('leaves anything the user has typed since', () => {
    // A composer that empties under someone's hands is worse than the bug.
    expect(composerAfterLateAck('hello and more', 'hello')).toBe('hello and more');
    expect(composerAfterLateAck('something else', 'hello')).toBe('something else');
  });

  it('does nothing when the watchdog never restored', () => {
    expect(composerAfterLateAck('a draft', null)).toBe('a draft');
    expect(composerAfterLateAck('', null)).toBe('');
  });
});
