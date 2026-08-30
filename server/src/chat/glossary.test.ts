import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../store/db.js';
import {
  MAX_GLOSSARY_TERMS,
  STATIC_GLOSSARY,
  buildGlossary,
  dedupeTerms,
  glossaryCache,
  isUsefulTerm,
  liveNames,
} from './glossary.js';

describe('isUsefulTerm', () => {
  it('keeps real names', () => {
    for (const t of ['muxpad', 'Trayo', 'ohados', 'agent-orchestration', 'GTM']) {
      expect(isUsefulTerm(t)).toBe(true);
    }
  });

  it('drops the shapes that are noise, not vocabulary', () => {
    // Too short / no letters / hex ids / oversized / wrong type.
    expect(isUsefulTerm('a')).toBe(false);
    expect(isUsefulTerm('42')).toBe(false);
    expect(isUsefulTerm('----')).toBe(false);
    expect(isUsefulTerm('deadbeefcafe01')).toBe(false);
    expect(isUsefulTerm('x'.repeat(41))).toBe(false);
    expect(isUsefulTerm(null)).toBe(false);
    expect(isUsefulTerm(undefined)).toBe(false);
    expect(isUsefulTerm(7)).toBe(false);
  });
});

describe('dedupeTerms', () => {
  it('is case-insensitive and keeps the first spelling', () => {
    expect(dedupeTerms(['muxpad', 'MUXPAD', 'Muxpad'])).toEqual(['muxpad']);
  });

  it('trims and honours the cap', () => {
    expect(dedupeTerms([' pane ', 'tab'])).toEqual(['pane', 'tab']);
    expect(dedupeTerms(['a1', 'b2', 'c3', 'd4'], 2)).toEqual(['a1', 'b2']);
  });
});

