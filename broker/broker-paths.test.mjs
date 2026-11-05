import assert from 'node:assert/strict';
import { test } from 'node:test';

// The root is read at module load, so each platform needs its own import.
const load = async (platform) => {
  const real = process.platform;
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    return await import(`./broker-paths.mjs?${platform}-${Math.random()}`);
  } finally {
    Object.defineProperty(process, 'platform', { value: real, configurable: true });
  }
};

test('each supported platform has one protected tree', async () => {
  assert.equal((await load('darwin')).BROKER_ROOT, '/Library/muxpad-broker');
  assert.equal((await load('linux')).BROKER_ROOT, '/opt/muxpad-broker');
});

test('an unsupported platform has none, and building a path throws', async () => {
  const m = await load('sunos');
  assert.equal(m.BROKER_ROOT, null);
  assert.throws(() => m.brokerPath('state', 'origin'), /not supported on sunos/);
});

test('the state paths the transport pins are inside that tree', async () => {
  // main.mjs compares `config.originPath` and `config.socketPath` by exact
  // string, so these two are a contract with the installer, not a convenience.
  const linux = await load('linux');
  assert.equal(linux.brokerPath('state', 'origin'), '/opt/muxpad-broker/state/origin');
  assert.equal(linux.brokerPath('state', 'broker.sock'), '/opt/muxpad-broker/state/broker.sock');
});
