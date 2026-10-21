import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { maintenanceHistory } from './maintenance-history.mjs';
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'muxpad-maintenance-')),
    history = join(root, 'history'),
    active = join(root, 'active'),
    id = 'a'.repeat(64);
  mkdirSync(history);
  mkdirSync(join(history, id));
  writeFileSync(active, JSON.stringify({ version: 1, release: id }));
  return { history, active, id };
}
test('actual filesystem guard permits completed update but blocks every unfinished phase and plan without journal', () => {
  for (const phase of ['prepared', 'stopping', 'installing', 'starting', 'ready']) {
    const f = fixture();
    writeFileSync(
      join(f.history, f.id, 'journal.json'),
      JSON.stringify({ release: f.id, phase, stateMayHaveChanged: true }),
    );
    if (phase === 'ready')
      assert.doesNotThrow(() => maintenanceHistory(f.history, f.active, () => {}));
    else assert.throws(() => maintenanceHistory(f.history, f.active, () => {}));
  }
  const f = fixture();
  writeFileSync(join(f.history, f.id, 'plan.json'), '{}');
  assert.throws(() => maintenanceHistory(f.history, f.active, () => {}));
});
test('fresh installations have no history; orphaned pointers refuse maintenance', () => {
  const d = mkdtempSync(join(tmpdir(), 'muxpad-empty-history-'));
  assert.doesNotThrow(() => maintenanceHistory(join(d, 'absent'), join(d, 'active'), () => {}));
  writeFileSync(join(d, 'active'), '{}');
  assert.throws(() => maintenanceHistory(join(d, 'absent'), join(d, 'active'), () => {}));
});
