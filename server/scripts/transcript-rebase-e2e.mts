/**
 * Run the REAL transcriptRebase — chokepoint, plan, model-written briefing,
 * integrity check, atomic write — against a real session, with a throwaway
 * in-memory database standing in for the server's.
 *
 *   pnpm --dir server exec tsx scripts/transcript-rebase-e2e.mts <sid> [--budget=N]
 *
 * Prints the result. On success the new transcript sits next to the old one;
 * try it with `claude --resume <new sid>` from the session's cwd. Nothing in
 * the live muxpad database is read or written, and the source file is never
 * modified.
 */
import Database from 'better-sqlite3';
import { transcriptRebase } from '../src/chat/transcript-rebase.js';
import { AgentSessionStore } from '../src/store/AgentSessionStore.js';
import { PaneStore } from '../src/store/PaneStore.js';
import { TabStore } from '../src/store/TabStore.js';
import { WorkspaceStore } from '../src/store/WorkspaceStore.js';
import { runMigrations } from '../src/store/migrations.js';

const sid = process.argv[2];
if (!sid) {
  console.error('usage: transcript-rebase-e2e.mts <sid> [--budget=N]');
  process.exit(2);
}
const budget = process.argv.find((a) => a.startsWith('--budget='))?.slice(9);

const db = new Database(':memory:');
runMigrations(db);
const ws = new WorkspaceStore(db).create({ name: 'e2e' });
const tab = new TabStore(db).create({ workspace_id: ws.id, name: 'e2e', layout: 'p' });
const pane = new PaneStore(db).create({
  tab_id: tab.id,
  kind: 'shell',
  startup_cmd: `muxpad agent --resume ${sid}`,
});
new AgentSessionStore(db).register({ pane_id: pane.id, assistant: 'claude', session_id: sid });

const t0 = Date.now();
const r = await transcriptRebase(db, pane.id, budget ? { budgetTokens: Number(budget) } : {});
console.log(JSON.stringify({ ...r, ms: Date.now() - t0 }, null, 2));
process.exit(r.ok ? 0 : 1);
