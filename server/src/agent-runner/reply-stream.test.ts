// The decoder that turns a `reply`'s tool-argument stream into speakable text.
//
// Every chunking in here is the SHAPE the live SDK produced (probed at 0.3.220
// — see sdkScript.replyStream), not a tidy invention. The two that bite are the
// space in `{"text": "` and escapes landing on a chunk boundary; both have a
// test of their own because both are silent corruption rather than a crash.

import { describe, expect, it } from 'vitest';
import {
  ReplyArgStreamer,
  ReplyBlockTracker,
  isReplyBlock,
  replyToolUseId,
} from './reply-stream.js';

/** Feed chunks, collect what each push newly yielded. */
function drain(chunks: string[]): { pieces: string[]; text: string; complete: boolean } {
  const s = new ReplyArgStreamer();
  const pieces = chunks.map((c) => s.push(c));
  return { pieces, text: s.text, complete: s.complete };
}

describe('ReplyArgStreamer — text out of a half-written tool argument', () => {
  it('decodes the exact chunking a live reply produced', () => {
    // Verbatim from the probe, including the empty first chunk.
    const { text, complete } = drain([
      '',
      '{"text": "Landed in',
      ' ~/Documents/',
      'Invoices/2',
      '026-09.',
      'pdf — \\"quoted',
      '\\" and a new',
      'line',
      '\\nhere."}',
    ]);
    expect(text).toBe('Landed in ~/Documents/Invoices/2026-09.pdf — "quoted" and a newline\nhere.');
    expect(complete).toBe(true);
  });

  it('survives the SPACE after the key — the reason this is not a regex', () => {
    // A decoder looking for a literal `"text":"` finds nothing here and speaks
    // silence for the whole turn. The live SDK emits the spaced form.
    expect(drain(['{"text": "hi"}']).text).toBe('hi');
    // …and the unspaced form, which is equally legal JSON.
    expect(drain(['{"text":"hi"}']).text).toBe('hi');
  });

  it('holds back an escape split across the chunk boundary', () => {
    // The backslash arrives with nothing after it. Emitting it immediately
    // would speak a literal backslash and then swallow the quote.
    const s = new ReplyArgStreamer();
    expect(s.push('{"text": "she said \\')).toBe('she said ');
    expect(s.push('"hi\\" back"}')).toBe('"hi" back');
    expect(s.text).toBe('she said "hi" back');
  });

  it('holds back a \\u escape split anywhere inside it', () => {
    for (const cut of [1, 2, 3, 4, 5]) {
      const esc = '\\u00e9';
      const { text } = drain(['{"text": "caf', esc.slice(0, cut), `${esc.slice(cut)}"}`]);
      expect(text).toBe('café');
    }
  });

  it('reassembles a surrogate pair that arrives as two separate escapes', () => {
    expect(drain(['{"text": "\\ud83d', '\\ude00"}']).text).toBe('😀');
  });

  it('never re-emits text it has already handed out', () => {
    // A consumer appends every push blindly; a decoder that re-sent its buffer
    // would make the voice stutter the whole reply back.
    const { pieces, text } = drain(['{"text": "one ', 'two ', 'three"}']);
    expect(pieces).toEqual(['one ', 'two ', 'three']);
    expect(pieces.join('')).toBe(text);
  });

  it('stops at the closing quote and ignores the rest of the object', () => {
    const { text, complete } = drain(['{"text": "done"', ', "other": "ignored"}']);
    expect(text).toBe('done');
    expect(complete).toBe(true);
  });

  it('finds `text` even when it is not the first key', () => {
    expect(drain(['{"other": 1, "text": "found"}']).text).toBe('found');
  });

  it('passes an unknown escape through rather than eating the character', () => {
    expect(drain(['{"text": "a\\qb"}']).text).toBe('aqb');
  });

  it('emits nothing at all while only the prelude has arrived', () => {
    const s = new ReplyArgStreamer();
    expect(s.push('{')).toBe('');
    expect(s.push('"te')).toBe('');
    expect(s.push('xt": "')).toBe('');
    expect(s.push('now')).toBe('now');
  });
});

