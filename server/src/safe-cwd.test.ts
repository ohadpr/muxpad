import { homedir, tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { safeCwd } from './safe-cwd.js';

describe('safeCwd', () => {
  it('returns the cwd when it is an existing directory', () => {
    expect(safeCwd(tmpdir())).toBe(tmpdir());
  });

  it('falls back to home for a missing directory (e.g. a torn-down worktree)', () => {
    expect(safeCwd('/no/such/dir/abc-1058-onboarding-popup-scoping')).toBe(homedir());
  });

  it('falls back to home for null/undefined/empty', () => {
    expect(safeCwd(null)).toBe(homedir());
    expect(safeCwd(undefined)).toBe(homedir());
    expect(safeCwd('')).toBe(homedir());
  });

  it('falls back to home when the path is a file, not a directory', () => {
    // A file path exists but isn't a spawnable cwd.
    expect(safeCwd(import.meta.url.replace('file://', ''))).toBe(homedir());
  });
});
