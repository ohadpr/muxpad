import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generatedBody, sha256 } from './agent-files.js';
import {
  CHAT_MODE_MIGRATION,
  CHAT_MODE_SEED,
  LEGACY_CHAT_MODE_FILE,
  SHIPPED_CHAT_MODE_DEFAULTS,
  applyModeToStartupCmd,
  chatModePath,
  modeFromStartupCmd,
  readChatModeOverlay,
  retireLegacyChatModeFile,
  seedChatMode,
  wrapModeNote,
} from './agent-modes.js';

describe('chat-mode.md generation', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chat-mode-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes the seed on a fresh data dir, under the generated banner', () => {
    seedChatMode(dir);
    expect(readFileSync(chatModePath(dir), 'utf8')).toBe(generatedBody(CHAT_MODE_SEED));
  });

  it('is regenerated on every boot — the contract cannot go stale', () => {
    // chat-mode.md had the SAME staleness exposure as agent-instructions.md: a
    // machine that booted once kept its first-ever contract forever.
    seedChatMode(dir);
    writeFileSync(chatModePath(dir), '# an older contract\n');
    seedChatMode(dir);
    seedChatMode(dir);
    expect(readFileSync(chatModePath(dir), 'utf8')).toBe(generatedBody(CHAT_MODE_SEED));
  });

  it('the shipped-defaults list the one-shot migration reads is sane', () => {
    expect(SHIPPED_CHAT_MODE_DEFAULTS.length).toBeGreaterThan(0);
    for (const hash of CHAT_MODE_MIGRATION.knownDefaults) expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(CHAT_MODE_MIGRATION.knownDefaults).toContain(sha256(CHAT_MODE_SEED));
    // The house contract only means anything in Chat mode, so a rescued one
    // must NOT land in the always-injected notes file.
    expect(CHAT_MODE_MIGRATION.appendToNotes).toBe(false);
  });

  it('the seed states every clause of the Chat contract', () => {
    // These are the behaviors the mode PROMISES in the UI tooltip; if the
    // seed drifts away from them the toggle starts lying.
    expect(CHAT_MODE_SEED).toMatch(/decisive/i);
    expect(CHAT_MODE_SEED).toMatch(/subagent/i);
    expect(CHAT_MODE_SEED).toMatch(/3 sentences/i);
    expect(CHAT_MODE_SEED).toMatch(/no preamble|no narration/i);
    expect(CHAT_MODE_SEED).toMatch(/one line/i);
    expect(CHAT_MODE_SEED).toMatch(/blocked/i);
    expect(CHAT_MODE_SEED).toMatch(/reverse/i);
  });
});

