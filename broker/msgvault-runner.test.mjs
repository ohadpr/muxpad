import assert from 'node:assert/strict';
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
  for (const agentUrl of ['http://10.0.0.5:8787', 'https://evil.test', 'http://127.0.0.1.evil.test']) {
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
    cb: (done) => done(new Error('exit 1'), '', 'Error: query is not available in agent-delegated mode\nmore'),
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