describe('ReplyBlockTracker — which streamed block is a reply', () => {
  const replyBlock = (id: string) => ({
    type: 'tool_use',
    id,
    name: 'mcp__muxpad__reply',
    input: {},
    caller: { type: 'direct' },
  });

  it('tracks a reply block and attributes its deltas to the right id', () => {
    const t = new ReplyBlockTracker();
    expect(t.start(1, replyBlock('toolu_a'))).toBe('toolu_a');
    expect(t.delta(1, '{"text": "hello')).toEqual({ id: 'toolu_a', delta: 'hello' });
    expect(t.delta(1, ' there"}')).toEqual({ id: 'toolu_a', delta: ' there' });
  });

  it('ignores blocks that are not replies — Bash arguments are not speech', () => {
    const t = new ReplyBlockTracker();
    expect(t.start(1, { type: 'tool_use', id: 'toolu_b', name: 'Bash', input: {} })).toBeNull();
    expect(t.delta(1, '{"command": "rm -rf /"}')).toBeNull();
    expect(t.start(0, { type: 'text', text: '' })).toBeNull();
  });

  it('keeps TWO replies in one message apart — the contract asks for 2–4', () => {
    const t = new ReplyBlockTracker();
    t.start(1, replyBlock('toolu_first'));
    t.start(2, replyBlock('toolu_second'));
    expect(t.delta(2, '{"text": "second"}')).toEqual({ id: 'toolu_second', delta: 'second' });
    expect(t.delta(1, '{"text": "first"}')).toEqual({ id: 'toolu_first', delta: 'first' });
  });

  it('a non-reply block RECLAIMS a reused index', () => {
    // Indices restart per assistant message. A stale reply left open at index 1
    // would misattribute the next message's Bash arguments as spoken text —
    // which is how a voice layer ends up reading a shell command aloud.
    const t = new ReplyBlockTracker();
    t.start(1, replyBlock('toolu_a'));
    t.start(1, { type: 'tool_use', id: 'toolu_bash', name: 'Bash', input: {} });
    expect(t.delta(1, '{"command": "ls"}')).toBeNull();
  });

  it('stop() and clear() end attribution', () => {
    const t = new ReplyBlockTracker();
    t.start(1, replyBlock('toolu_a'));
    t.stop(1);
    expect(t.delta(1, '{"text": "x"}')).toBeNull();
    t.start(2, replyBlock('toolu_b'));
    t.clear();
    expect(t.delta(2, '{"text": "x"}')).toBeNull();
  });

  it('a reply block with no id is not tracked', () => {
    const t = new ReplyBlockTracker();
    expect(t.start(1, { type: 'tool_use', name: 'mcp__muxpad__reply', input: {} })).toBeNull();
  });
});

describe('replyToolUseId — the transcript identity, from MCP _meta', () => {
  it('reads the live shape', () => {
    expect(
      replyToolUseId({
        signal: {},
        _meta: { 'claudecode/toolUseId': 'toolu_01FF', progressToken: 2 },
      }),
    ).toBe('toolu_01FF');
  });

  it('returns null rather than throwing on any shape it does not know', () => {
    // An SDK that renames the meta key must cost us CORRELATION, never a reply.
    for (const bad of [
      undefined,
      null,
      {},
      { _meta: {} },
      { _meta: { 'claudecode/toolUseId': 7 } },
    ])
      expect(replyToolUseId(bad)).toBeNull();
  });
});

describe('isReplyBlock', () => {
  it('is the muxpad MCP name, not any tool called reply', () => {
    expect(isReplyBlock({ type: 'tool_use', name: 'mcp__muxpad__reply' })).toBe(true);
    expect(isReplyBlock({ type: 'tool_use', name: 'reply' })).toBe(false);
    expect(isReplyBlock({ type: 'text', text: 'mcp__muxpad__reply' })).toBe(false);
  });
});
