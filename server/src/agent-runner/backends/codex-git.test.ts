import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gitWritableDirs } from './codex.js';

/**
 * CAN A CODEX PANE COMMIT ITS OWN WORK?
 *
 * It could not, in any ordinary checkout, and nothing caught it because the
 * reasoning was in a comment rather than a test: "a normal checkout keeps
 * `.git` inside the cwd (already writable), so nothing is added". Codex's
 * `workspace-write` refuses `.git` regardless of where it sits — the protection
 * is about what the directory IS, not where it is — so the git dir was granted
 * for worktrees and withheld for everyone else.
 *
 * Measured in a scratch repo with `.git` plainly inside the cwd: workspace-write
 * alone gives `fatal: Unable to create '.git/index.lock': Operation not
 * permitted`; the same run with the git dir in `writable_roots` commits. Three
 * review agents lost their entire output to this, and one reported commit
 * hashes that had never existed rather than the refusal.
 */
describe('codex gets write access to the git dir — in EVERY layout', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'muxpad-codexgit-'));
    execFileSync('git', ['init', '-q', '.'], { cwd: dir, stdio: 'ignore' });
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('grants it for an ORDINARY checkout — the case that was broken', () => {
    const got = gitWritableDirs(dir);
    expect(got).toHaveLength(1);
    // realpath, because macOS tmpdirs are symlinked through /private.
    expect(resolve(got[0] as string)).toMatch(/\.git$/);
  });

  it('still grants the COMMON dir from inside a worktree', () => {
    execFileSync(
      'git',
      ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'],
      { cwd: dir, stdio: 'ignore' },
    );
    const wt = join(dir, '..', `${dir.split('/').pop()}-wt`);
    execFileSync('git', ['worktree', 'add', '-q', wt, '-b', 'wt'], { cwd: dir, stdio: 'ignore' });
    try {
      const got = gitWritableDirs(wt);
      expect(got).toHaveLength(1);
      // The MAIN repo's .git, not the worktree's .git FILE.
      expect(got[0]).toContain('.git');
      expect(got[0]).not.toBe(join(wt, '.git'));
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });

  it('yields nothing outside a repo rather than throwing at backend startup', () => {
    const plain = mkdtempSync(join(tmpdir(), 'muxpad-norepo-'));
    try {
      expect(gitWritableDirs(plain)).toEqual([]);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});
