/**
 * Out-of-process re-clone pass, for running against a LIVE muxpad whose
 * server predates the in-archiver pass (Archiver.reclonePassNow), without a
 * restart. Same routine (Reclone.ts), same checks.
 *
 *   tsx src/archive/reclone-cli.ts --data-dir=~/.muxpad [--only=paths.txt]
 *     [--limit=N] [--settle-hours=24] [--mbps=64] [--log=file.jsonl]
 *
 * archive.sqlite is opened READ-ONLY: this writes no ledger rows (the live
 * archiver owns the ledger; its own first pass re-verifies and records
 * cloned_offset). `--only` takes a file of archive-relative paths, one per
 * line, to skip files already known to share blocks.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { ByteThrottle, type RecloneTarget, reclonePass } from './Reclone.js';

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, '').split('=');
    return [k as string, v.join('=')];
  }),
);
const dataDir = (args.get('data-dir') || join(homedir(), '.muxpad')).replace(/^~/, homedir());
const limit = Number(args.get('limit') || Number.POSITIVE_INFINITY);
const settleMs = Number(args.get('settle-hours') || 24) * 3600_000;
const mbps = Number(args.get('mbps') || 64);
const logPath = args.get('log') || join(dataDir, 'archive-reclone.log');
const only = args.get('only')
  ? new Set(
      readFileSync(args.get('only') as string, 'utf8')
        .split('\n')
        .filter(Boolean),
    )
  : null;

const db = new Database(join(dataDir, 'archive.sqlite'), { readonly: true, fileMustExist: true });
const rows = db
  .prepare('SELECT source_path, archived_path, "offset" FROM archive_files WHERE "offset" > 0')
  .all() as { source_path: string; archived_path: string; offset: number }[];
db.close();

const targets: RecloneTarget[] = rows
  .filter((r) => !only || only.has(r.archived_path))
  .slice(0, limit)
  .map((r) => ({
    sourcePath: r.source_path,
    archivedAbs: join(dataDir, 'archive', r.archived_path),
    offset: r.offset,
  }));

const log = (o: object) => appendFileSync(logPath, `${JSON.stringify(o)}\n`);
log({ ts: Date.now(), start: true, targets: targets.length, settleMs, mbps });
const tally = await reclonePass(targets, {
  settleMs,
  throttle: new ByteThrottle(mbps * 1024 * 1024),
  onResult: (t, r) => log({ ts: Date.now(), path: t.archivedAbs, offset: t.offset, ...r }),
});
log({ ts: Date.now(), done: true, byOutcome: tally.byOutcome });
console.log(JSON.stringify({ targets: targets.length, byOutcome: tally.byOutcome }, null, 2));
