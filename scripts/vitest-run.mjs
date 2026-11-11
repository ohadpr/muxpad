#!/usr/bin/env node
/**
 * `vitest run`, with the filters you typed actually reaching vitest.
 *
 * pnpm 10 forwards a literal `--` to the script, and vitest treats everything
 * after a `--` as not-a-filter. So `pnpm --filter web test -- --run X` ran all
 * 215 web files (~35s) instead of one (~1s), and `pnpm --filter server test
 * -- --run X` ran the whole unit project and then the whole serial project
 * (6+ minutes) — the filter only ever reached the second half, and was
 * dropped there too. Measured on 2026-11-11: eleven such runs, ~13 minutes.
 *
 * Usage (from a package.json script):
 *   node ../scripts/vitest-run.mjs --phase="--project unit" --phase="--project serial --no-file-parallelism"
 * Every phase runs in order with the same user filters; the first failure
 * stops the run. With a filter, a phase that matches nothing passes, so
 * `test rebase-run` does not fail just because no serial file matches.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function plan(argv) {
  const phases = [];
  const user = [];
  for (const a of argv) {
    if (a.startsWith('--phase=')) phases.push(a.slice(8).split(' ').filter(Boolean));
    // `--` is pnpm's separator and `run` is already ours: both are noise here.
    else if (a !== '--' && a !== '--run') user.push(a);
  }
  if (phases.length === 0) phases.push([]);
  const filtered = user.some((a) => !a.startsWith('-'));
  return phases.map((p) => {
    const lenient = filtered && !p.includes('--passWithNoTests') ? ['--passWithNoTests'] : [];
    return ['run', ...p, ...lenient, ...user];
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const args of plan(process.argv.slice(2))) {
    const r = spawnSync('vitest', args, { stdio: 'inherit' });
    if (r.status !== 0) process.exit(r.status ?? 1);
  }
}