describe('buildGlossary', () => {
  let db: Database.Database;
  let dataDir: string;
  let seq = 0;

  beforeEach(() => {
    db = openDb(':memory:');
    dataDir = mkdtempSync(join(tmpdir(), 'glossary-'));
    seq = 0;
  });
  afterEach(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  // Raw inserts rather than the stores: this exercises the exact columns the
  // glossary SELECTs read, and doesn't drift when a store's create() signature
  // changes underneath it.
  const addWorkspace = (name: string) => {
    const id = `ws${seq++}`;
    db.prepare(
      'INSERT INTO workspaces (id, slug, name, position, created_at, updated_at) VALUES (?,?,?,0,0,?)',
    ).run(id, id, name, seq);
    return id;
  };
  const addTab = (workspaceId: string, name: string) => {
    const id = `tab${seq++}`;
    db.prepare(
      'INSERT INTO tabs (id, slug, name, layout, workspace_id, position, created_at, updated_at) VALUES (?,?,?,?,?,0,0,?)',
    ).run(id, id, name, id, workspaceId, seq);
    return id;
  };
  const addPane = (tabId: string, name: string | null, cwd: string | null) => {
    const id = `pane${seq++}`;
    db.prepare(
      'INSERT INTO panes (id, tab_id, kind, cwd, name, created_at) VALUES (?,?,?,?,?,?)',
    ).run(id, tabId, 'shell', cwd, name, seq);
    return id;
  };
  const seed = () => {
    const ws = addWorkspace('Trayo GTM');
    return { ws, tab: addTab(ws, 'artifact lifecycle') };
  };

  it('always contains the static muxpad vocabulary', () => {
    const terms = buildGlossary(db, dataDir);
    for (const t of STATIC_GLOSSARY) expect(terms).toContain(t);
  });

  it('picks up live workspace, tab and pane names', () => {
    const { tab } = seed();
    addPane(tab, 'ohados', '/Users/me/dev/2026/muxpad');
    const terms = buildGlossary(db, dataDir);
    expect(terms).toContain('Trayo GTM');
    expect(terms).toContain('artifact lifecycle');
    expect(terms).toContain('ohados');
  });

  it('picks up app slugs and names', () => {
    db.prepare(
      'INSERT INTO apps (id, slug, name, cwd, command, url, created_at, updated_at) VALUES (?,?,?,?,?,?,0,1)',
    ).run('a1', 'signalscout', 'Signal Scout', '/Users/me/dev/signalscout', 'pnpm dev', 'http://x');
    const terms = buildGlossary(db, dataDir);
    expect(terms).toContain('signalscout');
    expect(terms).toContain('Signal Scout');
  });

  it('reduces a pane cwd to its repo basename, not the whole path', () => {
    const { tab } = seed();
    addPane(tab, null, '/Users/me/dev/2026/some-repo/');
    const terms = buildGlossary(db, dataDir);
    expect(terms).toContain('some-repo');
    expect(terms.some((t) => t.includes('/'))).toBe(false);
  });

  it('picks up published artifact slugs and collapses version dirs', () => {
    mkdirSync(join(dataDir, 'public', 'roadmap'), { recursive: true });
    mkdirSync(join(dataDir, 'public', 'roadmap@2'), { recursive: true });
    // A file in public/ is not an artifact directory.
    writeFileSync(join(dataDir, 'public', 'index.html'), '<!doctype html>');
    const terms = buildGlossary(db, dataDir);
    expect(terms.filter((t) => t === 'roadmap')).toHaveLength(1);
    expect(terms).not.toContain('index.html');
  });

  it('survives a missing dataDir/public rather than throwing', () => {
    expect(() => buildGlossary(db, join(dataDir, 'nope'))).not.toThrow();
  });

  it('stays bounded, and keeps the static terms, when live names overflow', () => {
    const { tab } = seed();
    for (let i = 0; i < MAX_GLOSSARY_TERMS * 2; i++) addPane(tab, `pane-name-${i}`, '/tmp');
    const terms = buildGlossary(db, dataDir);
    expect(terms.length).toBeLessThanOrEqual(MAX_GLOSSARY_TERMS);
    expect(terms.slice(0, STATIC_GLOSSARY.length)).toEqual([...STATIC_GLOSSARY]);
  });

  it('does not let a wall of pane names crowd out the other sources', () => {
    // Concatenating source-by-source meant an install with hundreds of panes
    // spent the whole live-name budget on pane names, and the app slug /
    // artifact slug / repo basename — the terms most worth teaching — never
    // reached the prompt at all.
    const { tab } = seed();
    for (let i = 0; i < MAX_GLOSSARY_TERMS * 2; i++) addPane(tab, `pane-name-${i}`, '/tmp');
    db.prepare(
      'INSERT INTO apps (id, slug, name, cwd, command, url, created_at, updated_at) VALUES (?,?,?,?,?,?,0,1)',
    ).run('a1', 'signalscout', 'Signal Scout', '/Users/me/dev/interesting-repo', 'x', 'http://x');
    mkdirSync(join(dataDir, 'public', 'roadmap'), { recursive: true });

    const terms = buildGlossary(db, dataDir);
    expect(terms).toContain('signalscout');
    expect(terms).toContain('roadmap');
    expect(terms).toContain('interesting-repo');
  });

  it('tolerates a table that is not there', () => {
    const bare = openDb(':memory:');
    bare.exec('DROP TABLE apps');
    expect(() => liveNames(bare, dataDir)).not.toThrow();
    bare.close();
  });
});

describe('glossaryCache', () => {
  it('rebuilds only after the TTL elapses', () => {
    const db = openDb(':memory:');
    const dataDir = mkdtempSync(join(tmpdir(), 'glossary-ttl-'));
    let now = 1_000;
    const get = glossaryCache(db, dataDir, { ttlMs: 100, now: () => now });
    const add = (id: string, name: string) =>
      db
        .prepare(
          'INSERT INTO workspaces (id, slug, name, position, created_at, updated_at) VALUES (?,?,?,0,0,0)',
        )
        .run(id, id, name);

    add('w1', 'Alpha');
    expect(get()).toContain('Alpha');

    add('w2', 'Beta');
    // Same tick — still the cached build.
    expect(get()).not.toContain('Beta');

    now += 100;
    expect(get()).toContain('Beta');

    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
});
