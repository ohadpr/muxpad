import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  compactionOverride,
  compactionOverrideOnDisk,
  settingsPath,
} from './compaction-settings.js';

describe('compactionOverride', () => {
  it('names the flag that wedged a chat at the ceiling', () => {
    const w = compactionOverride({ autoCompactEnabled: false });
    expect(w).toMatch(/autoCompactEnabled/);
    expect(w).toMatch(/Prompt is too long/);
  });

  it('names a window cap too — the back door to the same place', () => {
    expect(compactionOverride({ autoCompactWindow: 200_000 })).toMatch(/200,000/);
  });

  it('says nothing about a file that leaves compaction alone', () => {
    expect(compactionOverride({})).toBeNull();
    expect(compactionOverride({ autoCompactEnabled: true })).toBeNull();
    expect(compactionOverride({ theme: 'dark' })).toBeNull();
    expect(compactionOverride(null)).toBeNull();
    expect(compactionOverride('nonsense')).toBeNull();
  });
});

describe('compactionOverrideOnDisk', () => {
  it('reads the real file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'muxpad-settings-'));
    const p = join(dir, 'settings.json');
    writeFileSync(p, JSON.stringify({ autoCompactEnabled: false }));
    expect(compactionOverrideOnDisk(p)).toMatch(/autoCompactEnabled/);
  });

  it('is silent when the file is missing or garbage — not a crash at startup', () => {
    const dir = mkdtempSync(join(tmpdir(), 'muxpad-settings-'));
    expect(compactionOverrideOnDisk(join(dir, 'nope.json'))).toBeNull();
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{not json');
    expect(compactionOverrideOnDisk(bad)).toBeNull();
  });

  it('follows CLAUDE_CONFIG_DIR, like every other path in the runner', () => {
    expect(settingsPath({ CLAUDE_CONFIG_DIR: '/tmp/profile' } as NodeJS.ProcessEnv)).toBe(
      '/tmp/profile/settings.json',
    );
    expect(settingsPath({} as NodeJS.ProcessEnv)).toMatch(/\.claude\/settings\.json$/);
  });
});