describe('readChatModeOverlay', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chat-mode-'));
    seedChatMode(dir);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns the file contents in Chat mode', () => {
    expect(readChatModeOverlay('chat', dir)).toBe(generatedBody(CHAT_MODE_SEED));
  });

  it('returns null in Agent mode — Agent injects NOTHING, by definition', () => {
    expect(readChatModeOverlay('agent', dir)).toBeNull();
  });

  it('missing file → null (deleting it is a supported opt-out, not an error)', () => {
    const empty = mkdtempSync(join(tmpdir(), 'chat-mode-empty-'));
    try {
      expect(readChatModeOverlay('chat', empty)).toBeNull();
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('whitespace-only file → null', () => {
    writeFileSync(chatModePath(dir), '\n  \n\t\n');
    expect(readChatModeOverlay('chat', dir)).toBeNull();
  });
});

describe('applyModeToStartupCmd', () => {
  it('adds --mode chat right after the verb', () => {
    expect(applyModeToStartupCmd('muxpad agent', 'chat')).toBe('muxpad agent --mode chat');
  });

  it('places --mode AFTER --backend, matching the ws self-heal rewrite shape', () => {
    // Load-bearing: ws.ts composes `muxpad agent --backend X --mode chat …` and
    // compares it to the stored command to tell a reconnect from a new
    // runner. A different order here would make every hello look new.
    expect(applyModeToStartupCmd('muxpad agent --backend codex --resume abc', 'chat')).toBe(
      'muxpad agent --backend codex --mode chat --resume abc',
    );
  });

  it('preserves --model and --resume', () => {
    expect(applyModeToStartupCmd("muxpad agent --model 'opus[1m]' --resume s1", 'chat')).toBe(
      "muxpad agent --mode chat --model 'opus[1m]' --resume s1",
    );
  });

  it('Agent mode is the ABSENCE of the flag (existing rows never churn)', () => {
    expect(applyModeToStartupCmd('muxpad agent --resume s1', 'agent')).toBe(
      'muxpad agent --resume s1',
    );
    expect(applyModeToStartupCmd('muxpad agent --mode chat --resume s1', 'agent')).toBe(
      'muxpad agent --resume s1',
    );
  });

  it('does not accrete flags across repeated switches', () => {
    let cmd: string | null = 'muxpad agent --resume s1';
    for (const m of ['chat', 'agent', 'chat', 'chat', 'agent', 'chat'] as const) {
      cmd = applyModeToStartupCmd(cmd, m);
    }
    expect(cmd).toBe('muxpad agent --mode chat --resume s1');
    expect(cmd?.match(/--mode/g)).toHaveLength(1);
  });

  it('leaves a non-agent command (or null) untouched', () => {
    expect(applyModeToStartupCmd(null, 'chat')).toBeNull();
    expect(applyModeToStartupCmd('npm run dev', 'chat')).toBe('npm run dev');
  });

  it('leaves a PENDING `muxpad agent --pick` command byte-identical', () => {
    // Regression: that literal is compared verbatim by the /agent-backend,
    // /as-terminal and /as-web 409 gates and by the dead-runner sweep's skip.
    // Rewriting it to `muxpad agent --mode chat --pick` wedged the harness
    // picker (every choice 409'd) and made the sweep bounce the pane.
    expect(applyModeToStartupCmd('muxpad agent --pick', 'chat')).toBe('muxpad agent --pick');
    expect(applyModeToStartupCmd('muxpad agent --pick', 'agent')).toBe('muxpad agent --pick');
  });

  it('never emits shell metacharacters — only the two allowlisted literals', () => {
    // The result is TYPED INTO A SHELL by ptyd, so the only thing this
    // function may add is the fixed string ' --mode chat'.
    const out = applyModeToStartupCmd('muxpad agent', 'chat') ?? '';
    expect(out.replace('muxpad agent', '')).toBe(' --mode chat');
  });
});

describe('wrapModeNote (the mid-session switch note)', () => {
  it('carries the full contract when switching TO Chat mode', () => {
    const note = wrapModeNote('chat', '# Chat mode\nbe terse');
    expect(note.startsWith('<muxpad-mode>')).toBe(true);
    expect(note.endsWith('</muxpad-mode>')).toBe(true);
    expect(note).toContain('# Chat mode');
    expect(note).toContain('be terse');
  });

  it('falls back to an inline contract when the overlay file is gone', () => {
    const note = wrapModeNote('chat', null);
    expect(note).toContain('Chat mode');
    expect(note).toMatch(/decisive/i);
  });

  it('switching to Agent REVOKES rather than restates — Agent has no contract', () => {
    const note = wrapModeNote('agent', null);
    expect(note).toContain('Agent mode');
    expect(note).toMatch(/no longer applies/i);
  });

  it('uses a tag distinct from <muxpad-instructions> so the model can tell them apart', () => {
    expect(wrapModeNote('chat', 'x')).not.toContain('<muxpad-instructions>');
  });
});

// ── the rename's compatibility surface ────────────────────────────────────
//
// 'do'/'deep' became 'chat'/'agent'. Stored rows were migrated, but COMMANDS
// can still arrive in the old spelling: a startup_cmd an older server wrote
// and never respawned, a script pinned to an older CLI. None of those may
// wedge a pane.

describe('pre-rename spellings', () => {
  it('applyModeToStartupCmd strips a legacy flag instead of doubling up', () => {
    expect(applyModeToStartupCmd('muxpad agent --mode do --resume s1', 'chat')).toBe(
      'muxpad agent --mode chat --resume s1',
    );
    expect(applyModeToStartupCmd('muxpad agent --mode deep --resume s1', 'chat')).toBe(
      'muxpad agent --mode chat --resume s1',
    );
    // …and to Agent mode, the legacy flag is removed outright.
    expect(applyModeToStartupCmd('muxpad agent --mode do --resume s1', 'agent')).toBe(
      'muxpad agent --resume s1',
    );
  });

  it('modeFromStartupCmd reads both vocabularies, and NULL for a bare command', () => {
    expect(modeFromStartupCmd('muxpad agent --mode chat')).toBe('chat');
    expect(modeFromStartupCmd('muxpad agent --mode agent')).toBe('agent');
    expect(modeFromStartupCmd('muxpad agent --mode do')).toBe('chat');
    expect(modeFromStartupCmd('muxpad agent --mode deep')).toBe('agent');
    // "said nothing" ≠ "said baseline": only the first may take a default.
    expect(modeFromStartupCmd('muxpad agent --resume s1')).toBeNull();
    expect(modeFromStartupCmd(null)).toBeNull();
    expect(modeFromStartupCmd('muxpad agent --mode turbo')).toBeNull();
  });
});

describe('retireLegacyChatModeFile', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chat-mode-retire-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const legacy = () => join(dir, LEGACY_CHAT_MODE_FILE);

  it('removes muxpad’s OWN generated do-mode.md (bannered, as shipped)', () => {
    // This is the byte sequence actually sitting in every upgrading install's
    // data dir — the pre-rename seed under the generated banner.
    writeFileSync(legacy(), generatedBody(CHAT_MODE_SEED));
    retireLegacyChatModeFile(dir);
    expect(existsSync(legacy())).toBe(false);
  });

  it('KEEPS a do-mode.md the user edited — it is not ours to delete', () => {
    writeFileSync(legacy(), '# my own contract\nalways speak in haiku\n');
    retireLegacyChatModeFile(dir);
    expect(existsSync(legacy())).toBe(true);
  });

  it('is a no-op when the file was never there, and never throws', () => {
    expect(() => retireLegacyChatModeFile(dir)).not.toThrow();
    expect(() => retireLegacyChatModeFile(join(dir, 'nope'))).not.toThrow();
  });

  it('does not touch the NEW file', () => {
    seedChatMode(dir);
    writeFileSync(legacy(), generatedBody(CHAT_MODE_SEED));
    retireLegacyChatModeFile(dir);
    expect(readFileSync(chatModePath(dir), 'utf8')).toBe(generatedBody(CHAT_MODE_SEED));
  });
});
