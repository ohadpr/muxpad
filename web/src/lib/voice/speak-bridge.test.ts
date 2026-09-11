import { describe, expect, it } from 'vitest';
import type { AppendIntent } from './protocol';
import { SpeakBridge, type VoiceChatFrame, describeQuestion, parseChatFrame } from './speak-bridge';

const spoken = (out: AppendIntent[]) =>
  out.filter((i) => i.kind === 'commentary').map((i) => i.text);
const silent = (out: AppendIntent[]) => out.filter((i) => i.kind === 'thinking').map((i) => i.text);

describe('the private scratchpad is NEVER spoken', () => {
  it('drops `stream` frames entirely — not to thinking, not anywhere', () => {
    const b = new SpeakBridge();
    const out = b.onFrame({ t: 'stream', delta: 'I should check the router first…' });
    expect(out).toEqual([]);
  });

  it('drops a whole turn of scratchpad without leaking a word of it', () => {
    const b = new SpeakBridge();
    b.onFrame({ t: 'turn-start' });
    const all: AppendIntent[] = [];
    for (const delta of ['Let me think. ', 'The user probably wants X. ', 'Actually no.']) {
      all.push(...b.onFrame({ t: 'stream', delta }));
    }
    expect(all).toEqual([]);
  });
});

describe('speak → commentary', () => {
  it('a complete reply becomes one spoken append', () => {
    const b = new SpeakBridge();
    const out = b.onFrame({ t: 'speak', id: 'r1', text: 'The tests pass.', n: 1 });
    expect(spoken(out)).toEqual(['The tests pass.']);
  });

  it('deltas speak at sentence boundaries, so speech starts mid-reply', () => {
    const b = new SpeakBridge();
    expect(spoken(b.onFrame({ t: 'speak-delta', id: 'r1', delta: 'The tests ' }))).toEqual([]);
    expect(spoken(b.onFrame({ t: 'speak-delta', id: 'r1', delta: 'pass. ' }))).toEqual([
      'The tests pass.',
    ]);
    expect(
      spoken(b.onFrame({ t: 'speak-delta', id: 'r1', delta: 'Nothing else changed.' })),
    ).toEqual(['Nothing else changed.']);
  });

  it('NEVER says a reply twice when the final `speak` follows its deltas', () => {
    const b = new SpeakBridge();
    b.onFrame({ t: 'speak-delta', id: 'r1', delta: 'The tests pass. ' });
    const out = b.onFrame({
      t: 'speak',
      id: 'r1',
      text: 'The tests pass. Nothing else changed.',
      n: 1,
    });
    // Only the part the deltas had not already said.
    expect(spoken(out)).toEqual(['Nothing else changed.']);
  });

  it('says nothing extra when `speak` exactly matches what the deltas said', () => {
    const b = new SpeakBridge();
    b.onFrame({ t: 'speak-delta', id: 'r1', delta: 'All done. ' });
    expect(spoken(b.onFrame({ t: 'speak', id: 'r1', text: 'All done. ', n: 1 }))).toEqual([]);
  });

  it('handles `speak` arriving FIRST — the deltas after it add nothing', () => {
    const b = new SpeakBridge();
    expect(spoken(b.onFrame({ t: 'speak', id: 'r1', text: 'All done.', n: 1 }))).toEqual([
      'All done.',
    ]);
    expect(spoken(b.onFrame({ t: 'speak-delta', id: 'r1', delta: 'All done.' }))).toEqual([]);
  });

  it('degrades to saying a little extra — never to silence — when a delta was lost', () => {
    const b = new SpeakBridge();
    b.onFrame({ t: 'speak-delta', id: 'r1', delta: 'The tests XXX. ' });
    const out = b.onFrame({
      t: 'speak',
      id: 'r1',
      text: 'The tests pass and the build is green.',
      n: 1,
    });
    expect(spoken(out)).toEqual(['pass and the build is green.']);
  });

  it('keeps two concurrent replies apart', () => {
    const b = new SpeakBridge();
    b.onFrame({ t: 'speak-delta', id: 'r1', delta: 'First. ' });
    b.onFrame({ t: 'speak-delta', id: 'r2', delta: 'Second. ' });
    expect(spoken(b.onFrame({ t: 'speak', id: 'r1', text: 'First. More.', n: 1 }))).toEqual([
      'More.',
    ]);
    expect(spoken(b.onFrame({ t: 'speak', id: 'r2', text: 'Second. Other.', n: 1 }))).toEqual([
      'Other.',
    ]);
  });

  it('flushes a long unpunctuated run at a word boundary rather than going silent', () => {
    const b = new SpeakBridge({ maxPendingChars: 30 });
    const out = b.onFrame({
      t: 'speak-delta',
      id: 'r1',
      delta: 'this reply just keeps going and going without any punctuation at all',
    });
    expect(spoken(out)).toHaveLength(1);
    // Cut on a space, so no word is split.
    expect(spoken(out)[0]?.endsWith('gi')).toBe(false);
  });

  it('says the tail when the final `speak` never arrives', () => {
    const b = new SpeakBridge();
    b.onFrame({ t: 'speak-delta', id: 'r1', delta: 'half a sentence with no stop' });
    const out = b.onFrame({ t: 'turn-done', ok: true });
    expect(spoken(out)).toEqual(['half a sentence with no stop']);
  });
});

