import { describe, expect, it } from 'vitest';
import { expandChatEvent, normalizeTranscriptLine } from './chat-events.js';
import { messageIsFromCron, parseCronMarker, renderCronMarker } from './cron.js';

const MARKER = { id: '01ABC', name: 'pr-sweep', at: 1_756_540_800_000, missed: 0 };

describe('the cron fire marker', () => {
  it('round-trips through render → parse', () => {
    const text = renderCronMarker(MARKER, 'check my open PRs');
    const parsed = parseCronMarker(text);
    expect(parsed?.marker).toEqual(MARKER);
    expect(parsed?.body.trim()).toBe('check my open PRs');
  });

  it('tells the agent, in words, that a schedule sent this', () => {
    // The marker is not only a render hook — the model reads it, and "a human
    // just asked me this" vs "my 9am job fired" are different situations.
    const text = renderCronMarker(MARKER, 'go');
    expect(text).toContain('a scheduled job, not a human');
    expect(text).toContain('pr-sweep');
  });

  it('carries the collapsed-fire count when catch-up merged several', () => {
    const text = renderCronMarker({ ...MARKER, missed: 3 }, 'go');
    expect(parseCronMarker(text)?.marker.missed).toBe(3);
    expect(text).toContain('3 earlier fire(s) were missed');
  });

  it('is null for ordinary text — including text that merely mentions the tag', () => {
    expect(parseCronMarker('just a message')).toBeNull();
    // Only a LEADING block is one of ours; otherwise a user pasting the tag
    // mid-message could forge a fire chip.
    expect(parseCronMarker('look at this: <muxpad-cron id="x" name="y"></muxpad-cron>')).toBeNull();
    // Missing the durable id → not a marker we wrote.
    expect(parseCronMarker('<muxpad-cron name="y">hi</muxpad-cron>\n\ngo')).toBeNull();
  });

  it('matches ownership on the DURABLE id, never the renameable name', () => {
    const text = renderCronMarker(MARKER, 'go');
    expect(messageIsFromCron(text, '01ABC')).toBe(true);
    expect(messageIsFromCron(text, 'pr-sweep')).toBe(false);
    expect(messageIsFromCron('a plain message', '01ABC')).toBe(false);
  });
});

describe('rendering a fire in the transcript', () => {
  const claudeLine = (text: string) => ({
    type: 'user',
    uuid: 'u1',
    timestamp: '2026-08-30T09:00:00.000Z',
    message: { role: 'user', content: text },
  });

  it('splits a Claude transcript fire into a chip AND the prompt (not raw XML)', () => {
    const events = normalizeTranscriptLine(claudeLine(renderCronMarker(MARKER, 'check my PRs')));
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ kind: 'notice', variant: 'cron', text: 'pr-sweep' });
    expect(events[1]).toMatchObject({ kind: 'user', text: 'check my PRs' });
    // Two distinct React keys.
    expect(events[0]?.id).not.toBe(events[1]?.id);
  });

  it('leaves an ordinary user message completely alone', () => {
    const events = normalizeTranscriptLine(claudeLine('hello there'));
    expect(events).toEqual([
      { kind: 'user', id: 'u1', ts: Date.parse('2026-08-30T09:00:00.000Z'), text: 'hello there' },
    ]);
  });

  it('splits the codex/cursor muxpad-log shape identically', () => {
    // Those backends write ready-made ChatEvents, so the split has to happen on
    // that road too — otherwise a fire renders as a wall of XML on two of the
    // three backends.
    const out = expandChatEvent({
      kind: 'user',
      id: 'm1',
      ts: 1,
      text: renderCronMarker(MARKER, 'check my PRs'),
    });
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ kind: 'notice', variant: 'cron', text: 'pr-sweep' });
    expect(out[1]).toMatchObject({ kind: 'user', text: 'check my PRs' });
  });

  it('passes non-user events through untouched', () => {
    const ev = { kind: 'assistant', id: 'a1', ts: 1, text: 'done' } as const;
    expect(expandChatEvent(ev)).toEqual([ev]);
  });

  it('notes a catch-up collapse on the chip', () => {
    const out = expandChatEvent({
      kind: 'user',
      id: 'm1',
      ts: 1,
      text: renderCronMarker({ ...MARKER, missed: 4 }, 'go'),
    });
    expect(out[0]).toMatchObject({ detail: '4 missed fires collapsed' });
  });
});
