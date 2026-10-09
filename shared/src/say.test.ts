import { describe, expect, it } from 'vitest';
import {
  type ChatEvent,
  expandChatEvent,
  normalizeTranscriptLine,
  renderSaid,
  splitSaid,
} from './chat-events.js';

/**
 * `muxpad say` — THE ONE THING A SCHEDULED FIRE RENDERS.
 *
 * Everything else a fire does folds into its collapsed run: the injected
 * prompt, the tool calls, and whatever prose the model produced on the way to
 * being finished. Two flags on the SCHEDULE tried to govern that and both
 * asked a question only the FIRE can answer — `net-watch` is "silent unless a
 * trigger fires", which neither `--silent` nor `--speak` can express.
 *
 * The marker rides the transcript rather than a table of its own, so it is at
 * the right position with the right timestamp by construction, and it works on
 * every backend because every backend's transcript comes through this file.
 * THE TWO ROADS ARE TESTED SEPARATELY for that reason: Claude's raw JSONL and
 * codex/cursor's already-normalized log reach the lift by different functions,
 * and a fix to one of them is exactly the kind of thing that silently misses
 * the other.
 */
const claudeToolResult = (text: string) =>
  normalizeTranscriptLine({
    type: 'user',
    uuid: 'u1',
    timestamp: '2026-10-09T12:00:00.000Z',
    message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: text }] },
  });

const normalized = (text: string): ChatEvent[] =>
  expandChatEvent({ kind: 'tool_result', id: 'r1', ts: 1, toolUseId: 'tu1', ok: true, text });

describe('splitSaid', () => {
  it('leaves ordinary output alone, allocating nothing', () => {
    const plain = 'total 4\ndrwxr-xr-x';
    expect(splitSaid(plain)).toEqual({ said: [], rest: plain });
  });

  it('lifts the spoken text out and keeps the rest on the tool row', () => {
    // A command that says something AND prints its own output keeps both, in
    // the right places — the output is work, the said text is a message.
    const out = splitSaid(`building…\n${renderSaid('shipped v2')}\ndone`);
    expect(out.said).toEqual(['shipped v2']);
    expect(out.rest).toBe('building…\n\ndone');
  });

  it('handles several in one command, and ignores an empty one', () => {
    const out = splitSaid(`${renderSaid('one')}${renderSaid('  ')}${renderSaid('two')}`);
    expect(out.said).toEqual(['one', 'two']);
    expect(out.rest).toBe('');
  });

  it('survives a multi-line message', () => {
    const body = 'NET $318\n\n- down 10% from here\n- the ticket is 60 shares';
    expect(splitSaid(renderSaid(body)).said).toEqual([body]);
  });
});

describe('the Claude road', () => {
  it('turns a said marker into a reply-voiced message', () => {
    const out = claudeToolResult(renderSaid('the trigger fired'));
    const spoken = out.find((e) => e.kind === 'assistant');
    expect(spoken).toMatchObject({ text: 'the trigger fired', voice: 'reply' });
  });

  it('does not leave an empty tool row behind it', () => {
    // `muxpad say` on its own prints nothing but the marker, so the result row
    // would be a blank "output" under every message.
    const out = claudeToolResult(renderSaid('hi'));
    const row = out.find((e) => e.kind === 'tool_result');
    expect(row).toBeDefined();
    expect(row).not.toHaveProperty('text');
  });

  it('keeps real output on the tool row', () => {
    const out = claudeToolResult(`3 files changed\n${renderSaid('done')}`);
    expect(out.find((e) => e.kind === 'tool_result')).toMatchObject({ text: '3 files changed' });
  });
});

describe('the codex / cursor road', () => {
  it('lifts it from an already-normalized result too', () => {
    const out = normalized(renderSaid('the trigger fired'));
    expect(out.find((e) => e.kind === 'assistant')).toMatchObject({
      text: 'the trigger fired',
      voice: 'reply',
    });
  });

  it('passes an ordinary result through untouched, same object', () => {
    const e: ChatEvent = {
      kind: 'tool_result',
      id: 'r1',
      ts: 1,
      toolUseId: 't',
      ok: true,
      text: 'ls',
    };
    expect(expandChatEvent(e)).toEqual([e]);
  });

  it('gives each spoken block its own id', () => {
    // Two messages from one command are two React rows; a shared key is a
    // dropped render.
    const out = normalized(`${renderSaid('a')}${renderSaid('b')}`);
    const ids = out.filter((e) => e.kind === 'assistant').map((e) => e.id);
    expect(new Set(ids).size).toBe(2);
  });
});
