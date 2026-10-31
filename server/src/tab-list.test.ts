import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * THE SIDEBAR READS PANES ONCE PER WORKSPACE, NOT ONCE PER TAB.
 *
 * `GET /api/tabs/all` is polled every five seconds by every open client, and
 * `decorateTab` needs a tab's panes to roll up its status, its attention and
 * its live subagent count. It used to fetch them one tab at a time: measured
 * on a 690-tab database, 35µs per tab — 24ms of the ~31ms the whole list
 * cost, and the only part of it that grows with the number of CHATS rather
 * than the number of workspaces.
 *
 * Batched: 7.2µs per tab. `server/bench/sidebar.mjs` is the measurement.
 */
describe('the list path makes one panes query per workspace', () => {
  it('asks the store for the whole workspace, never per tab', () => {
    const src = readFileSync(join(__dirname, 'tab-list.ts'), 'utf8');
    expect(src).toMatch(/byTabForWorkspace\(workspaceId\)/);
    expect(src).not.toMatch(/listByTab\(/);
  });

  it('hands that map to decorateTab, which prefers it over a lookup', () => {
    const src = readFileSync(join(__dirname, 'tab-list.ts'), 'utf8');
    expect(src).toMatch(/decorateTab\([^)]*panesByTab/s);
    const decorate = readFileSync(join(__dirname, 'ptyd-cache.ts'), 'utf8');
    // The map is authoritative when given: a tab with no panes is ABSENT from
    // it, and that is an empty list rather than a cache miss to fall back on.
    expect(decorate).toMatch(/panesByTabId\s*\?\s*\(panesByTabId\.get\(tab\.id\) \?\? \[\]\)/);
  });

  it('groups by tab in the query’s own order', () => {
    // `ORDER BY p.tab_id, p.created_at` — the per-tab lists come out in the
    // same order `listByTab` produced, so nothing downstream can tell the
    // difference between the two reads.
    const store = readFileSync(join(__dirname, 'store', 'PaneStore.ts'), 'utf8');
    expect(store).toMatch(/ORDER BY p\.tab_id, p\.created_at/);
  });
});
