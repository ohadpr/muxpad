import { describe, expect, it, vi } from 'vitest';
import {
  CleanupError,
  MAX_TRANSCRIPT_CHARS,
  assertCleanable,
  buildCleanupPrompt,
  cleanTranscript,
  parseCleanupReply,
} from './clean-transcript.js';

// Every case here mocks the model. Nothing in this file may reach the network.

describe('buildCleanupPrompt', () => {
  const prompt = buildCleanupPrompt('Max pad crown schedule', ['muxpad', 'cron', 'nimbus']);

  it('carries the dictated text and the glossary', () => {
    expect(prompt).toContain('Max pad crown schedule');
    expect(prompt).toContain('muxpad, cron, nimbus');
  });

  it('states the narrow contract — errors only, never meaning', () => {
    expect(prompt).toMatch(/never change meaning/i);
    expect(prompt).toMatch(/leave it exactly as it is/i);
    expect(prompt).toMatch(/unchanged is a correct/i);
  });

  it('asks for bare text, no preamble', () => {
    expect(prompt).toMatch(/no preamble/i);
  });

  it('puts the rules ahead of the glossary and the glossary ahead of the text', () => {
    expect(prompt.indexOf('Rules:')).toBeLessThan(prompt.indexOf('muxpad, cron, nimbus'));
    expect(prompt.indexOf('muxpad, cron, nimbus')).toBeLessThan(
      prompt.indexOf('Max pad crown schedule'),
    );
  });

  it('handles an empty glossary without emitting a stray blank list', () => {
    expect(buildCleanupPrompt('hello there', [])).toContain('(none)');
  });
});

describe('parseCleanupReply', () => {
  const original = 'check the crown schedule on Max pad';

  it('returns the corrected text', () => {
    expect(parseCleanupReply('check the cron schedule on muxpad', original)).toBe(
      'check the cron schedule on muxpad',
    );
  });

  it('accepts an unchanged reply — that is a valid correction', () => {
    expect(parseCleanupReply(original, original)).toBe(original);
  });

  it('trims and unwraps a code fence', () => {
    expect(parseCleanupReply('```\ncheck the cron schedule on muxpad\n```', original)).toBe(
      'check the cron schedule on muxpad',
    );
    expect(parseCleanupReply('```text\ncheck the cron schedule on muxpad\n```', original)).toBe(
      'check the cron schedule on muxpad',
    );
  });

  it('unwraps XML tags the model echoed back', () => {
    expect(parseCleanupReply('<text>check the cron schedule on muxpad</text>', original)).toBe(
      'check the cron schedule on muxpad',
    );
  });

  it('preserves internal newlines and spacing', () => {
    const multi = 'first line about cron\n\nsecond line about muxpad';
    expect(parseCleanupReply(multi, multi)).toBe(multi);
  });

  it('refuses an empty reply rather than returning the input', () => {
    expect(() => parseCleanupReply('   ', original)).toThrow(CleanupError);
  });

  it('refuses a reply that answered the message instead of fixing it', () => {
    const answer = 'Sure! Here is what the cron schedule does: '.repeat(10);
    expect(() => parseCleanupReply(answer, original)).toThrow(/implausible/);
  });

  it('refuses a reply that dropped most of the content', () => {
    expect(() => parseCleanupReply('ok', original)).toThrow(/implausible/);
  });

  it('lets a short input grow — the floor is absolute, not proportional', () => {
    expect(parseCleanupReply('muxpad cron', 'Max pad')).toBe('muxpad cron');
  });
});

describe('assertCleanable', () => {
  it('rejects empty and whitespace-only text', () => {
    expect(() => assertCleanable('')).toThrow(CleanupError);
    expect(() => assertCleanable('   \n ')).toThrow(/text is required/);
  });

  it('rejects a non-string body field', () => {
    expect(() => assertCleanable(undefined)).toThrow(/text is required/);
    expect(() => assertCleanable({ text: 'hi' })).toThrow(/text is required/);
  });

  it('rejects an absurd size', () => {
    const err = (() => {
      try {
        assertCleanable('x'.repeat(MAX_TRANSCRIPT_CHARS + 1));
      } catch (e) {
        return e as CleanupError;
      }
    })();
    expect(err?.code).toBe('too_large');
  });

  it('accepts text exactly at the limit', () => {
    expect(() => assertCleanable('x'.repeat(MAX_TRANSCRIPT_CHARS))).not.toThrow();
  });
});

describe('cleanTranscript', () => {
  const glossary = ['muxpad', 'cron', 'nimbus', 'Acme', 'GTM', 'artifact'];

  it('hands the model a prompt built from the text + glossary and returns its reply', async () => {
    const model = vi.fn().mockResolvedValue('set up the cron schedule on muxpad');
    const out = await cleanTranscript({
      text: 'set up the crown schedule on Max pad',
      glossary,
      model,
    });
    expect(out).toBe('set up the cron schedule on muxpad');
    expect(model.mock.calls[0]?.[0]).toContain('set up the crown schedule on Max pad');
    expect(model.mock.calls[0]?.[0]).toContain('muxpad');
  });

  it('never calls the model for input it already rejects', async () => {
    const model = vi.fn();
    await expect(cleanTranscript({ text: '', glossary, model })).rejects.toThrow(CleanupError);
    await expect(
      cleanTranscript({ text: 'x'.repeat(MAX_TRANSCRIPT_CHARS + 1), glossary, model }),
    ).rejects.toThrow(/exceeds/);
    expect(model).not.toHaveBeenCalled();
  });

  it('surfaces an unreachable model as unavailable, never as the original text', async () => {
    const model = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const err: unknown = await cleanTranscript({
      text: 'hello there friend',
      glossary,
      model,
    }).then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(CleanupError);
    expect((err as CleanupError).code).toBe('unavailable');
    expect((err as CleanupError).message).toMatch(/ECONNREFUSED/);
  });

  it('aborts the model when the deadline passes', async () => {
    let seen: AbortSignal | null = null;
    const model = vi.fn((_p: string, signal: AbortSignal) => {
      seen = signal;
      return new Promise<string>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    });
    const err: unknown = await cleanTranscript({
      text: 'hello there friend',
      glossary,
      model,
      timeoutMs: 5,
    }).then(
      () => null,
      (e) => e,
    );
    expect(seen).not.toBeNull();
    expect((err as CleanupError).code).toBe('unavailable');
  });
});
