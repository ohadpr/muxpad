import assert from 'node:assert/strict';
import { test } from 'node:test';
import { plan } from './vitest-run.mjs';

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
