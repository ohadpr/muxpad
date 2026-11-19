import type Database from 'better-sqlite3';
import { openDb } from '../store/db.js';

/**
 * An in-memory database for the browser-host tests, on the REAL schema.
 *
 * All three of them used to hand-roll their own `apps`, `globals` and `panes`
 * tables — a minimal subset, which is a reasonable instinct and was wrong
 * twice in one afternoon. `AppStore` writes every column it knows about, so
 * ONE new column (`origin_tab`) failed seventy-four tests across three files
 * with `table apps has no column named origin_tab` — none of which are about
 * the apps schema at all. Positional `INSERT INTO apps VALUES (…)` in the
 * fixtures was the same brittleness one layer down.
 *
 * `openDb(':memory:')` is milliseconds and cannot drift from production by
 * construction: it is literally what the server calls. The cost is that these
 * tests now carry tables they do not use, and that FOREIGN KEYS ARE ENFORCED —
 * so a fixture inserting a pane has to give it a tab to belong to. Both are
 * worth paying to stop one column from being three separate edits and a red
 * suite.
 *
 * (Not that a bare `new Database()` would avoid the keys: better-sqlite3
 * enables `foreign_keys` by default — measured, not assumed. `openDb` states
 * it anyway, and WAL with it.)
 */
export function browserTestDb(): Database.Database {
  return openDb(':memory:');
}
