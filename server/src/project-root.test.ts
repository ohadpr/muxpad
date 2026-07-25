import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentCwd, gitRoot, hasProjectContext } from './project-root.js';

describe('project-root', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'proj-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('gitRoot walks up to the nearest .git, else null', () => {
    const repo = join(root, 'repo');
    const deep = join(repo, 'src', 'components');
    mkdirSync(deep, { recursive: true });
    mkdirSync(join(repo, '.git'));
    expect(gitRoot(deep)).toBe(repo);
    expect(gitRoot(repo)).toBe(repo);
    // A dir with no .git anywhere up (tmp) → null.
    const orphan = join(root, 'screenshots');
    mkdirSync(orphan);
    expect(gitRoot(orphan)).toBeNull();
  });

  it('gitRoot counts a .git FILE (worktree), not just a dir', () => {
    const wt = join(root, 'worktrees', 'ui-fixes');
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(wt, '.git'), 'gitdir: /somewhere/.git/worktrees/ui-fixes');
    expect(gitRoot(join(wt, 'a', 'b'))).toBe(wt);
  });

  it('hasProjectContext detects any marker up the tree', () => {
    const p = join(root, 'proj');
    const deep = join(p, 'a', 'b');
    mkdirSync(deep, { recursive: true });
    expect(hasProjectContext(deep)).toBe(false);
    writeFileSync(join(p, 'AGENTS.md'), '# rules');
    expect(hasProjectContext(deep)).toBe(true);
  });

  it('agentCwd snaps to the git root, or returns the folder as-is', () => {
    const repo = join(root, 'r');
    const sub = join(repo, 'pkg');
    mkdirSync(sub, { recursive: true });
    mkdirSync(join(repo, '.git'));
    expect(agentCwd(sub)).toBe(repo);
    const loose = join(root, 'loose');
    mkdirSync(loose);
    expect(agentCwd(loose)).toBe(loose);
  });
});
