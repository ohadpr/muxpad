import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { msgvaultRunner } from './msgvault-runner.mjs';

const DECL = JSON.stringify({
  msgvault: {
    binary: '/usr/local/libexec/msgvault/msgvault',
    agentUrl: 'http://127.0.0.1:8787',
    tokenFile: '/Library/muxpad-broker/msgvault-agent-token',
  },
});

function harness({ decl = DECL, protect = () => {}, cb } = {}) {
  const ran = [];
  const runner = msgvaultRunner({
    io: { readFileSync: () => decl, assertProtectedPath: protect },
    run: (binary, args, opts, done) => {
      ran.push({ binary, args, opts });
      (cb ?? ((d) => d(null, '{"ok":true}', '')))(done);
    },
  });
  return { runner, ran };
}

test('runs the declared binary with the grant as a PATH', async () => {
  const h = harness();
  const out = await h.runner('msgvault.stats', {});
  assert.deepEqual(out, { action: 'msgvault.stats', result: { ok: true } });
  const { binary, args, opts } = h.ran[0];
  assert.equal(binary, '/usr/local/libexec/msgvault/msgvault');
  assert.ok(args.includes('--agent-token-file'));
  assert.ok(args.includes('/Library/muxpad-broker/msgvault-agent-token'));
  // No shell: there is no string for a query to be re-split inside.
  assert.equal(opts.shell, false);
  // An empty environment — MSGVAULT_HOME inherited from the broker would be a
  // second way to re-point the tool that nobody approved.
  assert.deepEqual(opts.env, {});
  assert.ok(opts.timeout > 0 && opts.maxBuffer > 0);
});

test('refuses a declaration that is not protected', async () => {
  const h = harness({
    protect: (p) => {
      throw new Error(`unprotected: ${p}`);
    },
  });
  await assert.rejects(h.runner('msgvault.stats', {}), /unprotected/);
  assert.equal(h.ran.length, 0); // nothing ran
});

test('checks the BINARY too, not only the file that names it', async () => {
  const seen = [];
  const h = harness({
    protect: (p) => {
      seen.push(p);
    },
  });
  await h.runner('msgvault.stats', {});
  assert.deepEqual(seen, [
    '/Library/muxpad/integrations.json',
    '/usr/local/libexec/msgvault/msgvault',
  ]);
});

test('refuses a declaration that points the grant off this machine', async () => {
  for (const agentUrl of [
    'http://10.0.0.5:8787',
    'https://evil.test',
    'http://127.0.0.1.evil.test',
  ]) {
    const h = harness({
      decl: JSON.stringify({ msgvault: { binary: '/b', agentUrl, tokenFile: '/t' } }),
    });
    await assert.rejects(h.runner('msgvault.stats', {}), /loopback/, agentUrl);
    assert.equal(h.ran.length, 0);
  }
});

test('an absent declaration refuses rather than guessing', async () => {
  const h = harness({ decl: '{}' });
  await assert.rejects(h.runner('msgvault.stats', {}), /not declared/);
});

test("passes msgvault's own refusal back, and never the grant", async () => {
  const h = harness({
    cb: (done) =>
      done(new Error('exit 1'), '', 'Error: query is not available in agent-delegated mode\nmore'),
  });
  await assert.rejects(h.runner('msgvault.stats', {}), (e) => {
    assert.match(e.message, /not available in agent-delegated mode/);
    assert.ok(!e.message.includes('\n'));
    return true;
  });
});

test('non-JSON output comes back as text rather than throwing', async () => {
  const h = harness({ cb: (done) => done(null, 'Messages: 338,818\n', '') });
  const out = await h.runner('msgvault.stats', {});
  assert.match(out.text, /338,818/);
});

/**
 * …AND IT MUST CALL THAT GUARD CORRECTLY.
 *
 * Every test above injects `assertProtectedPath`, which is right for checking
 * WHEN it is called — and is exactly why they all passed while the real call
 * was wrong. `mode` is an EXACT expected mode, not a mask; `{ mode: 0o022 }`
 * asserted "this file is ----w--w-", which no readable file is, so every
 * request failed with 'Incorrect protected file mode' before msgvault ran.
 *
 * A mocked seam cannot catch a misused API. These two use the real one.
 */
import { assertProtectedPath } from './protected-path.mjs';

test('the real guard accepts the files this actually runs against', () => {
  // The declaration is root-owned 0644; the installed binary root-owned 0755.
  // Both are "protected" in the sense that matters — no group or other write,
  // all the way up — and neither has a single exact mode this could pin.
  for (const path of ['/Library/muxpad/integrations.json'])
    if (existsSync(path)) assertProtectedPath(path, [0]);
});

test('passing a mode makes it reject the very files it guards', () => {
  const path = '/Library/muxpad/integrations.json';
  if (!existsSync(path)) return;
  assert.throws(
    () => assertProtectedPath(path, [0], { mode: 0o022 }),
    /Incorrect protected file mode/,
  );
  assert.doesNotThrow(() => assertProtectedPath(path, [0]));
});

test('the runner passes no mode', () => {
  const src = readFileSync(new URL('./msgvault-runner.mjs', import.meta.url), 'utf8');
  assert.ok(!/assertProtectedPath\([^)]*mode:/.test(src), 'the runner pins an exact mode again');
});

test('an attachment gets room for a scanned PDF; everything else keeps the small buffer', async () => {
  const h = harness();
  await h.runner('msgvault.stats', {});
  await h.runner('msgvault.export-attachment', { hash: 'a'.repeat(64) });
  const [small, big] = h.ran.map((r) => r.opts.maxBuffer);
  assert.equal(small, 4 * 1024 * 1024);
  // base64 inside JSON: 32 MiB of output is a ~24 MiB file.
  assert.ok(big >= 32 * 1024 * 1024, String(big));
});
