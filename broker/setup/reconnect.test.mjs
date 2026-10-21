import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reconnect } from './reconnect.mjs';
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'muxpad-reconnect-')),
    events = [];
  let loaded = true,
    processes = true,
    fault = false,
    interrupt = null,
    key = 'same-key';
  const read = () =>
    existsSync(join(dir, 'journal'))
      ? JSON.parse(readFileSync(join(dir, 'journal'), 'utf8'))
      : null;
  const write = (p) => writeFileSync(join(dir, 'journal'), JSON.stringify(p));
  writeFileSync(join(dir, 'token'), 'old');
  return {
    events,
    read,
    token: () => readFileSync(join(dir, 'token'), 'utf8'),
    setFault: (v) => (fault = v),
    setInterrupt: (v) => (interrupt = v),
    setStopped: () => {
      loaded = false;
      processes = false;
    },
    setKey: (v) => (key = v),
    a: {
      load: async () => read(),
      prepare: async () => {
        events.push('prepare');
        writeFileSync(join(dir, 'secret'), 'new');
        const p = { id: 'exact', phase: 'prepared', stateMayHaveChanged: false };
        write(p);
        return p;
      },
      validate: async () => {
        if (fault) throw Error('storage fault');
      },
      save: async (p) => {
        if (interrupt === 'before-' + p.phase) {
          interrupt = null;
          throw Error('crash');
        }
        write(p);
        if (interrupt === 'after-' + p.phase) {
          interrupt = null;
          throw Error('crash');
        }
      },
      disable: async () => events.push('disable'),
      stop: async () => {
        events.push('stop');
        loaded = false;
        processes = false;
      },
      captureCredential: async () => ({ key }),
      requireStopped: async () => assert(!loaded && !processes),
      install: async (p) => {
        assert.equal(p.credential.key, key);
        assert(!loaded && !processes);
        events.push('install');
        writeFileSync(join(dir, 'token'), readFileSync(join(dir, 'secret')));
      },
      verifyInstalled: async (p) => {
        assert.equal(p.credential.key, key);
        assert.equal(readFileSync(join(dir, 'token'), 'utf8'), 'new');
      },
      running: async () => ({ loaded, processes }),
      enable: async () => events.push('enable'),
      start: async () => {
        events.push('start');
        loaded = true;
        processes = true;
      },
      ready: async (p) => {
        if (fault) throw Error('storage fault');
        assert.equal(p.credential.key, key);
        assert(loaded && processes);
        events.push('ready');
      },
      forgetSecret: async () => events.push('forget'),
    },
  };
}
test('revoked/stopped old service can replace token without requiring old health first; existing key retained', async () => {
  const f = fixture();
  f.setStopped();
  await reconnect(f.a);
  assert.equal(f.token(), 'new');
  assert.equal(f.read().phase, 'ready');
  assert.deepEqual(f.events, [
    'prepare',
    'disable',
    'stop',
    'install',
    'enable',
    'start',
    'ready',
    'forget',
  ]);
});
test('replacement persists irreversible intent before disable and never installs while running', async () => {
  const f = fixture();
  f.a.disable = async () => {
    assert.equal(f.read().stateMayHaveChanged, true);
    f.events.push('disable');
  };
  await reconnect(f.a);
  assert.equal(f.read().credential.key, 'same-key');
});
for (const point of [
  'before-stopped',
  'after-stopped',
  'before-installed',
  'after-installed',
  'before-starting',
  'after-starting',
  'before-ready',
  'after-ready',
])
  test('actual file journal forward recovery: ' + point, async () => {
    const f = fixture();
    f.setInterrupt(point);
    await assert.rejects(reconnect(f.a));
    await reconnect(f.a);
    assert.equal(f.read().phase, 'ready');
    assert.equal(f.token(), 'new');
    assert.equal(f.events.filter((x) => x === 'prepare').length, 1);
    assert.equal(f.events.filter((x) => x === 'start').length, 1);
  });
test('observed storage uncertainty blocks replacement/restart; changed credential blocks startup', async () => {
  const f = fixture();
  f.setFault(true);
  await assert.rejects(reconnect(f.a));
  assert(!f.events.includes('stop'));
  const g = fixture();
  g.setInterrupt('after-installed');
  await assert.rejects(reconnect(g.a));
  g.setKey('different');
  await assert.rejects(reconnect(g.a));
  assert(!g.events.includes('start'));
});

test('actual completed-journal selector reconciles by default; only explicit choice starts replacement', async () => {
  const { selectReconnect } = await import('./reconnect.mjs');
  const p = { phase: 'ready', id: 'old' };
  assert.equal(selectReconnect(p, ''), p);
  assert.equal(selectReconnect(p, 'REPLACE TOKEN'), null);
  assert.throws(() => selectReconnect(p, 'yes'));
  const f = fixture();
  await reconnect(f.a);
  const prepared = f.events.filter((x) => x === 'prepare').length;
  const original = f.a.load;
  f.a.load = async () => selectReconnect(await original(), '');
  await reconnect(f.a);
  assert.equal(f.events.filter((x) => x === 'prepare').length, prepared);
  assert.equal(f.events.filter((x) => x === 'start').length, 1);
});
