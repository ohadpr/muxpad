import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sendPath } from '../node-agent/send-files.js';
import { FileReceiver, sanitizeName } from './receive-files.js';

/**
 * THE TRANSFER, BOTH ENDS, AGAINST A REAL FILESYSTEM.
 *
 * `muxpad publish` is the one in-pane verb whose payload is bytes: artifacts
 * are served off this machine's disk behind the single public tunnel, and the
 * file is on the host. The wire format is a list of (relative path, bytes) and
 * NOTHING else — it cannot describe a symlink, a device or a permission bit —
 * so what has to be right is the relative path, and that is what most of this
 * file is about.
 */

let dir: string;
let src: string;
let dst: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'muxpad-files-'));
  src = join(dir, 'src');
  dst = join(dir, 'dst');
  mkdirSync(src, { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Run a real send into a real receiver, as the link would. */
async function transfer(path: string): Promise<{ out: string | null; error: string | null }> {
  const recv = new FileReceiver(dst);
  let result: { kind: 'file' | 'dir'; name: string } | null = null;
  let error: string | null = null;
  await sendPath(path, {
    chunk: (rel, b64, last) => recv.chunk(rel, b64, last),
    done: (kind, name) => {
      result = { kind, name };
    },
    error: (reason) => {
      error = reason;
    },
  });
  if (error) return { out: null, error };
  if (!result) return { out: null, error: 'nothing was sent' };
  const r = result as { kind: 'file' | 'dir'; name: string };
  const out = recv.finish(r.kind, r.name);
  return { out, error: recv.error };
}

describe('a whole directory', () => {
  it('arrives with its tree and its bytes intact', async () => {
    const { writeFileSync } = await import('node:fs');
    mkdirSync(join(src, 'assets', 'deep'), { recursive: true });
    writeFileSync(join(src, 'index.html'), '<h1>hi</h1>');
    writeFileSync(join(src, 'assets', 'app.css'), 'body{}');
    writeFileSync(join(src, 'assets', 'deep', 'x.json'), '{"a":1}');
    // An EMPTY file streams no chunks at all — the close is its own frame
    // precisely so this case needs no branch on either side.
    writeFileSync(join(src, 'empty.txt'), '');

    const { out, error } = await transfer(src);
    expect(error).toBe(null);
    expect(out).toBe(dst);
    expect(readFileSync(join(dst, 'index.html'), 'utf8')).toBe('<h1>hi</h1>');
    expect(readFileSync(join(dst, 'assets', 'app.css'), 'utf8')).toBe('body{}');
    expect(readFileSync(join(dst, 'assets', 'deep', 'x.json'), 'utf8')).toBe('{"a":1}');
    expect(existsSync(join(dst, 'empty.txt'))).toBe(true);
    expect(readFileSync(join(dst, 'empty.txt'), 'utf8')).toBe('');
  });

  it('survives a file bigger than one chunk, byte for byte', async () => {
    const { writeFileSync } = await import('node:fs');
    // 700KB of non-repeating bytes: chunk boundaries that dropped or doubled
    // data would show up as a length or a hash mismatch.
    const big = Buffer.alloc(700 * 1024);
    for (let i = 0; i < big.length; i++) big[i] = (i * 31 + 7) & 0xff;
    writeFileSync(join(src, 'big.bin'), big);
    const { out, error } = await transfer(src);
    expect(error).toBe(null);
    expect(readFileSync(join(out as string, 'big.bin')).equals(big)).toBe(true);
  });

  it('skips symlinks inside the tree rather than following them', async () => {
    const { writeFileSync, symlinkSync } = await import('node:fs');
    const secret = join(dir, 'secret.txt');
    writeFileSync(secret, 'not yours');
    writeFileSync(join(src, 'index.html'), 'x');
    symlinkSync(secret, join(src, 'link.txt'));
    // Publishing a project directory would otherwise ship whatever its links
    // point at — and a cycle would never finish.
    const { out, error } = await transfer(src);
    expect(error).toBe(null);
    expect(readdirSync(out as string).sort()).toEqual(['index.html']);
  });
});

describe('a single file', () => {
  it('keeps the name it was published under', async () => {
    const { writeFileSync } = await import('node:fs');
    const f = join(src, 'report.html');
    writeFileSync(f, '<p>r</p>');
    const { out, error } = await transfer(f);
    expect(error).toBe(null);
    // Publish reads `basename(path)` — a staging id here would publish the
    // artifact under a random name, and a lone .html would stop becoming the
    // slug's index.
    expect(out?.endsWith('report.html')).toBe(true);
    expect(readFileSync(out as string, 'utf8')).toBe('<p>r</p>');
  });
});

describe('what the receiver refuses', () => {
  const recv = () => new FileReceiver(dst);

  it('a path that climbs out of the staging dir', () => {
    const r = recv();
    r.chunk('../escaped.txt', Buffer.from('x').toString('base64'), true);
    expect(r.error).toMatch(/outside the staging dir/);
    expect(existsSync(join(dir, 'escaped.txt'))).toBe(false);
  });

  it('a path that climbs out the long way round', () => {
    // The blocklist-for-`..` version of this check is the one that gets
    // bypassed; the real check is on the RESOLVED path.
    const r = recv();
    r.chunk('a/b/../../../out.txt', Buffer.from('x').toString('base64'), true);
    expect(r.error).toMatch(/outside the staging dir/);
  });

  it('an absolute path', () => {
    const r = recv();
    r.chunk('/etc/muxpad-owned', Buffer.from('x').toString('base64'), true);
    expect(r.error).toMatch(/outside the staging dir/);
  });

  it('a NUL in the path', () => {
    const r = recv();
    r.chunk('ok\u0000/../../x', '', true);
    expect(r.error).not.toBe(null);
  });

  it('a `rel` that is not a string at all, without throwing', () => {
    // Found in review: `pathFor` read `rel.includes('\0')` outside the try, so
    // a host answering a fetch with `rel: null` raised a TypeError inside a
    // WebSocket message handler — an uncaught exception, which takes the whole
    // server down. The frame is now refused at the link boundary
    // (HostLink.wellFormed), and this is the belt: the receiver itself must
    // not throw on one either, because it is one call away from a socket.
    const r = recv();
    expect(() => r.chunk(null as never, '', true)).not.toThrow();
    expect(r.error).not.toBe(null);
    expect(() => r.chunk(7 as never, '', true)).not.toThrow();
  });

  it('more bytes than an artifact has any business being', () => {
    const r = recv();
    const mb = Buffer.alloc(1024 * 1024).toString('base64');
    for (let i = 0; i < 70 && !r.error; i++) r.chunk(`f${i}`, mb, true);
    expect(r.error).toMatch(/too large/);
  });

  it('and once it has refused, it stays refused', () => {
    // A receiver that kept writing after a refusal would be staging a tree
    // nobody is going to look at — and the first error is the honest one.
    const r = recv();
    r.chunk('../escaped.txt', '', true);
    const first = r.error;
    r.chunk('fine.txt', Buffer.from('x').toString('base64'), true);
    expect(r.error).toBe(first);
    expect(existsSync(join(dst, 'fine.txt'))).toBe(false);
    expect(r.finish('dir', 'x')).toBe(null);
  });

  it('cleans up after itself', () => {
    const r = recv();
    r.chunk('a.txt', Buffer.from('x').toString('base64'), true);
    expect(existsSync(dst)).toBe(true);
    r.dispose();
    expect(existsSync(dst)).toBe(false);
  });
});

describe('a filename from a host', () => {
  it('is a basename and nothing structural', () => {
    expect(sanitizeName('/etc/passwd')).toBe('passwd');
    expect(sanitizeName('a/b/c.html')).toBe('c.html');
    expect(sanitizeName('..')).toBe(null);
    expect(sanitizeName('.')).toBe(null);
    expect(sanitizeName('   ')).toBe(null);
    expect(sanitizeName('ok.html')).toBe('ok.html');
  });
});

describe('a path that is not there', () => {
  it('is an error, not a hang — the pane is blocked on curl', async () => {
    const { error } = await transfer(join(src, 'nope'));
    expect(error).toMatch(/no such path/);
  });
});
