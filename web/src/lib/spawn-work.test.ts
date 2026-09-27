import type { ChatEvent } from '@muxpad/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SPAWN_WORK_MAX_CHARS,
  fetchSpawnWork,
  finalAnswer,
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

describe('finalAnswer — the LAST THING IT SAID, not the story of how it worked', () => {
  it('takes only the final assistant MESSAGE, not the whole final turn', () => {
    // THE DEFECT, in one test. A worker narrates as it works — "I'll start by
    // reading the constraints doc", "Now the core of item 1 —", "Now the
    // scattered re-inks" — and all of that is ONE turn, because one user message
    // started it. Collecting the turn therefore collected the entire story:
    // "way too verbose and contains the entire story".
    //
    // The last message is the thing it said when it was DONE, which is its
    // answer. Everything before it is working-out, and the working-out lives in
    // the sub-chat, one click away through the card's head.
    const events = [
      ev({ kind: 'user', text: 'clean up the dead CSS' }),
      ev({ kind: 'assistant', text: "I'll start by reading the constraints doc" }),
      ev({ kind: 'assistant', text: 'Now the core of item 1 —' }),
      ev({ kind: 'assistant', text: 'Now the scattered re-inks' }),
      ev({ kind: 'assistant', text: '**Done.** 2 dead rules, listed in /tmp/dead-css.md.' }),
    ];
    expect(finalAnswer(events).text).toBe('**Done.** 2 dead rules, listed in /tmp/dead-css.md.');
  });

  it('skips the actions to find it', () => {
    const events = [
      ev({ kind: 'assistant', text: 'the answer' }),
      ev({ kind: 'tool_use', name: 'Bash', toolUseId: 't1' }),
      ev({ kind: 'thinking', text: 'hmm' }),
    ];
    expect(finalAnswer(events).text).toBe('the answer');
  });

  it('never reaches back past the last user message', () => {
    // A worker that ended on a question or a tool call has said nothing since
    // its task arrived — and the turn BEFORE that is somebody else's answer.
    const events = [
      ev({ kind: 'assistant', text: 'an answer from an earlier turn' }),
      ev({ kind: 'user', text: 'now do the next thing' }),
      ev({ kind: 'tool_use', name: 'Bash', toolUseId: 't1' }),
    ];
    expect(finalAnswer(events).text).toBe('');
  });

  it('is empty for a worker that never answered', () => {
    expect(finalAnswer([ev({ kind: 'user', text: 'go' })]).text).toBe('');
    expect(finalAnswer([]).text).toBe('');
  });

  it('SAYS SO when it hits the backstop, rather than ending mid-sentence', () => {
    const huge = 'x'.repeat(SPAWN_WORK_MAX_CHARS + 500);
    const out = finalAnswer([ev({ kind: 'assistant', text: huge })]);
    expect(out.truncated).toBe(true);
    expect(out.text).toHaveLength(SPAWN_WORK_MAX_CHARS);
  });

  it('does not truncate what fits', () => {
    expect(finalAnswer([ev({ kind: 'assistant', text: 'short' })])).toEqual({
      text: 'short',
      truncated: false,
    });
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
