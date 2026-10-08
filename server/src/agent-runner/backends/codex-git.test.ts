import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gitWritableDirs, writableRootsArgs } from './codex.js';

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

/**
 * …AND DOES THE GRANT SURVIVE A RESUME?
 *
 * It did not. The dirs were passed as `--add-dir`, which `codex exec` accepts
 * and `codex exec resume` rejects outright:
 *
 *   error: unexpected argument '--add-dir' found
 *   Usage: codex exec resume --json --skip-git-repo-check --config <key=value>
 *          <SESSION_ID> [PROMPT]
 *
 * The runner caught the failure and fell back to a FRESH codex thread, so the
 * pane came back alive, answering, and with no memory of its own conversation —
 * the loudest possible symptom reported through the quietest possible channel,
 * one dim line in a log nobody reads. Found on this machine 18 times across 5
 * panes, including a chat that was simply respawned and silently lost a long
 * design brief it had just been given.
 *
 * The test above proves WHICH dirs are granted. This one proves the grant is
 * spelled in a way both subcommands accept — which is where it actually broke.
 */
describe('the grant is spelled so a RESUME can carry it', () => {
  it('uses --config, the flag both `exec` and `exec resume` accept', () => {
    const got = writableRootsArgs(['/repo/.git']);
    expect(got[0]).toBe('-c');
    expect(got[1]).toBe('sandbox_workspace_write.writable_roots=["/repo/.git"]');
  });

  it('never emits `--add-dir` — the flag resume rejects', () => {
    expect(writableRootsArgs(['/a', '/b'])).not.toContain('--add-dir');
    // And nowhere else in the backend either: one surviving `--add-dir` on the
    // common path is the whole bug back, and it only shows up on resume.
    const src = readFileSync(new URL('./codex.ts', import.meta.url), 'utf8');
    // Block comments AND whole-line `//` ones: this file argues at length about
    // the flag it must not emit, and the argument is the reason the rule holds.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toContain("'--add-dir'");
  });

  it('quotes paths, because a TOML array is not a shell word list', () => {
    expect(writableRootsArgs(['/Users/sam/My Repo/.git'])[1]).toBe(
      'sandbox_workspace_write.writable_roots=["/Users/sam/My Repo/.git"]',
    );
  });

  it('adds NOTHING when there is nothing to grant', () => {
    // An empty `-c` with an empty array would still override the user's own
    // config; saying nothing leaves it alone.
    expect(writableRootsArgs([])).toEqual([]);
  });
});
