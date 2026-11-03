import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WORKING_SET_DECAY_MS, WORKING_SET_SIZE } from '@muxpad/shared';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TabStore } from './store/TabStore.js';
import { WorkspaceStore } from './store/WorkspaceStore.js';
import { openDb } from './store/db.js';
import { WorkingSet } from './working-set.js';

let dir: string;
let db: Database.Database;
let ws: string;
let now = 1_700_000_000_000;

const chat = (name: string, parent?: string) =>
  new TabStore(db).create({
    name,
    layout: '',
    workspace_id: ws,
    ...(parent ? { spawned_by: parent } : {}),
  }).id;

const set = () => new WorkingSet(db, () => now);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'muxpad-ws-'));
  db = openDb(join(dir, 'db.sqlite'));
  ws = new WorkspaceStore(db).create({ name: 'W' }).id;
  now = 1_700_000_000_000;
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('the strip, persisted', () => {
  it('survives a restart — a working set that empties on a bounce is not one', () => {
    const a = chat('a');
    set().touch(a);
    // A whole new instance, reading the same database.
    expect(new WorkingSet(db, () => now).list().map((s) => s.tabId)).toEqual([a]);
  });

  it('reports whether the SHAPE changed, which is what gets announced', () => {
    const a = chat('a');
    expect(set().touch(a)).toBe(true); // entered
    expect(set().touch(a)).toBe(false); // same slot, newer stamp
    expect(set().touch(chat('b'))).toBe(true); // entered
  });

  it('drops a slot whose chat no longer exists', () => {
    // A slot is a place to GO. One pointing nowhere is worse than an empty
    // one, and a chat can be deleted while it holds a slot.
    const a = chat('a');
    const b = chat('b');
    set().touch(a);
    set().touch(b);
    db.prepare('DELETE FROM tabs WHERE id = ?').run(a);
    expect(
      set()
        .list()
        .map((s) => s.tabId),
    ).toEqual([b]);
  });

  it('a stale slot KEEPS ITS PLACE — decay chooses who is replaced', () => {
    // It used to be dropped on read, and the array closed up, so every slot
    // after it moved. As tabs that is the one unforgivable move. A stale slot
    // now waits to be TAKEN: it holds its position, and it is the first one a
    // new chat spends once the strip is full.
    const ids: string[] = [];
    for (let i = 0; i < WORKING_SET_SIZE; i++) {
      const id = chat(`t${i}`);
      ids.push(id);
      now += 60_000;
      set().touch(id);
    }
    // Everything but t2 gets a fresh message, so t2 is the only stale slot —
    // and it is NOT the least recently used, so this can only pass if
    // staleness is what picked the victim.
    now += WORKING_SET_DECAY_MS + 60_000;
    for (const [i, id] of ids.entries()) if (i !== 2) set().touch(id);
    expect(set().list()).toHaveLength(WORKING_SET_SIZE);

    const fresh = chat('fresh');
    set().touch(fresh);
    const after = set()
      .list()
      .map((s) => s.tabId);
    expect(after).toHaveLength(WORKING_SET_SIZE);
    expect(after[2]).toBe(fresh); // took the stale slot, in place
    expect(after.filter((_, i) => i !== 2)).toEqual(ids.filter((_, i) => i !== 2));
  });

  it('“not now” frees the slot and leaves the chat alone', () => {
    const a = chat('a');
    set().touch(a);
    expect(set().remove(a)).toBe(true);
    expect(set().list()).toHaveLength(0);
    // The chat itself is untouched — not archived, not retired.
    const row = db.prepare('SELECT retired_at AS r FROM tabs WHERE id = ?').get(a) as
      | { r: number | null }
      | undefined;
    expect(row?.r ?? null).toBeNull();
    expect(set().remove(a)).toBe(false); // already gone
  });

  it('holds the cap and evicts the least recently used', () => {
    const ids: string[] = [];
    for (let i = 0; i < WORKING_SET_SIZE; i++) {
      const id = chat(`t${i}`);
      ids.push(id);
      now += 60_000;
      set().touch(id);
    }
    now += 60_000;
    const extra = chat('extra');
    set().touch(extra);
    const after = set()
      .list()
      .map((s) => s.tabId);
    expect(after).toHaveLength(WORKING_SET_SIZE);
    expect(after).not.toContain(ids[0]); // the oldest went
    expect(after[0]).toBe(extra); // …and the newcomer took its slot
    expect(after.slice(1)).toEqual(ids.slice(1)); // nothing else moved
  });
});
