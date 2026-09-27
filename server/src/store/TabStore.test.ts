import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { TabStore } from './TabStore.js';
import { WorkspaceStore } from './WorkspaceStore.js';
import { runMigrations } from './migrations.js';

describe('TabStore', () => {
  let store: TabStore;
  let workspaceId: string;

  beforeEach(() => {
    const db = new Database(':memory:');
    runMigrations(db);
    store = new TabStore(db);
    const workspaces = new WorkspaceStore(db);
    workspaceId = workspaces.create({ name: 'W' }).id;
  });

  it('creates and retrieves a workspace', () => {
    const w = store.create({ name: 'Dev', layout: 'pane-1', workspace_id: workspaceId });
    expect(w.slug).toMatch(/^[A-Za-z2-9]{8}$/);
    expect(store.getById(w.id)).toEqual(w);
    expect(store.getBySlug(w.slug)).toEqual(w);
  });

  it('generates unique slugs across many workspaces', () => {
    const slugs = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const w = store.create({ name: `n${i}`, layout: 'p', workspace_id: workspaceId });
      slugs.add(w.slug);
    }
    expect(slugs.size).toBe(50);
  });

  it('lists workspaces sorted by position', () => {
    const a = store.create({ name: 'A', layout: 'pa', workspace_id: workspaceId });
    const b = store.create({ name: 'B', layout: 'pb', workspace_id: workspaceId });
    const list = store.list();
    // Insertion order = position order (a got 0, b got 1).
    expect(list.map((w) => w.id)).toEqual([a.id, b.id]);
  });

  it('reorders workspaces', () => {
    const a = store.create({ name: 'A', layout: 'pa', workspace_id: workspaceId });
    const b = store.create({ name: 'B', layout: 'pb', workspace_id: workspaceId });
    const c = store.create({ name: 'C', layout: 'pc', workspace_id: workspaceId });
    store.reorder([c.id, a.id, b.id]);
    expect(store.list().map((w) => w.id)).toEqual([c.id, a.id, b.id]);
  });

  it('updates layout and bumps updated_at', async () => {
    const w = store.create({ name: 'Dev', layout: 'pane-1', workspace_id: workspaceId });
    await new Promise((r) => setTimeout(r, 5));
    const updated = store.update(w.id, {
      layout: { direction: 'row', first: 'a', second: 'b' },
    });
    expect(updated.updated_at).toBeGreaterThan(w.updated_at);
    expect(updated.layout).toEqual({ direction: 'row', first: 'a', second: 'b' });
  });

  it('rejects update for missing workspace', () => {
    expect(() => store.update('nope', { name: 'x' })).toThrow();
  });

  it('deletes a workspace', () => {
    const w = store.create({ name: 'Dev', layout: 'pane-1', workspace_id: workspaceId });
    store.delete(w.id);
    expect(store.getById(w.id)).toBeNull();
  });

  it('returns workspace_id for a known tab', () => {
    const w = store.create({ name: 'X', layout: 'p', workspace_id: workspaceId });
    expect(store.getWorkspaceId(w.id)).toBe(workspaceId);
  });

  it('returns undefined for an unknown tab id', () => {
    expect(store.getWorkspaceId('does-not-exist')).toBeUndefined();
  });

  it('defaults view_mode to tabbed and persists a split flip without touching layout', () => {
    // New tabs are tabbed-first (one full-size pane; bsplit is the opt-in).
    const w = store.create({ name: 'Dev', layout: 'pane-1', workspace_id: workspaceId });
    expect(w.view_mode).toBe('tabbed');
    expect(store.getById(w.id)?.view_mode).toBe('tabbed');
    const flipped = store.update(w.id, { view_mode: 'split' });
    expect(flipped.view_mode).toBe('split');
    expect(store.getById(w.id)?.view_mode).toBe('split');
    // The split tree must survive the flip so switching back restores it.
    expect(store.getById(w.id)?.layout).toEqual('pane-1');
    // Unrelated updates don't reset the mode.
    store.update(w.id, { name: 'Dev2' });
    expect(store.getById(w.id)?.view_mode).toBe('split');
  });

  it('round-trips deeply nested layout JSON', () => {
    const layout = {
      direction: 'row' as const,
      splitPercentage: 40,
      first: { direction: 'column' as const, first: 'a', second: 'b' },
      second: 'c',
    };
    const w = store.create({ name: 'X', layout, workspace_id: workspaceId });
    expect(store.getById(w.id)?.layout).toEqual(layout);
  });

  it('is born with a full clock and no parent', () => {
    const before = Date.now();
    const w = store.create({ name: 'Dev', layout: 'p', workspace_id: workspaceId });
    const row = store.clockRows().find((r) => r.id === w.id);
    expect(row?.clock_started_at).toBeGreaterThanOrEqual(before);
    expect(row?.spawned_by).toBeNull();
    // Absent, not null, on the wire — a chat with no parent should not widen
    // every payload (nor the client's change-dedup signature).
    expect('spawned_by' in (store.getById(w.id) as object)).toBe(false);
  });

  it('records and surfaces the chat it was spawned from', () => {
    const parent = store.create({ name: 'P', layout: 'p', workspace_id: workspaceId });
    const child = store.create({
      name: 'C',
      layout: 'c',
      workspace_id: workspaceId,
      spawned_by: parent.id,
    });
    expect(child.spawned_by).toBe(parent.id);
    expect(store.getById(child.id)?.spawned_by).toBe(parent.id);
    expect(store.clockRows().find((r) => r.id === child.id)?.spawned_by).toBe(parent.id);
  });

  it('a child is stamped with its own clock too, as an orphan fallback', () => {
    // It is ignored while the parent exists (the resolver reads the root's),
    // but a parent deleted later must leave a real timestamp behind rather
    // than a null nothing can interpret.
    const parent = store.create({ name: 'P', layout: 'p', workspace_id: workspaceId });
    const child = store.create({
      name: 'C',
      layout: 'c',
      workspace_id: workspaceId,
      spawned_by: parent.id,
    });
    expect(store.clockRows().find((r) => r.id === child.id)?.clock_started_at).toBeGreaterThan(0);
  });

  it('resetClock moves the clock without bumping updated_at', () => {
    // `updated_at` tracks structural edits and clients key cache invalidation
    // off it — same contract as touchActivity.
    const w = store.create({ name: 'Dev', layout: 'p', workspace_id: workspaceId });
    const at = Date.now() + 10_000;
    store.resetClock(w.id, at);
    expect(store.clockRows().find((r) => r.id === w.id)?.clock_started_at).toBe(at);
    expect(store.getById(w.id)?.updated_at).toBe(w.updated_at);
  });

  it('clockRows reports pinning as a boolean', () => {
    const w = store.create({ name: 'Dev', layout: 'p', workspace_id: workspaceId });
    expect(store.clockRows().find((r) => r.id === w.id)?.pinned).toBe(false);
    store.setPinned(w.id, true);
    expect(store.clockRows().find((r) => r.id === w.id)?.pinned).toBe(true);
  });
  it('setSpawnReport publishes the report on the row, without a structural edit', () => {
    // Same split as setHeadline: `updated_at` is what clients key cache
    // invalidation off, and a report landing is not an edit to the tab.
    const w = store.create({ name: 'Work review', layout: 'p', workspace_id: workspaceId });
    store.setSpawnReport(w.id, { report: 'Counted 41 todos across 6 files.', state: 'ok' }, 5_000);
    const row = store.getById(w.id);
    expect(row?.spawn_report).toBe('Counted 41 todos across 6 files.');
    expect(row?.spawn_report_state).toBe('ok');
    expect(row?.spawn_report_at).toBe(5_000);
    expect(row?.updated_at).toBe(w.updated_at);
  });

  it('carries a stateful report with NO text — "nothing to report" is an answer', () => {
    // The state and the text are independent: `none` and `crashed` are both
    // meaningful with a NULL body, and conflating them with "we failed to
    // summarise" (state NULL) is the thing the column exists to prevent.
    const w = store.create({ name: 'Work review', layout: 'p', workspace_id: workspaceId });
    store.setSpawnReport(w.id, { report: null, state: 'none' }, 5_000);
    const row = store.getById(w.id);
    expect(row?.spawn_report ?? null).toBeNull();
    expect(row?.spawn_report_state).toBe('none');
  });

  it('touchSpawnReportAt advances the attempt clock and writes nothing else', () => {
    // A FAILURE IS AN ATTEMPT — headline.ts's hardest-won rule. Without this a
    // broken install (no login, an SDK import error) spawns a subprocess per
    // retirement forever.
    const w = store.create({ name: 'Work review', layout: 'p', workspace_id: workspaceId });
    expect(store.spawnReportAt(w.id)).toBeNull();
    store.touchSpawnReportAt(w.id, 9_000);
    expect(store.spawnReportAt(w.id)).toBe(9_000);
    expect(store.getById(w.id)?.spawn_report ?? null).toBeNull();
    expect(store.getById(w.id)?.spawn_report_state).toBeUndefined();
  });

  it('omits the report fields entirely from a row that has none', () => {
    // Absent, not null: every tab in the sidebar carries this row on every
    // poll, and three null fields per row is three fields of payload — and
    // three more inputs to the client's change-dedup signature — for a state
    // that is permanent for every chat nobody spawned.
    const w = store.create({ name: 'Dev', layout: 'p', workspace_id: workspaceId });
    const row = store.getById(w.id) as Record<string, unknown>;
    expect('spawn_report' in row).toBe(false);
    expect('spawn_report_at' in row).toBe(false);
    expect('spawn_report_state' in row).toBe(false);
  });
});
