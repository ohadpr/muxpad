import type { ChatEvent } from '@muxpad/shared';
import { describe, expect, it } from 'vitest';
import {
  consumeStreamedText,
  landedThisTurn,
  mergeHistorySnapshot,
  optimisticEchoLanded,
} from './ChatPane';

/**
 * The chat log as a VIEW OF THE TRANSCRIPT, rather than an append-only id set.
 *
 * Every case here is a way the rendered list used to disagree with the file on
 * disk: a hole a backgrounded phone came back to, the pre-compact conversation
 * sitting above its own summary, a streaming preview that ate the head of the
 * block it was previewing, and the in-flight message that was on screen nowhere
 * at all between the queue drain and the transcript line.
 */

const ev = (id: string, kind: ChatEvent['kind'], text = id): ChatEvent =>
  ({ kind, id, ts: 0, text }) as ChatEvent;

const ids = (list: readonly ChatEvent[]) => list.map((e) => e.id);

describe('a history frame is a snapshot, not a patch', () => {
  it('opens a fresh pane with the batch, and does not call that a reset', () => {
    const m = mergeHistorySnapshot([], [ev('e1', 'user'), ev('e2', 'assistant')]);
    expect(m).not.toBeNull();
    expect(ids((m as { events: ChatEvent[] }).events)).toEqual(['e1', 'e2']);
    expect(m?.reset).toBe(false);
  });

  it('OVERLAPPING reconnect keeps the older pages the reader scrolled back through', () => {
    // The commonest case by far: every mobile backgrounding. The reader has
    // paged two batches of history in; the new tail starts inside what they
    // already hold. Nothing may move under them.
    const paged = [ev('o1', 'user'), ev('o2', 'assistant')];
    const tail = [ev('e1', 'user'), ev('e2', 'assistant')];
    const replay = [ev('e1', 'user'), ev('e2', 'assistant'), ev('e3', 'assistant')];
    const m = mergeHistorySnapshot([...paged, ...tail], replay);
    expect(ids(m?.events ?? [])).toEqual(['o1', 'o2', 'e1', 'e2', 'e3']);
    expect(m?.reset).toBe(false);
  });

  it('a GAP replaces the list instead of leaving a permanent hole', () => {
    // Phone backgrounded for minutes; the runner kept writing; the 128KB tail
    // now starts after everything the client holds. Appending gives
    // [e1..e10, e21..e30] with e11..e20 missing forever — and paging the gap
    // back in PREPENDS it, so the log becomes [gap, old-tail, new-tail].
    const held = [ev('e1', 'user'), ev('e2', 'assistant')];
    const afterGap = [ev('e21', 'user'), ev('e22', 'assistant')];
    const m = mergeHistorySnapshot(held, afterGap);
    expect(ids(m?.events ?? [])).toEqual(['e21', 'e22']);
    expect(m?.reset).toBe(true);
  });

  it('/compact drops the pre-compact conversation instead of stacking it above the summary', () => {
    // A compact rewrites the file smaller with NEW uuids, so nothing dedupes.
    const before = [ev('u1', 'user'), ev('a1', 'assistant')];
    const m = mergeHistorySnapshot(before, [ev('z1', 'assistant', 'post-compact summary')]);
    expect(ids(m?.events ?? [])).toEqual(['z1']);
    expect(m?.reset).toBe(true);
  });

  it('a compact that KEEPS a surviving id still ends up in transcript order', () => {
    // Rendered [u1, a1, u2]; the file is now [a1, z1]. The batch replaces from
    // its own first event, so u2 — which the batch does not claim — cannot end
    // up BELOW the summary that replaced it.
    const m = mergeHistorySnapshot(
      [ev('u1', 'user'), ev('a1', 'assistant'), ev('u2', 'user')],
      [ev('a1', 'assistant'), ev('z1', 'assistant')],
    );
    expect(ids(m?.events ?? [])).toEqual(['u1', 'a1', 'z1']);
  });

  it('an empty batch is a no-op — the server never emits one', () => {
    expect(mergeHistorySnapshot([ev('e1', 'user')], [])).toBeNull();
  });
});

describe('the streaming preview', () => {
  it('does not eat the head of the block it is previewing', () => {
    // lastIndexOf anchored on the SECOND "OK" and returned " I will continue".
    expect(consumeStreamedText('OKOK I will continue', ['OK'])).toBe('OK I will continue');
  });

  it('still strips a multi-block prefix exactly', () => {
    expect(consumeStreamedText('oneTwothree', ['one', 'Two'])).toBe('three');
  });

  it('keeps the tail-anchor fallback for normalization drift', () => {
    // The first block drifted (trailing space); only the last block matches.
    expect(consumeStreamedText('one Twothree', ['one', 'Two'])).toBe('three');
  });

  it('counts NOTHING as landed while the turn has no transcript user line', () => {
    // The last user event is the PREVIOUS turn's, so its assistant text used to
    // become the tail anchor for the new turn's preview.
    const prevTurn = [ev('u1', 'user'), ev('a1', 'assistant', 'a')];
    expect(landedThisTurn(prevTurn)).toEqual(['a']);
    expect(landedThisTurn(prevTurn, true)).toEqual([]);
    // …and counting it still mangles the new turn's first block (the preview
    // loses its own leading "a"; before the prefix fix it lost far more, and
    // read "n for the next step").
    expect(consumeStreamedText('a plan for the next step', landedThisTurn(prevTurn))).toBe(
      ' plan for the next step',
    );
    expect(consumeStreamedText('a plan for the next step', landedThisTurn(prevTurn, true))).toBe(
      'a plan for the next step',
    );
  });

  it('does not wipe the preview when the previous turn is not in it at all', () => {
    const prevTurn = [ev('u1', 'user'), ev('a1', 'assistant', 'Done.')];
    expect(consumeStreamedText('Right, starting now', landedThisTurn(prevTurn))).toBe('');
    expect(consumeStreamedText('Right, starting now', landedThisTurn(prevTurn, true))).toBe(
      'Right, starting now',
    );
  });
});

describe('the optimistic user echo', () => {
  it('is not retired by an OLDER identical message', () => {
    const events = [
      ev('u1', 'user', 'yes'),
      ev('a1', 'assistant', 'ok'),
      ev('u2', 'user', 'and now this'),
      ev('a2', 'assistant', 'done'),
    ];
    expect(optimisticEchoLanded(events, 'yes')).toBe(false);
  });

  it('IS retired by the newest line', () => {
    expect(optimisticEchoLanded([ev('u1', 'user', 'yes')], 'yes')).toBe(true);
  });

  it('is retired by a transcript line wearing the mode note', () => {
    // The first send after a Chat/Agent switch is written as
    // `<muxpad-mode>…</muxpad-mode>\n\n` + what was typed.
    const line = '<muxpad-mode>chat</muxpad-mode>\n\nhello there';
    expect(optimisticEchoLanded([ev('u1', 'user', line)], 'hello there')).toBe(true);
  });

  it('is not retired by an unrelated newest line', () => {
    expect(optimisticEchoLanded([ev('u1', 'user', 'something else')], 'hello')).toBe(false);
  });
});
