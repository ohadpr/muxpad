import { describe, expect, it } from 'vitest';
import { wellFormed } from './HostLink.js';

/**
 * THE ENVELOPE WAS CHECKED; THE PAYLOAD WAS NOT.
 *
 * `decodeLink` validates the CHANNEL and then casts — honest about what it
 * does, and not enough on the server's side of a link, where every branch
 * reads fields off a message from a machine that may be compromised.
 *
 * Found in review, with a working trigger: a host that answers a file fetch
 * with `{ch:'files',op:'chunk',id:'<the id we sent>',rel:null}` reached
 * `rel.includes('\0')` inside a WebSocket message handler. That is an uncaught
 * TypeError, which takes the whole server down — one malformed frame, an
 * install-wide outage, in direct contradiction of the protocol's own promise
 * that a parse failure "closes a message, never the process".
 */

describe('what the server accepts off a link', () => {
  it('accepts the frames a host legitimately sends', () => {
    expect(wellFormed({ ch: 'ptyd', payload: '{}' } as never)).toBe(true);
    expect(
      wellFormed({
        ch: 'transcript',
        op: 'events',
        paneId: 'p',
        phase: 'live',
        events: [],
      } as never),
    ).toBe(true);
    expect(wellFormed({ ch: 'transcript', op: 'title', paneId: 'p', title: 'x' } as never)).toBe(
      true,
    );
    expect(
      wellFormed({ ch: 'runner', op: 'frame', paneId: 'p', frame: { t: 'hello' } } as never),
    ).toBe(true);
    expect(wellFormed({ ch: 'runner', op: 'attached', paneId: 'p' } as never)).toBe(true);
    expect(
      wellFormed({
        ch: 'api',
        op: 'request',
        id: 'i',
        method: 'GET',
        path: '/api/say/key',
      } as never),
    ).toBe(true);
    expect(
      wellFormed({ ch: 'files', op: 'chunk', id: 'i', rel: '', b64: '', last: true } as never),
    ).toBe(true);
    expect(wellFormed({ ch: 'files', op: 'done', id: 'i', kind: 'dir', name: 'x' } as never)).toBe(
      true,
    );
    expect(
      wellFormed({ ch: 'search', op: 'hits', id: 'i', hits: [], fallback: false } as never),
    ).toBe(true);
  });

  it('REJECTS the one that crashed the server', () => {
    expect(wellFormed({ ch: 'files', op: 'chunk', id: 'i', rel: null } as never)).toBe(false);
  });

  it('rejects a missing or wrongly-typed field on every channel', () => {
    const bad = [
      { ch: 'ptyd' },
      { ch: 'ptyd', payload: 7 },
      { ch: 'transcript', op: 'events', paneId: 'p' }, // no events array
      { ch: 'transcript', op: 'events', paneId: 'p', events: 'nope' },
      { ch: 'transcript', op: 'title', paneId: 'p' },
      { ch: 'transcript', op: 'events', events: [] }, // no paneId
      { ch: 'runner', op: 'frame', paneId: 'p', frame: 'not an object' },
      { ch: 'runner', op: 'frame', paneId: 'p' },
      { ch: 'api', op: 'request', id: 'i', method: 'GET' }, // no path
      { ch: 'api', op: 'request', id: 'i', method: 'GET', path: '/x', body: 9 },
      { ch: 'files', op: 'chunk', id: 'i', rel: '', b64: '' }, // no last
      { ch: 'files', op: 'chunk', id: 'i', rel: '', b64: 7, last: true },
      { ch: 'files', op: 'done', id: 'i', kind: 'device', name: 'x' },
      { ch: 'files', op: 'done', id: 'i', kind: 'file' }, // no name
      { ch: 'search', op: 'hits', id: 'i', hits: [] }, // no fallback
      { ch: 'search', op: 'hits', id: 'i', fallback: false },
    ];
    for (const m of bad) expect(wellFormed(m as never), JSON.stringify(m)).toBe(false);
  });

  /**
   * ── THE ONE THAT ESCAPED ────────────────────────────────────────────────
   *
   * `paneId` is interpolated into a loopback WebSocket URL. A review found
   * that `../chat/<a local pane>` makes `new URL()` normalise
   * `/ws/agent-runner/../chat/<id>` to `/ws/chat/<id>` — a DIFFERENT
   * authenticated endpoint, dialled with this server's own install credential
   * and a same-origin header. The host then receives that local chat's
   * transcript and can send it `{t:'send'}` frames, which drives somebody
   * else's agent. `../events` reaches the install-wide event stream.
   *
   * Verified before fixing: `new URL('ws://h/ws/agent-runner/' + '../events')`
   * really does resolve to `/ws/events`.
   */
  it('REJECTS a paneId that can be read as a path', () => {
    for (const paneId of [
      '../chat/01KX6GKFGSCNWB9S1R87N74WKG',
      '../events',
      '..',
      'a/b',
      'a\\b',
      './x',
      '%2e%2e%2fevents',
      'x'.repeat(65),
      '',
      'has space',
    ]) {
      expect(
        wellFormed({ ch: 'runner', op: 'attached', paneId } as never),
        JSON.stringify(paneId),
      ).toBe(false);
      expect(
        wellFormed({ ch: 'transcript', op: 'title', paneId, title: 'x' } as never),
        JSON.stringify(paneId),
      ).toBe(false);
    }
  });

  it('still accepts the ids muxpad actually mints', () => {
    // ULIDs, and the `-`/`_` that other id shapes in this tree allow.
    for (const paneId of ['01KX6GKFGSCNWB9S1R87N74WKG', 'test-pane-1', 'a_b-C9']) {
      expect(wellFormed({ ch: 'runner', op: 'attached', paneId } as never), paneId).toBe(true);
    }
  });

  it('rejects an op a HOST may not send, even though it is well shaped', () => {
    // `fetch` and `query` are the SERVER naming a path and asking a question.
    // `hostMaySend` refuses them on the host's own side; this refuses them
    // coming back, which is the side that cannot be patched by a host.
    expect(wellFormed({ ch: 'files', op: 'fetch', id: 'i', path: '/x' } as never)).toBe(false);
    expect(wellFormed({ ch: 'search', op: 'query', id: 'i', q: 'x', limit: 5 } as never)).toBe(
      false,
    );
    expect(wellFormed({ ch: 'transcript', op: 'subscribe', paneId: 'p' } as never)).toBe(false);
    expect(wellFormed({ ch: 'api', op: 'response', id: 'i', status: 200, body: '' } as never)).toBe(
      false,
    );
  });
});
