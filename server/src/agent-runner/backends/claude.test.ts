// The Claude backend spawns a real Agent SDK session at construction, so —
// unlike codex/cursor, whose fake-spawner tests exercise the whole backend —
// the universal-instructions injection is tested at its seam:
// claudeSystemPromptOption builds the exact `systemPrompt` option the backend
// spreads into the SDK query() Options.
import { describe, expect, it } from 'vitest';
import { claudeSystemPromptOption } from './claude.js';

describe('claude backend — universal muxpad instructions', () => {
  it('appends the instructions to the default claude_code preset (native SDK mechanism)', () => {
    expect(claudeSystemPromptOption('use muxpad publish')).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append: 'use muxpad publish',
    });
  });

  it('missing file → no systemPrompt option at all (inject nothing, no error)', () => {
    expect(claudeSystemPromptOption(null)).toBeUndefined();
  });
});

describe('claude backend — ⚡ Do-mode overlay (same native preset+append seam)', () => {
  it('appends the mode overlay AFTER the universal instructions', () => {
    // Order is load-bearing: capabilities first, behavior last, so the
    // behavioral contract reads as the most recent (governing) instruction.
    expect(claudeSystemPromptOption('use muxpad publish', '# Do mode\nbe terse')).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append: 'use muxpad publish\n\n# Do mode\nbe terse',
    });
  });

  it('deep mode (null overlay) is byte-for-byte the pre-mode option', () => {
    expect(claudeSystemPromptOption('use muxpad publish', null)).toEqual(
      claudeSystemPromptOption('use muxpad publish'),
    );
  });

  it('overlay alone still injects (a user who deleted agent-instructions.md)', () => {
    expect(claudeSystemPromptOption(null, '# Do mode')).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append: '# Do mode',
    });
  });

  it('both missing → no systemPrompt option at all', () => {
    expect(claudeSystemPromptOption(null, null)).toBeUndefined();
  });

  it('whitespace-only inputs count as absent (no empty append block)', () => {
    expect(claudeSystemPromptOption('  \n ', '\t')).toBeUndefined();
  });
});
