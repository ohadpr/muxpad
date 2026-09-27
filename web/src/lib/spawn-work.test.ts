import type { ChatEvent } from '@muxpad/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SPAWN_WORK_MAX_CHARS,
  fetchSpawnWork,
  finalTurnText,
  parseTranscriptJsonl,
} from './spawn-work';

/**
 * THE EXPANSION. "if I just got a summary of it I'd be bummed that I lost
 * everything."
 *
 * The summary on the card is an INDEX; this is what it indexes. The half worth
 * testing is "what counts as the work", because every way of getting it wrong
 * looks the same on screen: a card that opens onto the wrong turn, onto half a
 * turn, or onto nothing at all.
 */
const ev = (over: Partial<ChatEvent> & { kind: string }): ChatEvent =>
  ({ id: Math.random().toString(36), ts: 1, ...over }) as ChatEvent;

describe('finalTurnText — the last thing the worker said', () => {
  it('stops at the previous user message', () => {
    // Everything before the task is a different turn, and pulling it in would
    // make the expansion longer AND wrong.
    const events = [
      ev({ kind: 'assistant', text: 'an answer from an earlier turn' }),
      ev({ kind: 'user', text: 'now write the report' }),
      ev({ kind: 'assistant', text: '# Findings\n\nFourteen pages read.' }),
    ];
    expect(finalTurnText(events).text).toBe('# Findings\n\nFourteen pages read.');
  });

  it('keeps several assistant messages IN ORDER, as paragraphs', () => {
    // A streamed turn arrives as several messages. Joined with a single newline,
    // a heading in the second one would render glued to the paragraph above it.
    const events = [
      ev({ kind: 'user', text: 'go' }),
      ev({ kind: 'assistant', text: 'first' }),
      ev({ kind: 'assistant', text: '## second' }),
    ];
    expect(finalTurnText(events).text).toBe('first\n\n## second');
  });

  it('skips the actions — the expansion is what it SAID', () => {
    const events = [
      ev({ kind: 'user', text: 'go' }),
      ev({ kind: 'tool_use', name: 'Bash', toolUseId: 't1' }),
      ev({ kind: 'thinking', text: 'hmm' }),
      ev({ kind: 'assistant', text: 'the report' }),
    ];
    expect(finalTurnText(events).text).toBe('the report');
  });

  it('is empty for a worker that never answered', () => {
    expect(finalTurnText([ev({ kind: 'user', text: 'go' })]).text).toBe('');
    expect(finalTurnText([]).text).toBe('');
  });

  it('SAYS SO when it hits the backstop, rather than ending mid-sentence', () => {
    // The bound that matters is the turn boundary. This one exists for the worker
    // that printed a megabyte of log into its last message, and a silent cut
    // there is the HEADLINE_MAX_CHARS mistake: you cannot tell whether the part
    // that was removed was the part you wanted.
    const huge = 'x'.repeat(SPAWN_WORK_MAX_CHARS + 500);
    const out = finalTurnText([
      ev({ kind: 'user', text: 'go' }),
      ev({ kind: 'assistant', text: huge }),
    ]);
    expect(out.truncated).toBe(true);
    expect(out.text).toHaveLength(SPAWN_WORK_MAX_CHARS);
  });

  it('does not truncate what fits', () => {
    const out = finalTurnText([ev({ kind: 'assistant', text: 'short' })]);
    expect(out).toEqual({ text: 'short', truncated: false });
  });
});

describe('parseTranscriptJsonl', () => {
  it('skips a torn line instead of throwing — the file is being appended to', () => {
    const body = `${JSON.stringify({ id: '1', kind: 'assistant', text: 'ok' })}\n{"id":"2","kind":`;
    expect(parseTranscriptJsonl(body)).toEqual([{ id: '1', kind: 'assistant', text: 'ok' }]);
  });
});

describe('fetchSpawnWork', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const jsonl = (...events: Array<Record<string, unknown>>) =>
    `${events.map((e) => JSON.stringify(e)).join('\n')}\n`;

  it('reads the work off the first pane that answers', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.includes('p-term')
        ? ({ ok: false, status: 404 } as Response)
        : ({
            ok: true,
            text: async () =>
              jsonl(
                { id: '1', kind: 'user', text: 'research browser use' },
                { id: '2', kind: 'assistant', text: '# Browser use\n\nRead 14 pages.' },
              ),
          } as Response),
    );
    vi.stubGlobal('fetch', fetchMock);
    expect(await fetchSpawnWork(['p-term', 'p-agent'])).toEqual({
      kind: 'work',
      text: '# Browser use\n\nRead 14 pages.',
      truncated: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reports GONE when the transcript has been pruned', async () => {
    // Not hypothetical: Claude prunes its own transcripts on a retention window
    // and the endpoint's locator never looks at the archive's byte copy. The
    // summary on the row is then the only surviving trace, and the card has to
    // say that rather than opening onto a blank.
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 404 }) as Response);
    const out = await fetchSpawnWork(['p-agent']);
    expect(out.kind).toBe('gone');
  });

  it('NEVER RETURNS AN EMPTY SUCCESS', async () => {
    // An expansion that opens onto nothing reads as "the work is gone" while
    // claiming to have found it — the one outcome this must not produce.
    vi.stubGlobal(
      'fetch',
      async () =>
        ({ ok: true, text: async () => jsonl({ id: '1', kind: 'user', text: 'go' }) }) as Response,
    );
    expect((await fetchSpawnWork(['p-agent'])).kind).toBe('gone');
  });

  it('survives a network failure', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('offline');
    });
    expect((await fetchSpawnWork(['p-agent'])).kind).toBe('gone');
  });

  it('is gone for a chat with no panes at all', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect((await fetchSpawnWork([])).kind).toBe('gone');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
