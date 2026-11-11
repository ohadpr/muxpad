import assert from 'node:assert/strict';
import { test } from 'node:test';
import { filtersOf, plan, verdict } from './vitest-run.mjs';

test('the pnpm separator and a stray --run do not swallow the filter', () => {
  assert.deepEqual(plan(['--phase=--passWithNoTests', '--', '--run', 'ChatPane.working']), [
    ['run', '--passWithNoTests', 'ChatPane.working'],
  ]);
});

test('every phase gets the filter, and tolerates matching nothing', () => {
  assert.deepEqual(
    plan([
      '--phase=--project unit',
      '--phase=--project serial --no-file-parallelism',
      '--',
      'rebase-run',
    ]),
    [
      ['run', '--project', 'unit', '--passWithNoTests', 'rebase-run'],
      ['run', '--project', 'serial', '--no-file-parallelism', '--passWithNoTests', 'rebase-run'],
    ],
  );
});

test('no filter: the full run is unchanged', () => {
  assert.deepEqual(plan(['--phase=--project unit']), [['run', '--project', 'unit']]);
});

test('a filter that matched in one phase and not the other passes', () => {
  const r = verdict(
    ['rebase-run'],
    [
      { status: 0, empty: false },
      { status: 0, empty: true },
    ],
  );
  assert.equal(r.code, 0);
});

test('a filter that matched in NO phase fails, naming the filter', () => {
  const r = verdict(
    ['ChtPaneTypo'],
    [
      { status: 0, empty: true },
      { status: 0, empty: true },
    ],
  );
  assert.equal(r.code, 1);
  assert.match(r.message, /no test file matched "ChtPaneTypo"/);
});

test('a failing phase keeps its own exit code', () => {
  assert.equal(verdict(['x'], [{ status: 2, empty: false }]).code, 2);
});

test('an unfiltered run is never judged empty here: vitest decides', () => {
  assert.equal(verdict([], [{ status: 0, empty: true }]).code, 0);
});

test('filtersOf keeps positionals only', () => {
  assert.deepEqual(filtersOf(['rebase-run', '--reporter=dot', 'ChatPane']), [
    'rebase-run',
    'ChatPane',
  ]);
});
