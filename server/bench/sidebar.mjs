/**
 * WHAT THE SIDEBAR COSTS, AGAINST A COPY OF A REAL DATABASE.
 *
 * `GET /api/tabs/all` is polled every five seconds by every open client, and
 * it is the one response whose cost grows with the number of CHATS — the
 * number that only goes up. This measures the pieces it is made of so the
 * next person optimising it starts from numbers instead of a guess.
 *
 *   node bench/sidebar.mjs            # against ~/.muxpad/db.sqlite
 *   node bench/sidebar.mjs path.db    # against any copy
 *
 * It copies the database first: never measure against the live file, and
 * never hold a lock on it.
 */
import { execSync } from 'node:child_process';
import Database from 'better-sqlite3';

const src = process.argv[2] ?? `${process.env.HOME}/.muxpad/db.sqlite`;
const copy = '/tmp/muxpad-bench.sqlite';
execSync(`cp ${JSON.stringify(src)} ${copy}`);
const db = new Database(copy, { readonly: true });

const { TabStore } = await import('../dist/store/TabStore.js');
const { PaneStore } = await import('../dist/store/PaneStore.js');
const { clockSnapshot } = await import('../dist/tab-clock.js');
const { cronsByTab } = await import('../dist/ptyd-cache.js');

const tabs = new TabStore(db);
const panes = new PaneStore(db);
const workspaces = db.prepare('SELECT id FROM workspaces').all();
const counts = {
  tabs: db.prepare('SELECT count(*) c FROM tabs').get().c,
  panes: db.prepare('SELECT count(*) c FROM panes').get().c,
};
console.log(`${workspaces.length} workspaces · ${counts.tabs} tabs · ${counts.panes} panes\n`);

const time = (label, fn, n = 20) => {
  fn();
  const started = process.hrtime.bigint();
  for (let i = 0; i < n; i++) fn();
  const ms = Number(process.hrtime.bigint() - started) / 1e6 / n;
  console.log(`  ${label.padEnd(32)}${ms.toFixed(2)} ms`);
  return ms;
};

console.log('one GET /api/tabs/all, by piece:');
const rows = time('tab rows + mapping', () => {
  for (const w of workspaces) tabs.listByWorkspace(w.id);
});
const batched = time('panes, one query per workspace', () => {
  for (const w of workspaces) panes.byTabForWorkspace(w.id);
});
time('clock snapshot', () => clockSnapshot(db));
time('crons', () => {
  for (const w of workspaces) cronsByTab(db, w.id);
});
time('manual-unread ids', () => {
  for (const w of workspaces) tabs.unreadIdsByWorkspace(w.id);
});

console.log('\nthe N+1 this replaced, for comparison:');
const perTab = time('panes, one query per TAB', () => {
  for (const w of workspaces) for (const t of tabs.listByWorkspace(w.id)) panes.listByTab(t.id);
});
console.log(
  `\n  saved ${(perTab - rows - batched).toFixed(1)} ms per poll ` +
    `(${(((perTab - rows - batched) / (perTab - rows)) * 100).toFixed(0)}% of the panes cost)`,
);
console.log(
  `  per tab: ${(((perTab - rows) / counts.tabs) * 1000).toFixed(1)}µs → ` +
    `${((batched / counts.tabs) * 1000).toFixed(1)}µs`,
);
