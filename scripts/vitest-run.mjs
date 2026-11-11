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
 * `test rebase-run` does not fail just because no serial file matches — but
 * the RUN fails when no phase matched anything. Leniency per phase, not per
 * run: otherwise `test ChtPaneTypo` would exit 0 having run zero tests, which
 * is the same lie as the one this file exists to remove.
 */
import { spawn } from 'node:child_process';
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

/** The filters the user typed: the positional args left after plan() strips the noise. */
export function filtersOf(argv) {
  return argv.filter((a) => !a.startsWith('-'));
}

/**
 * The run's exit code. `results` holds one `{ status, empty }` per phase that
 * ran; `empty` is vitest's own "No test files found". A failing phase wins; then
 * a filtered run in which EVERY phase was empty fails, naming the filter.
 */
export function verdict(filters, results) {
  const failed = results.find((r) => r.status !== 0);
  if (failed) return { code: failed.status ?? 1 };
  if (filters.length > 0 && results.length > 0 && results.every((r) => r.empty)) {
    return { code: 1, message: `no test file matched ${filters.map((f) => `"${f}"`).join(' ')}` };
  }
  return { code: 0 };
}

const NO_FILES = /No test files found/;

/** Run one phase, streaming its output through while watching it for NO_FILES. */
function runPhase(args) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    // Piping costs vitest its colours; give them back when a person is watching.
    if (process.stdout.isTTY && env.FORCE_COLOR === undefined) env.FORCE_COLOR = '1';
    const child = spawn('vitest', args, { stdio: ['inherit', 'pipe', 'pipe'], env });
    let empty = false;
    // Keep a short tail so a match split across two chunks is still seen.
    const watch = (out) => {
      let tail = '';
      return (chunk) => {
        out.write(chunk);
        tail = (tail + chunk.toString()).slice(-200);
        if (NO_FILES.test(tail)) empty = true;
      };
    };
    child.stdout.on('data', watch(process.stdout));
    child.stderr.on('data', watch(process.stderr));
    child.on('error', (err) => {
      process.stderr.write(`vitest-run: ${err.message}\n`);
      resolve({ status: 127, empty });
    });
    child.on('close', (status, signal) => resolve({ status: signal ? 1 : status, empty }));
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const runs = plan(argv);
  const filters = filtersOf(
    argv.filter((a) => !a.startsWith('--phase=') && a !== '--' && a !== '--run'),
  );
  const results = [];
  for (const args of runs) {
    const r = await runPhase(args);
    results.push(r);
    if (r.status !== 0) break;
  }
  const v = verdict(filters, results);
  if (v.message) process.stderr.write(`\nvitest-run: ${v.message} — nothing was tested\n`);
  process.exit(v.code);
}
