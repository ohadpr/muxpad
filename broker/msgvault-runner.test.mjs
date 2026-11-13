import assert from 'node:assert/strict';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
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

test('the runner pins no mode — except 0600 on the token, which is its real mode', () => {
  const src = readFileSync(new URL('./msgvault-runner.mjs', import.meta.url), 'utf8');
  const calls = src.split('\n').filter((l) => l.includes('io.assertProtectedPath('));
  for (const l of calls)
    if (/mode:/.test(l)) assert.match(l, /declared\.tokenFile.*mode: 0o600 \}/, l);
});

test('the real guard accepts the real token at 0600, owned by the broker', () => {
  // lstat needs no read permission, so this checks the INSTALLED layout from
  // an unprivileged test: the file's owner (the broker's account), its exact
  // mode, and every ancestor root-owned with no group/other write.
  const path = '/Library/muxpad-broker/msgvault-agent-token';
  if (!existsSync(path)) return;
  const owner = lstatSync(path).uid;
  assert.notEqual(owner, 0, 'the token is the broker account’s, not root’s');
  assert.throws(() => assertProtectedPath(path, [0]), /Unprotected/);
  assert.doesNotThrow(() => assertProtectedPath(path, [0, owner], { mode: 0o600 }));
});

test('a non-attachment action keeps the small execFile buffer', async () => {
  // The attachment half of this test is gone with the argv path it measured:
  // an attachment is fetched over HTTP now, so there is no child process and
  // no maxBuffer. Its cap is asserted below, on the bytes themselves.
  const h = harness();
  await h.runner('msgvault.stats', {});
  assert.equal(h.ran[0].opts.maxBuffer, 4 * 1024 * 1024);
});

/**
 * ── ATTACHMENTS DO NOT GO THROUGH THE BINARY ──────────────────────────────
 *
 * msgvault's CLI refuses every export verb in agent-delegated mode, and it
 * refuses CLIENT-SIDE — before the daemon is contacted — so the argv path
 * could never deliver an attachment however the broker was updated. The
 * daemon's own `/api/v1/cli/attachment` is on the same surface the allowed
 * verbs use and answers with the bytes.
 */
const HASH = 'a'.repeat(64);

function httpHarness({ status = 200, body = Buffer.from('%PDF-1.4 hello'), headers = {} } = {}) {
  const calls = [];
  const ran = [];
  const runner = msgvaultRunner({
    io: {
      readFileSync: (p) => (String(p).includes('token') ? 'SECRET-KEY\n' : DECL),
      assertProtectedPath: () => {},
    },
    run: (binary, args, opts, done) => {
      ran.push({ binary, args });
      done(null, '{}', '');
    },
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (k) => headers[k.toLowerCase()] ?? null },
        arrayBuffer: async () =>
          body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
        text: async () => 'refused',
      };
    },
  });
  return { runner, calls, ran };
}

test('an attachment is fetched from the daemon, never shelled through the CLI', async () => {
  const h = httpHarness({
    headers: {
      'content-disposition': 'attachment; filename="2026-11-04_tax.pdf"',
      'content-type': 'application/pdf; charset=binary',
    },
  });
  const out = await h.runner('msgvault.export-attachment', { hash: HASH });
  assert.equal(h.ran.length, 0, 'the binary must not be run for an attachment');
  assert.equal(h.calls[0].url, `http://127.0.0.1:8787/api/v1/cli/attachment?content_hash=${HASH}`);
  // The grant is a header here rather than a path, because there is no argv.
  assert.equal(h.calls[0].init.headers['X-Api-Key'], 'SECRET-KEY');
  assert.equal(out.result.content_hash, HASH);
  assert.equal(Buffer.from(out.result.data_base64, 'base64').toString(), '%PDF-1.4 hello');
  assert.equal(out.result.filename, '2026-11-04_tax.pdf');
  assert.equal(out.result.mime_type, 'application/pdf');
  assert.equal(out.result.size, 14);
});

test("the daemon's own refusal is passed through, not retried", async () => {
  // A 401 means the agent key is not accepted for attachments — a
  // msgvault-side decision the agent must be told plainly.
  const h = httpHarness({ status: 401 });
  await assert.rejects(() => h.runner('msgvault.export-attachment', { hash: HASH }), /401/);
});

test('an attachment larger than the cap is refused, not silently truncated', async () => {
  const h = httpHarness({ body: Buffer.alloc(40 * 1024 * 1024, 1) });
  await assert.rejects(() => h.runner('msgvault.export-attachment', { hash: HASH }), /cap/);
});

test('a bad hash never reaches the network', async () => {
  const h = httpHarness();
  await assert.rejects(() => h.runner('msgvault.export-attachment', { hash: 'nope' }), /64-hex/);
  assert.equal(h.calls.length, 0);
});

/**
 * ── THE TOKEN IS THE BROKER'S, NOT ROOT'S ──────────────────────────────────
 *
 * Every attachment test above injects an `assertProtectedPath` that passes
 * everything, and that is how this shipped dead: the runner demanded the
 * token file be ROOT-owned, while the installed file is 0600 and owned by
 * the broker's own account — the only account that can read it, which is
 * the point. Live, every `muxpad msgvault attachment` answered "Unprotected
 * file or ancestor" before a byte was fetched.
 *
 * So this harness enforces OWNERSHIP the way the real check does, with the
 * real layout: root owns the declaration and the binary, the broker owns the
 * token.
 */
test('an attachment works when the token is owned by the broker itself', async () => {
  const BROKER = process.getuid();
  const owner = (p) => (String(p).includes('agent-token') ? BROKER : 0);
  const checked = [];
  const runner = msgvaultRunner({
    io: {
      readFileSync: (p) => (String(p).includes('token') ? 'K\n' : DECL),
      assertProtectedPath: (path, owners, opts) => {
        checked.push({ path, owners, opts });
        if (!owners.includes(owner(path))) throw new Error('Unprotected file or ancestor');
      },
    },
    run: () => assert.fail('the binary must not be run for an attachment'),
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      text: async () => '',
    }),
  });
  const out = await runner('msgvault.export-attachment', { hash: HASH });
  assert.equal(out.result.size, 3);
  // And it is still a TIGHT check: only root or this process, and 0600.
  const token = checked.find((c) => String(c.path).includes('agent-token'));
  assert.deepEqual(token.owners, [0, BROKER]);
  assert.equal(token.opts?.mode, 0o600);
  // The declaration and the binary stay root-only.
  for (const c of checked.filter((c) => !String(c.path).includes('agent-token')))
    assert.deepEqual(c.owners, [0], c.path);
});