describe('progress is silent', () => {
  it('turn-start is a thinking append', () => {
    const b = new SpeakBridge();
    const out = new SpeakBridge().onFrame({ t: 'turn-start' });
    expect(silent(out)).toHaveLength(1);
    expect(spoken(out)).toEqual([]);
    expect(b.isTurnRunning()).toBe(false);
  });

  it('tracks whether a turn is running', () => {
    const b = new SpeakBridge();
    b.onFrame({ t: 'turn-start' });
    expect(b.isTurnRunning()).toBe(true);
    b.onFrame({ t: 'turn-done', ok: true });
    expect(b.isTurnRunning()).toBe(false);
  });

  it('subagent progress is silent and names the subagent', () => {
    const b = new SpeakBridge();
    const out = b.onFrame({
      t: 'subagent',
      progress: { label: 'audit the router', lastTool: 'Bash: pnpm test' },
    });
    expect(spoken(out)).toEqual([]);
    expect(silent(out)[0]).toContain('audit the router');
    expect(silent(out)[0]).toContain('pnpm test');
  });

  it('a queued send is silent', () => {
    const out = new SpeakBridge().onFrame({ t: 'queued', id: 'q1', text: 'hello' });
    expect(spoken(out)).toEqual([]);
    expect(silent(out)).toHaveLength(1);
  });
});

describe('the agent needing you IS spoken', () => {
  it('speaks an ask_user question with its options', () => {
    const b = new SpeakBridge();
    const out = b.onFrame({
      t: 'question',
      qid: 'q1',
      questions: [
        {
          question: 'Which approach?',
          header: 'Approach',
          multiSelect: false,
          options: [{ label: 'Rewrite' }, { label: 'Patch' }],
        },
      ],
    });
    expect(spoken(out)).toHaveLength(1);
    expect(spoken(out)[0]).toContain('Which approach?');
    expect(spoken(out)[0]).toContain('Rewrite');
    expect(spoken(out)[0]).toContain('Patch');
  });

  it('speaks a reversibility gate the same way — it is the agent stopping on `git push`', () => {
    const text = describeQuestion([
      {
        question: 'About to run `git push`. Proceed?',
        header: 'Push',
        multiSelect: false,
        options: [{ label: 'Push it' }, { label: 'Stop' }],
      },
    ]);
    expect(text).toContain('git push');
    expect(text).toContain('waiting on you');
  });

  it('does not read out an unreasonable number of options', () => {
    const text = describeQuestion([
      {
        question: 'Pick one.',
        header: 'Pick',
        multiSelect: false,
        options: Array.from({ length: 9 }, (_, i) => ({ label: `opt${i}` })),
      },
    ]);
    expect(text).toContain('opt0');
    expect(text).not.toContain('opt8');
    expect(text).toContain('4 more');
  });

  it('handles a question with no options at all', () => {
    expect(
      describeQuestion([{ question: 'What now?', header: 'X', multiSelect: false, options: [] }]),
    ).toContain('What now?');
  });
});

describe('failures are spoken', () => {
  it('a failed turn says why', () => {
    const out = new SpeakBridge().onFrame({ t: 'turn-done', ok: false, error: 'runner died' });
    expect(spoken(out).join(' ')).toContain('runner died');
  });

  it('a failed turn with no reason still says something', () => {
    const out = new SpeakBridge().onFrame({ t: 'turn-done', ok: false });
    expect(spoken(out)).toHaveLength(1);
  });

  it('a server error is spoken and ends the turn', () => {
    const b = new SpeakBridge();
    b.onFrame({ t: 'turn-start' });
    const out = b.onFrame({ t: 'error', message: 'socket closed' });
    expect(spoken(out).join(' ')).toContain('socket closed');
    expect(b.isTurnRunning()).toBe(false);
  });

  it('a non-fatal notice is silent', () => {
    const out = new SpeakBridge().onFrame({ t: 'notice', message: 'reconnecting' });
    expect(spoken(out)).toEqual([]);
  });
});

describe('parseChatFrame — an allow-list, so a new chat frame is never spoken by accident', () => {
  it('accepts the frames this module handles', () => {
    expect(parseChatFrame({ t: 'speak', id: 'a', text: 'x', n: 1 })).not.toBeNull();
    expect(parseChatFrame({ t: 'turn-done', ok: true })).not.toBeNull();
  });

  it('rejects frames it has no opinion about', () => {
    expect(parseChatFrame({ t: 'events', phase: 'live', events: [] })).toBeNull();
    expect(parseChatFrame({ t: 'session', session: null })).toBeNull();
    expect(parseChatFrame({ t: 'some-future-frame' })).toBeNull();
  });

  it('rejects junk', () => {
    expect(parseChatFrame(null)).toBeNull();
    expect(parseChatFrame('speak')).toBeNull();
    expect(parseChatFrame({})).toBeNull();
    expect(parseChatFrame({ t: 42 })).toBeNull();
  });

  it('an unrecognised frame that does get through produces nothing', () => {
    const out = new SpeakBridge().onFrame({ t: 'question-done', qid: 'q1' } as VoiceChatFrame);
    expect(out).toEqual([]);
  });
});

describe('reset', () => {
  it('drops per-reply state so ids cannot collide across delegations', () => {
    const b = new SpeakBridge();
    b.onFrame({ t: 'speak-delta', id: 'r1', delta: 'Old answer. ' });
    b.reset();
    // Same id, new delegation: the whole thing is said, not just a tail.
    expect(spoken(b.onFrame({ t: 'speak', id: 'r1', text: 'New answer.', n: 1 }))).toEqual([
      'New answer.',
    ]);
  });
});
