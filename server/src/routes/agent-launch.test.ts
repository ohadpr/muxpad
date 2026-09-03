// What the empty chat's launch card is offered: recent folders and, per
// backend, the models we have actually seen that backend report.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { recordModelCatalog } from '../agent-model-catalog.js';
import { openDb } from '../store/db.js';
import { type TestApp, createTestApp } from '../test-helpers/createTestApp.js';
import { type RecentFolder, recentFolders, tildePath } from './agent-launch.js';

describe('tildePath', () => {
  it('collapses the home prefix and leaves everything else alone', () => {
    expect(tildePath('/Users/me/dev/x', '/Users/me')).toBe('~/dev/x');
    expect(tildePath('/Users/me', '/Users/me')).toBe('~');
    // Not a prefix match on the string — a sibling dir must not become `~…`.
    expect(tildePath('/Users/meplus/dev', '/Users/me')).toBe('/Users/meplus/dev');
    expect(tildePath('/opt/thing', '/Users/me')).toBe('/opt/thing');
  });
});

describe('recent folders', () => {
  let tmp: string;
  beforeEach(() => {
    // realpath: macOS's /var is a symlink to /private/var, and recentFolders
    // deliberately resolves what it returns.
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'muxpad-folders-')));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  const mkdir = (name: string) => {
    const p = join(tmp, name);
    mkdirSync(p, { recursive: true });
    return p;
  };

  const seedPane = (db: ReturnType<typeof openDb>, cwd: string, at: number) => {
    db.prepare(
      "INSERT INTO panes (id, tab_id, kind, shell, cwd, created_at) VALUES (?, 't', 'shell', '/bin/zsh', ?, ?)",
    ).run(`p-${at}-${Math.random()}`, cwd, at);
  };

  /** Both source tables want a tab row to hang off; panes has an FK. */
  const seedDb = () => {
    const db = openDb(':memory:');
    db.prepare(
      "INSERT INTO workspaces (id, slug, name, position, created_at, updated_at) VALUES ('w','w','W',0,0,0)",
    ).run();
    db.prepare(
      "INSERT INTO tabs (id, slug, name, layout, workspace_id, position, created_at, updated_at) VALUES ('t','t','T','','w',0,0,0)",
    ).run();
    return db;
  };

  it('is most-recent-first, deduped, and never offers a folder that is gone', () => {
    const db = seedDb();
    const alpha = mkdir('alpha');
    const beta = mkdir('beta');
    const vanished = join(tmp, 'torn-down-worktree');
    seedPane(db, alpha, 100);
    seedPane(db, beta, 300);
    seedPane(db, alpha, 200); // same folder again, newer
    seedPane(db, vanished, 999); // newest, but does not exist
    const got = recentFolders(db).map((f) => f.path);
    // `vanished` is excluded: offering it would spawn into home instead (see
    // safeCwd) and quietly lie about where the session started.
    expect(got).toEqual([beta, alpha]);
  });

  it('prefers the newest timestamp across BOTH sources', () => {
    const db = seedDb();
    const a = mkdir('a');
    const b = mkdir('b');
    seedPane(db, a, 10);
    seedPane(db, b, 20);
    // A session recorded in `a` more recently than any pane row — `a` leads.
    db.prepare(
      "INSERT INTO session_history (sid, pane_id, assistant, cwd, first_seen, last_seen) VALUES ('s1','p','claude',?,?,?)",
    ).run(a, 1, 5000);
    expect(recentFolders(db).map((f) => f.path)).toEqual([a, b]);
  });

  it('snaps a subdirectory to its project root, and dedupes what that collapses', () => {
    const db = seedDb();
    const root = mkdir('repo');
    mkdirSync(join(root, '.git'), { recursive: true });
    const sub = join(root, 'src', 'components');
    mkdirSync(sub, { recursive: true });
    seedPane(db, sub, 100);
    seedPane(db, root, 90);
    const got = recentFolders(db);
    // One chip, naming the folder the session will ACTUALLY start in —
    // otherwise the chip says `components` and the agent lands two levels up.
    expect(got.map((f) => f.path)).toEqual([root]);
    expect(got[0]?.name).toBe('repo');
    expect(got[0]?.hasProject).toBe(true);
  });

  it('collapses two names for the same folder into one chip', () => {
    const db = seedDb();
    const real = mkdir('real');
    const link = join(tmp, 'alias');
    symlinkSync(real, link);
    seedPane(db, real, 10);
    seedPane(db, link, 20);
    expect(recentFolders(db).map((f) => f.path)).toEqual([realpathSync(real)]);
  });

  it('reports hasProject honestly for a bare folder', () => {
    const db = seedDb();
    const bare = mkdir('just-a-folder');
    seedPane(db, bare, 1);
    expect((recentFolders(db)[0] as RecentFolder).hasProject).toBe(false);
  });

  it('caps the list', () => {
    const db = seedDb();
    for (let i = 0; i < 12; i++) seedPane(db, mkdir(`d${i}`), i);
    expect(recentFolders(db)).toHaveLength(6);
    expect(recentFolders(db, 2)).toHaveLength(2);
  });
});

describe('GET /api/agent-launch/options', () => {
  let test: TestApp;
  let db: ReturnType<typeof openDb>;
  let tmp: string;
  beforeEach(async () => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'muxpad-launchopts-')));
    db = openDb(':memory:');
    test = await createTestApp({ db, dataDir: tmp });
  });
  afterEach(async () => {
    await test.cleanup();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('offers nothing it has not actually seen', async () => {
    const res = await test.app.request('/api/agent-launch/options');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { models: Record<string, unknown>; home: string };
    // A backend that never ran here gets NO list — the card then offers only
    // "Default", which is honest. It must never be a guessed catalog.
    expect(body.models).toEqual({});
    expect(body.home).toMatch(/^\//);
  });

  it('serves the model list a backend reported', async () => {
    recordModelCatalog(db, 'codex', [{ value: 'gpt-5-codex', displayName: 'GPT-5 Codex' }]);
    const body = (await (await test.app.request('/api/agent-launch/options')).json()) as {
      models: Record<string, Array<{ value: string }>>;
    };
    expect(body.models.codex?.[0]?.value).toBe('gpt-5-codex');
    expect(body.models.claude).toBeUndefined();
  });

  it('folders carry a name, a ~-path and a project flag', async () => {
    const dir = join(tmp, 'proj');
    mkdirSync(join(dir, '.git'), { recursive: true });
    writeFileSync(join(dir, 'AGENTS.md'), '# x');
    db.prepare(
      "INSERT INTO session_history (sid, pane_id, assistant, cwd, first_seen, last_seen) VALUES ('s','p','claude',?,1,2)",
    ).run(dir);
    const body = (await (await test.app.request('/api/agent-launch/options')).json()) as {
      folders: RecentFolder[];
    };
    expect(body.folders[0]).toMatchObject({ path: dir, name: 'proj', hasProject: true });
    expect(typeof body.folders[0]?.short).toBe('string');
  });
});
