import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DO_MODE_SEED,
  applyModeToStartupCmd,
  doModePath,
  readDoModeOverlay,
  seedDoMode,
  wrapModeNote,
} from './agent-modes.js';

describe('do-mode.md seeding', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'do-mode-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes the seed on a fresh data dir', () => {
    seedDoMode(dir);
    expect(readFileSync(doModePath(dir), 'utf8')).toBe(DO_MODE_SEED);
  });

  it('seeds ONCE — an edited file is the user’s and is never overwritten', () => {
    seedDoMode(dir);
    writeFileSync(doModePath(dir), '# my own contract\nbe brutal\n');
    seedDoMode(dir);
    seedDoMode(dir);
    expect(readFileSync(doModePath(dir), 'utf8')).toBe('# my own contract\nbe brutal\n');
  });

  it('the seed states every clause of the Do contract', () => {
    // These are the behaviors the mode PROMISES in the UI tooltip; if the
    // seed drifts away from them the toggle starts lying.
    expect(DO_MODE_SEED).toMatch(/decisive/i);
    expect(DO_MODE_SEED).toMatch(/subagent/i);
    expect(DO_MODE_SEED).toMatch(/3 sentences/i);
    expect(DO_MODE_SEED).toMatch(/no preamble|no narration/i);
    expect(DO_MODE_SEED).toMatch(/one line/i);
    expect(DO_MODE_SEED).toMatch(/blocked/i);
    expect(DO_MODE_SEED).toMatch(/reverse/i);
  });
});

describe('readDoModeOverlay', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'do-mode-'));
    seedDoMode(dir);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns the file contents in do mode', () => {
    expect(readDoModeOverlay('do', dir)).toBe(DO_MODE_SEED);
  });

  it('returns null in deep mode — deep injects NOTHING, by definition', () => {
    expect(readDoModeOverlay('deep', dir)).toBeNull();
  });

  it('missing file → null (deleting it is a supported opt-out, not an error)', () => {
    const empty = mkdtempSync(join(tmpdir(), 'do-mode-empty-'));
    try {
      expect(readDoModeOverlay('do', empty)).toBeNull();
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('whitespace-only file → null', () => {
    writeFileSync(doModePath(dir), '\n  \n\t\n');
    expect(readDoModeOverlay('do', dir)).toBeNull();
  });
});

describe('applyModeToStartupCmd', () => {
  it('adds --mode do right after the verb', () => {
    expect(applyModeToStartupCmd('muxpad agent', 'do')).toBe('muxpad agent --mode do');
  });

  it('places --mode AFTER --backend, matching the ws self-heal rewrite shape', () => {
    // Load-bearing: ws.ts composes `muxpad agent --backend X --mode do …` and
    // compares it to the stored command to tell a reconnect from a new
    // runner. A different order here would make every hello look new.
    expect(applyModeToStartupCmd('muxpad agent --backend codex --resume abc', 'do')).toBe(
      'muxpad agent --backend codex --mode do --resume abc',
    );
  });

  it('preserves --model and --resume', () => {
    expect(applyModeToStartupCmd("muxpad agent --model 'opus[1m]' --resume s1", 'do')).toBe(
      "muxpad agent --mode do --model 'opus[1m]' --resume s1",
    );
  });

  it('deep is expressed by the ABSENCE of the flag (existing rows never churn)', () => {
    expect(applyModeToStartupCmd('muxpad agent --resume s1', 'deep')).toBe(
      'muxpad agent --resume s1',
    );
    expect(applyModeToStartupCmd('muxpad agent --mode do --resume s1', 'deep')).toBe(
      'muxpad agent --resume s1',
    );
  });

  it('does not accrete flags across repeated switches', () => {
    let cmd: string | null = 'muxpad agent --resume s1';
    for (const m of ['do', 'deep', 'do', 'do', 'deep', 'do'] as const) {
      cmd = applyModeToStartupCmd(cmd, m);
    }
    expect(cmd).toBe('muxpad agent --mode do --resume s1');
    expect(cmd?.match(/--mode/g)).toHaveLength(1);
  });

  it('leaves a non-agent command (or null) untouched', () => {
    expect(applyModeToStartupCmd(null, 'do')).toBeNull();
    expect(applyModeToStartupCmd('npm run dev', 'do')).toBe('npm run dev');
  });

  it('leaves a PENDING `muxpad agent --pick` command byte-identical', () => {
    // Regression: that literal is compared verbatim by the /agent-backend,
    // /as-terminal and /as-web 409 gates and by the dead-runner sweep's skip.
    // Rewriting it to `muxpad agent --mode do --pick` wedged the harness
    // picker (every choice 409'd) and made the sweep bounce the pane.
    expect(applyModeToStartupCmd('muxpad agent --pick', 'do')).toBe('muxpad agent --pick');
    expect(applyModeToStartupCmd('muxpad agent --pick', 'deep')).toBe('muxpad agent --pick');
  });

  it('never emits shell metacharacters — only the two allowlisted literals', () => {
    // The result is TYPED INTO A SHELL by ptyd, so the only thing this
    // function may add is the fixed string ' --mode do'.
    const out = applyModeToStartupCmd('muxpad agent', 'do') ?? '';
    expect(out.replace('muxpad agent', '')).toBe(' --mode do');
  });
});

describe('wrapModeNote (the mid-session switch note)', () => {
  it('carries the full contract when switching TO do', () => {
    const note = wrapModeNote('do', '# Do mode\nbe terse');
    expect(note.startsWith('<muxpad-mode>')).toBe(true);
    expect(note.endsWith('</muxpad-mode>')).toBe(true);
    expect(note).toContain('# Do mode');
    expect(note).toContain('be terse');
  });

  it('falls back to an inline contract when the overlay file is gone', () => {
    const note = wrapModeNote('do', null);
    expect(note).toContain('Do mode');
    expect(note).toMatch(/decisive/i);
  });

  it('switching to deep REVOKES rather than restates — deep has no contract', () => {
    const note = wrapModeNote('deep', null);
    expect(note).toContain('Deep mode');
    expect(note).toMatch(/no longer applies/i);
  });

  it('uses a tag distinct from <muxpad-instructions> so the model can tell them apart', () => {
    expect(wrapModeNote('do', 'x')).not.toContain('<muxpad-instructions>');
  });
});
