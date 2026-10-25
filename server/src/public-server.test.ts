import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPublicApp } from './public-server.js';

describe('public static server', () => {
  let root: string;
  let publicDir: string;
  let app: ReturnType<typeof createPublicApp>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'muxpad-public-'));
    publicDir = join(root, 'public');
    mkdirSync(join(publicDir, 'site', 'assets'), { recursive: true });
    writeFileSync(join(publicDir, 'site', 'index.html'), '<html>hello</html>');
    writeFileSync(join(publicDir, 'site', 'assets', 'app.js'), 'console.log(1)');
    writeFileSync(join(publicDir, 'site', 'data.bin'), 'bin');
    // A secret OUTSIDE the public dir that traversal/symlinks must not reach.
    writeFileSync(join(root, 'secret.txt'), 'top secret');
    app = createPublicApp(publicDir);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('serves files with correct content-type, nosniff and cache headers', async () => {
    const res = await app.request('/site/index.html');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toBe('public, max-age=60, must-revalidate');
    expect(await res.text()).toBe('<html>hello</html>');

    const js = await app.request('/site/assets/app.js');
    expect(js.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(js.headers.get('cache-control')).toBe('public, max-age=86400');

    const bin = await app.request('/site/data.bin');
    expect(bin.headers.get('content-type')).toBe('application/octet-stream');
  });

  it('serves index.html for a slug directory and redirects /slug → /slug/', async () => {
    const res = await app.request('/site/');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<html>hello</html>');

    const redir = await app.request('/site');
    expect(redir.status).toBe(301);
    expect(redir.headers.get('location')).toBe('/site/');
  });

  it('404s the root — no listing, no index', async () => {
    writeFileSync(join(publicDir, 'index.html'), 'root index should not serve');
    expect((await app.request('/')).status).toBe(404);
  });

  it('404s a directory without index.html (no listings inside slugs)', async () => {
    expect((await app.request('/site/assets/')).status).toBe(404);
  });

  it('404s missing files and unknown slugs', async () => {
    expect((await app.request('/site/nope.html')).status).toBe(404);
    expect((await app.request('/nope/')).status).toBe(404);
  });

  it('rejects encoded traversal', async () => {
    for (const path of [
      '/%2e%2e/secret.txt',
      '/site/%2e%2e/%2e%2e/secret.txt',
      '/site/..%2fsecret.txt',
      '/site/%2e%2e%2fsecret.txt',
      '/%2e%2e%2f%2e%2e%2fsecret.txt',
      '/site/..%5c..%5csecret.txt',
      '/%00/secret.txt',
      '/site/%zz', // malformed percent-encoding
    ]) {
      const res = await app.request(path);
      expect(res.status, path).toBe(404);
    }
  });

  it('refuses symlinks that escape the public dir, allows internal ones', async () => {
    symlinkSync(join(root, 'secret.txt'), join(publicDir, 'site', 'leak.txt'));
    expect((await app.request('/site/leak.txt')).status).toBe(404);
    // A symlinked directory escaping the root is refused too.
    mkdirSync(join(root, 'outside-dir'));
    writeFileSync(join(root, 'outside-dir', 'index.html'), 'outside');
    symlinkSync(join(root, 'outside-dir'), join(publicDir, 'outdir'));
    expect((await app.request('/outdir/')).status).toBe(404);
    // Internal symlinks (target stays under the public dir) are fine.
    symlinkSync(join(publicDir, 'site', 'index.html'), join(publicDir, 'site', 'alias.html'));
    expect((await app.request('/site/alias.html')).status).toBe(200);
  });

  it('has no API surface — /api/* is static-only 404', async () => {
    expect((await app.request('/api/health')).status).toBe(404);
    expect((await app.request('/api/workspaces')).status).toBe(404);
    expect((await app.request('/api', { method: 'POST' })).status).toBe(404);
    expect((await app.request('/site/', { method: 'POST' })).status).toBe(404);
    expect((await app.request('/site/index.html', { method: 'DELETE' })).status).toBe(404);
  });

  it('answers HEAD with headers and no body', async () => {
    const res = await app.request('/site/index.html', { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe('18');
    expect(await res.text()).toBe('');
  });

  describe('sandbox headers', () => {
    // One shared public origin serves every artifact and every @2/@3 version,
    // and the MIME map serves html/js/svg. The sandbox is what stops artifact
    // A's script reaching artifact B's storage and stops a navigated .svg
    // executing in a shared origin. THIS suite pins the exact token list;
    // integration/public-csp.test.ts drives a real browser to prove the
    // artifacts still render under it.
    const csp = (res: Response) => res.headers.get('content-security-policy') ?? '';

    it('sandboxes every response — file, 404, redirect, HEAD', async () => {
      for (const res of [
        await app.request('/site/index.html'),
        await app.request('/site/assets/app.js'),
        await app.request('/nope/'),
        await app.request('/'),
        await app.request('/site'), // 301
        await app.request('/site/index.html', { method: 'HEAD' }),
      ]) {
        expect(csp(res)).toMatch(/^sandbox\b/);
        expect(res.headers.get('referrer-policy')).toBe('no-referrer');
        expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      }
    });

    it('never grants allow-same-origin — that would undo the whole point', async () => {
      // `allow-scripts allow-same-origin` together hand the document the real
      // shared origin back, which is exactly the state this header exists to
      // end. If anyone ever adds it to "fix" a broken artifact, fail here.
      expect(csp(await app.request('/site/index.html'))).not.toContain('allow-same-origin');
    });

    it('grants EXACTLY the tokens a real artifact needs, and no others', async () => {
      // Bare `sandbox` renders agent-written dashboards as dead layout, so
      // some tokens are the difference between "isolated" and "broken". This
      // is an equality check, not a contains-check: a token quietly ADDED to
      // "fix" something is how a sandbox stops being one.
      const tokens = csp(await app.request('/site/index.html')).split(/\s+/);
      expect(tokens).toEqual([
        'sandbox',
        'allow-scripts',
        'allow-forms',
        'allow-modals',
        'allow-popups',
        'allow-popups-to-escape-sandbox',
        'allow-downloads',
      ]);
    });

    it('allows the opaque origin — and only it — to fetch sibling data files', async () => {
      // The sandbox makes `fetch('./data.json')` cross-origin, so without an
      // ACAO a data-driven artifact silently shows nothing. `null` is the
      // origin our own sandboxed documents send; `*` would additionally hand
      // every named origin blanket read access to a port that is loopback-only
      // when MUXPAD_NO_FUNNEL=1.
      const res = await app.request('/site/index.html');
      expect(res.headers.get('access-control-allow-origin')).toBe('null');
    });
  });
});

/**
 * THE EXPIRED LINK.
 *
 * Links published here answer for a week by default. The gate is on the LINK,
 * never on the bytes — an expired artifact is still on disk, because the next
 * thing that happens is the user asking for it back.
 */
describe('an expired link', () => {
  const withArtifact = () => {
    const root = mkdtempSync(join(tmpdir(), 'mux-public-exp-'));
    mkdirSync(join(root, 'report-7k3mqp2x'), { recursive: true });
    writeFileSync(join(root, 'report-7k3mqp2x', 'index.html'), '<p>live</p>');
    mkdirSync(join(root, 'report-7k3mqp2x@2'), { recursive: true });
    writeFileSync(join(root, 'report-7k3mqp2x@2', 'index.html'), '<p>older</p>');
    return root;
  };

  it('answers 410, not 404 — the artifact exists and can be extended', async () => {
    const root = withArtifact();
    const app = createPublicApp(root, { expiresAt: () => 1_000, now: () => 2_000 });
    const res = await app.fetch(new Request('http://pub/report-7k3mqp2x/'));
    expect(res.status).toBe(410);
    expect(await res.text()).toMatch(/expired/i);
  });

  it('takes the rotations with it', async () => {
    // Otherwise the previous version keeps serving from a url one character
    // away, and "that link is down" is false.
    const root = withArtifact();
    const app = createPublicApp(root, {
      expiresAt: (seg) => (seg.startsWith('report-7k3mqp2x') ? 1_000 : null),
      now: () => 2_000,
    });
    expect((await app.fetch(new Request('http://pub/report-7k3mqp2x@2/'))).status).toBe(410);
  });

  it('leaves the bytes exactly where they were', async () => {
    const root = withArtifact();
    const app = createPublicApp(root, { expiresAt: () => 1_000, now: () => 2_000 });
    await app.fetch(new Request('http://pub/report-7k3mqp2x/'));
    expect(readFileSync(join(root, 'report-7k3mqp2x', 'index.html'), 'utf8')).toBe('<p>live</p>');
  });

  it('serves normally before the horizon, and after an extension', async () => {
    const root = withArtifact();
    const live = createPublicApp(root, { expiresAt: () => 5_000, now: () => 2_000 });
    expect((await live.fetch(new Request('http://pub/report-7k3mqp2x/'))).status).toBe(200);
  });

  it('serves a slug with no horizon at all — the pre-expiry artifacts', async () => {
    const root = withArtifact();
    const app = createPublicApp(root, { expiresAt: () => null, now: () => 9e12 });
    expect((await app.fetch(new Request('http://pub/report-7k3mqp2x/'))).status).toBe(200);
  });

  it('still carries the sandbox on the 410', async () => {
    const root = withArtifact();
    const app = createPublicApp(root, { expiresAt: () => 1_000, now: () => 2_000 });
    const res = await app.fetch(new Request('http://pub/report-7k3mqp2x/'));
    expect(res.headers.get('content-security-policy')).toMatch(/sandbox/);
  });
});
