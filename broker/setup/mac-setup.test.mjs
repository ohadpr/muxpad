import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appOrigin, makeConfig, requireResume } from './mac-setup.mjs';
test('fresh setup binds exact user HTTPS origin; IPs and ambiguous URLs fail', () => {
  for (const s of [
    'http://app.test',
    'https://app.test/path',
    'https://user@app.test',
    'https://100.1.2.3',
  ])
    assert.throws(() => appOrigin(s));
  assert.equal(appOrigin('https://muxpad.example'), 'https://muxpad.example');
});
test('new config has no legacy or member authority; generation random; enrollment begins through exact private lease', () => {
  const c = makeConfig('https://muxpad-secure.tail.ts.net', 'https://muxpad.example', 'T123');
  assert.equal(c.approvalMode, 'passkey-inline');
  assert.equal(c.authMode, 'paired');
  assert.equal(c.autoRead, false);
  assert.equal(c.passkeyOrigin, 'https://muxpad.example');
  assert.equal(c.passkeyEnrollmentExpires, 0);
  assert(
    c.passkeyGeneration !==
      makeConfig('https://muxpad-secure.tail.ts.net', 'https://muxpad.example', 'T123')
        .passkeyGeneration,
  );
  for (const [origin, app, team] of [
    ['http://bad', 'https://a.test', 'T123'],
    ['https://a.test', 'https://a.test', 'T123'],
    ['https://x.ts.net', 'https://a.test', 'bad'],
  ])
    assert.throws(() => makeConfig(origin, app, team));
});
test('redo matches exact release/account/origin and cannot restart an uncertain started service', () => {
  const plan = { release: 'r', origin: 'https://a.test', agentUID: 501, stateMayHaveChanged: true },
    ctx = { release: 'r', origin: 'https://a.test', uid: 501, loaded: true, processes: true };
  assert.equal(requireResume(plan, ctx), plan);
  for (const changes of [
    { release: 'other' },
    { origin: 'https://other.test' },
    { uid: 502 },
    { loaded: false },
    { processes: false },
  ])
    assert.throws(() => requireResume(plan, { ...ctx, ...changes }));
  assert.equal(
    requireResume(
      { ...plan, stateMayHaveChanged: false },
      { ...ctx, loaded: false, processes: false },
    ).stateMayHaveChanged,
    false,
  );
});

test('actual launchctl status adapter recognizes absence only; permission and timeout failures stay unknown', async () => {
  const { missingServiceError } = await import('./mac-setup.mjs');
  const stderr = Buffer.from(
    'Bad request.\nCould not find service "org.muxpad.broker" in domain for system',
  );
  assert.equal(missingServiceError({ status: 113, stderr }), true);
  assert.equal(missingServiceError({ status: 3, stderr }), true);
  for (const e of [
    { status: 113, stderr: Buffer.from('Permission denied') },
    { status: 1, stderr },
    { status: null, code: 'ETIMEDOUT', stderr },
    { status: 113, signal: 'SIGTERM', stderr },
    { status: 113, code: 'ETIMEDOUT', stderr },
  ])
    assert.equal(missingServiceError(e), false);
});

test('actual complete release manifest includes scoped npm dependencies; validator accepts all real paths', async () => {
  const { releasePath } = await import('./mac-setup.mjs');
  const { readFileSync } = await import('node:fs');
  const rows = process.env.MUXPAD_SETUP_RELEASE_MANIFEST ? JSON.parse(readFileSync(process.env.MUXPAD_SETUP_RELEASE_MANIFEST,'utf8')) : [{file:'code/node_modules/@simplewebauthn/server/esm/index.js'},{file:'code/node_modules/@noble/hashes/crypto.js'}];
  assert(rows.some((r) => r.file.includes('/@simplewebauthn/')));
  for (const row of rows) assert(releasePath(row.file), row.file);
  for (const name of [
    '/absolute',
    '../escape',
    'code/../escape',
    'code/./alias',
    'code//empty',
    'code/a\u0000',
    'code/a\\b',
  ])
    assert.equal(releasePath(name), false, name);
});
