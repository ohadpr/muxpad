import type { ChatEvent, InboundSender } from '@muxpad/shared';
import { inboundTextKey } from '@muxpad/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NO_SENDERS,
  loadInboundSenders,
  matchInboundSenders,
  resetInboundSendersCache,
} from './inbound-senders';

const user = (id: string, text: string, ts: number | null = 1): ChatEvent =>
  ({ kind: 'user', id, ts, text }) as ChatEvent;

const row = (text: string, from: string | null, at = 100): InboundSender => ({
  key: inboundTextKey(text),
  at,
  from_tab_id: from,
});

describe('matchInboundSenders', () => {
  it('attributes a bubble to the chat that sent it', () => {
    const got = matchInboundSenders(
      [user('e1', 'go check the PRs')],
      [row('go check the PRs', 't-boss')],
    );
    expect(got.get('e1')).toBe('t-boss');
  });

  it('leaves a HUMAN message unmatched — it renders as today', () => {
    // The constraint that governs the whole feature: nothing invents an
    // attribution. A message nobody recorded is a message the human typed.
    const got = matchInboundSenders([user('e1', 'what is the status?')], []);
    expect(got.has('e1')).toBe(false);
  });

  it('leaves a message recorded with NO sender unmatched', () => {
    // muxpad recorded the send but cannot name a chat behind it. Rendering that
    // as a card with an empty name would be worse than rendering it as today.
    const got = matchInboundSenders([user('e1', 'from nowhere')], [row('from nowhere', null)]);
    expect(got.has('e1')).toBe(false);
  });

  it('matches on the text, not the timestamp — a queued send arrives much later', () => {
    // The reason the join key is the text at all: a send that lands mid-turn
    // waits in the server-side queue and reaches the transcript when that turn
    // ends, which on a long turn is many minutes after `at`.
    const got = matchInboundSenders(
      [user('e1', 'the brief', 9_000_000)],
      [row('the brief', 't-boss', 100)],
    );
    expect(got.get('e1')).toBe('t-boss');
  });

  it('matches a bubble whose transcript copy picked up surrounding whitespace', () => {
    const got = matchInboundSenders([user('e1', '  a brief\n')], [row('a brief', 't-boss')]);
    expect(got.get('e1')).toBe('t-boss');
  });

  it('ignores non-user events, which can never be a delivered message', () => {
    const assistant = { kind: 'assistant', id: 'a1', ts: 1, text: 'the brief' } as ChatEvent;
    const got = matchInboundSenders([assistant], [row('the brief', 't-boss')]);
    expect(got.has('a1')).toBe(false);
  });

  it('gives each repeat of the same text its own row, newest bubble first', () => {
    // A coordinator that sends "status?" twice gets two cards, and the second
    // must not steal the first's row. Rows arrive newest-first; bubbles are
    // oldest-first, so the LAST bubble takes the newest row.
    const got = matchInboundSenders(
      [user('e1', 'status?', 100), user('e2', 'status?', 200)],
      [row('status?', 't-late', 200), row('status?', 't-early', 100)],
    );
    expect(got.get('e1')).toBe('t-early');
    expect(got.get('e2')).toBe('t-late');
  });

  it('still attributes the newest bubble when there are fewer rows than repeats', () => {
    // The cap dropped the older row, or it predates the feature. The message
    // that still has a record keeps its card; the other renders as today.
    const got = matchInboundSenders(
      [user('e1', 'status?', 100), user('e2', 'status?', 200)],
      [row('status?', 't-boss', 200)],
    );
    expect(got.has('e1')).toBe(false);
    expect(got.get('e2')).toBe('t-boss');
  });

  it('is empty for a conversation with no recorded sends at all', () => {
    expect(matchInboundSenders([user('e1', 'hi')], NO_SENDERS).size).toBe(0);
  });

  it('costs nothing when there is nothing to match', () => {
    // The common case by far — a chat nobody has ever sent into. The map is the
    // shared empty one, so every memo downstream holds.
    expect(matchInboundSenders([], NO_SENDERS).size).toBe(0);
  });
});

/**
 * The fetch is keyed on "a new user message arrived" — so that arrival is
 * evidence the cached list is stale, whatever the TTL says. Without that, a
 * brief landing within four seconds of the last fetch got the old list back and
 * stayed unattributed until some unrelated user message re-ran the effect.
 */
describe('loadInboundSenders', () => {
  const ok = (senders: InboundSender[]) =>
    ({ ok: true, status: 200, json: async () => ({ senders }) }) as Response;

  beforeEach(() => {
    resetInboundSendersCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reuses a fresh answer when nothing has arrived', async () => {
    const f = vi.fn(async () => ok([]));
    vi.stubGlobal('fetch', f);
    await loadInboundSenders('t');
    await loadInboundSenders('t');
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('re-asks inside the freshness window when a new message arrived', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(ok([]))
      .mockResolvedValueOnce(ok([row('the brief', 't-boss')]));
    vi.stubGlobal('fetch', f);
    expect(await loadInboundSenders('t')).toEqual([]);
    const got = await loadInboundSenders('t', true);
    expect(got.map((s) => s.from_tab_id)).toEqual(['t-boss']);
  });

  it('re-asks after a read that was already in flight when the message arrived', async () => {
    let finish!: (response: Response) => void;
    const f = vi
      .fn()
      .mockImplementationOnce(() => new Promise<Response>((r) => { finish = r; }))
      .mockResolvedValueOnce(ok([row('the brief', 't-boss')]));
    vi.stubGlobal('fetch', f);
    const first = loadInboundSenders('t');
    const changed = loadInboundSenders('t', true);
    finish(ok([]));
    await first;
    expect((await changed).map((s) => s.from_tab_id)).toEqual(['t-boss']);
    expect(f).toHaveBeenCalledTimes(2);
  });
});
