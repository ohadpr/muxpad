import type { ChatEvent } from '@muxpad/shared';
import { describe, expect, it } from 'vitest';
import { workingHint } from './working-hint';

/**
 * The owner's ask, as tests: during a long tool stretch the indicator should
 * carry a clue about WHAT is going on — without the chat growing a line.
 */
const ev = (o: Partial<ChatEvent> & { kind: string }): ChatEvent =>
  ({ id: o.id ?? Math.random().toString(36), ts: 1, ...o }) as ChatEvent;

const say = (text: string, voice: 'private' | 'reply' = 'private') =>
  ev({ kind: 'assistant', text, voice });
const ran = (name = 'Bash') => ev({ kind: 'tool_use', name, toolUseId: 't1', input: {} });
const user = () => ev({ kind: 'user', text: 'go', id: 'u1' });

describe('what the working indicator says during a long stretch', () => {
  it('takes the most recent hidden narration, not the first', () => {
    expect(
      workingHint([user(), say('Reading the index.'), ran(), say('Now the transcript.'), ran()]),
    ).toBe('Now the transcript.');
  });

  it('keeps a whole thought — the first SENTENCE, not the first N characters', () => {
    // These lines lead with the load-bearing clause; a character cut would
    // give you half a word of it.
    expect(
      workingHint([
        user(),
        say(
          "Sweep only alerts — it doesn't re-record, so that's not the overwrite path. Let me pull the stored metadata.",
        ),
      ]),
    ).toBe("Sweep only alerts — it doesn't re-record, so that's not the overwrite path.");
  });

  it('strips the markdown that is noise at this size', () => {
    expect(
      workingHint([user(), say('Critical clue: the model is **`ivrit-ai/whisper-large`** here.')]),
    ).toBe('Critical clue: the model is ivrit-ai/whisper-large here.');
  });

  it('clamps a sentence that never ends, on a word boundary', () => {
    const hint = workingHint([user(), say(`${'alpha '.repeat(60)}omega`)]);
    expect(hint).not.toBeNull();
    expect((hint as string).length).toBeLessThanOrEqual(121);
    expect(hint).toMatch(/…$/);
    expect(hint).not.toMatch(/alp…$/); // cut between words, not inside one
  });

  it('says NOTHING when the text is already on screen', () => {
    // Agent mode renders this narration inline. Repeating the latest line in
    // the indicator would print the same sentence twice, pixels apart.
    expect(workingHint([user(), say('A visible reply.', 'reply')])).toBeNull();
    expect(workingHint([user(), say('hidden'), say('A visible reply.', 'reply')])).toBeNull();
  });

  it('never carries a hint over from the previous turn', () => {
    // Worse than no hint: it would describe work that already finished.
    expect(
      workingHint([
        user(),
        say('Old thinking.'),
        ev({ kind: 'user', text: 'again', id: 'u2' }),
        ran(),
      ]),
    ).toBeNull();
  });

  it('is null when there is nothing to say', () => {
    expect(workingHint([])).toBeNull();
    expect(workingHint([user(), ran()])).toBeNull();
    expect(workingHint([user(), say('   ')])).toBeNull();
    expect(workingHint([user(), say('**``**')])).toBeNull();
  });
});
