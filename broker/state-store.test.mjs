import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { saveState } from './state-store.mjs';
test('state saves survive old crash remnants, replace atomically and leave no new temp files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'broker-state-'));
  try {
    const path = join(dir, 'state.json');
    writeFileSync(`${path}.tmp`, 'stale crash');
    saveState(path, { version: 1 });
    saveState(path, { version: 2 });
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { version: 2 });
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(dir).sort(), ['state.json', 'state.json.tmp']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('serialization failure preserves the previous state and leaves no temp file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'broker-state-'));
  try {
    const path = join(dir, 'state.json');
    saveState(path, { safe: true });
    const cyclic = {};
    cyclic.self = cyclic;
    assert.throws(() => saveState(path, cyclic));
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { safe: true });
    assert.deepEqual(readdirSync(dir), ['state.json']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
