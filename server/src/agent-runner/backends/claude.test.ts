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
