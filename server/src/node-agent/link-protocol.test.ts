import { describe, expect, it } from 'vitest';
import {
  type LinkDown,
  type LinkUp,
  decodeLink,
  encodeLink,
  hostMaySend,
} from './link-protocol.js';

describe('the envelope', () => {
  it('round-trips each channel', () => {
    for (const m of [
      { ch: 'ptyd', payload: '{"t":"req"}' },
      { ch: 'transcript', op: 'subscribe', paneId: 'p1' },
      { ch: 'runner', op: 'frame', paneId: 'p1', frame: { t: 'hello' } },
    ] satisfies LinkDown[]) {
      expect(decodeLink(encodeLink(m))).toEqual(m);
    }
  });

  it('returns null on anything malformed — never throws', () => {
    // This runs on every message from a peer that may be compromised. A parse
    // failure must close a message, not the process.
    for (const raw of ['', 'not json', 'null', '[]', '{}', '{"ch":"nope"}', '"x"', '123']) {
      expect(decodeLink(raw), raw).toBe(null);
    }
  });
});

/**
 * ── AUTHORITY MUST NOT FLOW THE WRONG WAY ────────────────────────────────
 * The socket is bidirectional, which is the whole point — but that does not
 * make every message legal in both directions. A host may not drive pane
 * lifecycle or tell the server what to adopt.
 */
describe('what a host is allowed to send', () => {
  it('allows its own replies, pushes, transcript output and runner frames', () => {
    for (const m of [
      { ch: 'ptyd', payload: '{"t":"evt"}' },
      { ch: 'transcript', op: 'events', paneId: 'p', phase: 'history', events: [] },
      { ch: 'transcript', op: 'title', paneId: 'p', title: 'T' },
      { ch: 'transcript', op: 'unavailable', paneId: 'p', reason: 'not mine' },
      { ch: 'runner', op: 'frame', paneId: 'p', frame: {} },
      { ch: 'runner', op: 'attached', paneId: 'p' },
      { ch: 'runner', op: 'detached', paneId: 'p' },
      // NOT `as const`: it makes the array literals readonly, which the
      // mutable `unknown[]` in the union rejects.
    ] satisfies LinkUp[]) {
      expect(hostMaySend(m), JSON.stringify(m)).toBe(true);
    }
  });

  it('REFUSES server-only directions', () => {
    // A host asking the server to subscribe, or announcing an adopt, is a
    // protocol violation rather than a mistake to tolerate.
    for (const m of [
      { ch: 'transcript', op: 'subscribe', paneId: 'p' },
      { ch: 'transcript', op: 'unsubscribe', paneId: 'p' },
      { ch: 'transcript', op: 'loadOlder', paneId: 'p' },
      { ch: 'runner', op: 'adopt', paneId: 'p' },
    ] satisfies LinkDown[]) {
      expect(hostMaySend(m), JSON.stringify(m)).toBe(false);
    }
  });
});

/**
 * THE CHANNEL LIST IS THE THING THAT BREAKS QUIETLY.
 *
 * `decodeLink` rejects an unknown channel by returning null, which is right —
 * a parse failure must close a message and never the process. The cost is that
 * a channel MISSING from that list is not a type error and not a crash: every
 * message on it is silently malformed, so the feature does nothing at all.
 * That is how `search` shipped answering only "did not answer in time" on a
 * host whose archive was fully indexed.
 */
describe('every channel decodes', () => {
  it('accepts a frame on each one', () => {
    for (const ch of ['ptyd', 'transcript', 'runner', 'api', 'files', 'search'] as const) {
      expect(decodeLink(JSON.stringify({ ch, op: 'x' })), ch).not.toBe(null);
    }
  });

  it('still rejects one that is not a channel', () => {
    expect(decodeLink(JSON.stringify({ ch: 'shell', op: 'exec' }))).toBe(null);
    expect(decodeLink(JSON.stringify({ op: 'x' }))).toBe(null);
    expect(decodeLink('not json')).toBe(null);
  });
});
