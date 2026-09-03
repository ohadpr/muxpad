import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TabStore } from '../store/TabStore.js';
import { WorkspaceStore } from '../store/WorkspaceStore.js';
import { openDb } from '../store/db.js';

/**
 * The two persisted facts the sidebar redesign added, exercised against a real
 * migrated database rather than a mock — because both of them exist
 * specifically to survive a restart, and an in-memory double would prove
 * nothing about the property under test.
 */
describe('headline + name_sticky, persisted', () => {
  let dir: string;
  let db: Database.Database;
  let tabs: TabStore;
  let tabId: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'muxpad-headline-'));
    db = openDb(join(dir, 'db.sqlite'));
    const ws = new WorkspaceStore(db).create({ name: 'W' });
    tabs = new TabStore(db);
    tabId = tabs.create({ name: 'agent', workspace_id: ws.id, layout: 'p1' }).id;
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('a fresh tab has neither a headline nor a clock', () => {
    const tab = tabs.getById(tabId);
    expect(tab?.headline).toBeUndefined();
    expect(tabs.headlineAt(tabId)).toBeNull();
  });

  it('an ABSENT headline stays absent — never an empty string', () => {
    // "We have never summarised this" and "we summarised it and got nothing"
    // are different claims, and the rail renders the first as a one-line row.
    const tab = tabs.getById(tabId);
    expect('headline' in (tab ?? {})).toBe(false);
  });

  it('writes the line and its clock in one go', () => {
    tabs.setHeadline(tabId, 'wiring the cron scheduler into boot', 111);
    expect(tabs.getById(tabId)?.headline).toBe('wiring the cron scheduler into boot');
    expect(tabs.headlineAt(tabId)).toBe(111);
  });

  it('does NOT bump updated_at — a headline is not a structural edit', () => {
    // Clients key cache invalidation off updated_at; a background summary
    // must not look like the user renamed the tab.
    const before = tabs.getById(tabId)?.updated_at;
    tabs.setHeadline(tabId, 'a line', Date.now());
    expect(tabs.getById(tabId)?.updated_at).toBe(before);
  });

  it('the clock SURVIVES a reopen — the whole reason it is a column', () => {
    tabs.setHeadline(tabId, 'a line', 999);
    db.close();
    const reopened = openDb(join(dir, 'db.sqlite'));
    const after = new TabStore(reopened);
    expect(after.headlineAt(tabId)).toBe(999);
    expect(after.getById(tabId)?.headline).toBe('a line');
    reopened.close();
    db = openDb(join(dir, 'db.sqlite'));
  });

  it('name_sticky defaults to off and is absent from the row', () => {
    expect(tabs.isNameSticky(tabId)).toBe(false);
    expect(tabs.getById(tabId)?.name_sticky).toBeUndefined();
  });

  it('name_sticky is one-way and survives a reopen', () => {
    // This is the bug the persisted flag replaces: the old in-memory map
    // forgot who had named what on every restart, so a manual name was
    // protected only by the accident of not matching a sentinel.
    tabs.setNameSticky(tabId);
    expect(tabs.isNameSticky(tabId)).toBe(true);
    db.close();
    const reopened = openDb(join(dir, 'db.sqlite'));
    expect(new TabStore(reopened).isNameSticky(tabId)).toBe(true);
    reopened.close();
    db = openDb(join(dir, 'db.sqlite'));
  });

  it('renaming a sticky tab does not un-stick it', () => {
    tabs.setNameSticky(tabId);
    tabs.update(tabId, { name: 'Investing' });
    expect(tabs.isNameSticky(tabId)).toBe(true);
    expect(tabs.getById(tabId)?.name_sticky).toBe(true);
  });

  it('a headline write leaves the name and its stickiness alone', () => {
    tabs.update(tabId, { name: 'Investing' });
    tabs.setNameSticky(tabId);
    tabs.setHeadline(tabId, 'sell the SMH overweight or hold?', 1);
    const tab = tabs.getById(tabId);
    expect(tab?.name).toBe('Investing');
    expect(tab?.name_sticky).toBe(true);
    expect(tab?.headline).toBe('sell the SMH overweight or hold?');
  });
});
