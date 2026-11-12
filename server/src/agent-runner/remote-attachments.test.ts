import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AttachmentRequester,
  type FetchResult,
  findAttachmentRefs,
  localizeAttachments,
} from './remote-attachments.js';

// The path the SERVER's composer appends — a mac path, which names nothing on
// the VM the runner is actually on.
const MAC = '/Users/someone/.muxpad/attachments';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'muxpad-remote-att-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
});

describe('findAttachmentRefs', () => {
  it('finds attachment paths and their names, once each', () => {
    const text = `look ${MAC}/3f2a9c1e.png and ${MAC}/aa11bb22.pdf then ${MAC}/3f2a9c1e.png`;
    expect(findAttachmentRefs(text)).toEqual([
      { path: `${MAC}/3f2a9c1e.png`, name: '3f2a9c1e.png' },
      { path: `${MAC}/aa11bb22.pdf`, name: 'aa11bb22.pdf' },
    ]);
  });

  // What the composer writes is a FILESYSTEM path. A URL that happens to
  // contain /attachments/ is the user's own words and must never be touched.
  it.each([
    ['an https URL', 'see https://pub.octarine.org/attachments/report.pdf for the writeup'],
    ['an http URL', 'http://host/attachments/x.png'],
    ['a protocol-relative URL', 'src=//host/attachments/x.png'],
    ['a relative path with no leading slash', 'look in attachments/x.png'],
    ['a path glued to a word', 'foo/tmp/attachments/x.png'],
    ['an attachment name followed by another extension', '/tmp/md/attachments/x.png.bak'],
  ])('does NOT match %s', (_label, text) => {
    expect(findAttachmentRefs(text)).toEqual([]);
  });

  it.each([
    [
      'the default data dir',
      'what is /Users/ohadpr/.muxpad/attachments/08951e42.png',
      '/Users/ohadpr/.muxpad/attachments/08951e42.png',
    ],
    ['a custom data dir', '/tmp/md/attachments/x.png', '/tmp/md/attachments/x.png'],
    ['a trailing comma', 'see /tmp/md/attachments/x.png, then', '/tmp/md/attachments/x.png'],
    ['a trailing full stop', 'see /tmp/md/attachments/x.png.', '/tmp/md/attachments/x.png'],
    ['inside parentheses', '(see /tmp/md/attachments/x.png)', '/tmp/md/attachments/x.png'],
    ['on its own line', 'prose\n/tmp/md/attachments/x.png', '/tmp/md/attachments/x.png'],
  ])('matches %s', (_label, text, path) => {
    expect(findAttachmentRefs(text)).toEqual([{ path, name: path.split('/').pop() }]);
  });

  it('leaves a pasted URL in the message alone while still localizing the real attachment', async () => {
    const fetch = vi.fn(async (): Promise<FetchResult> => ({ ok: true, bytes: Buffer.from('x') }));
    const url = 'https://pub.octarine.org/attachments/report.pdf';
    const out = await localizeAttachments(`read ${url}, and ${MAC}/3f2a9c1e.png.`, {
      dataDir: dir,
      fetch,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith('3f2a9c1e.png');
    expect(out).toBe(`read ${url}, and ${join(dir, 'attachments', '3f2a9c1e.png')}.`);
  });

  it('finds nothing in text with no attachment', () => {
    expect(findAttachmentRefs('fix the build, see /tmp/log.txt')).toEqual([]);
  });
});

describe('localizeAttachments', () => {
  it('leaves text with no attachment alone and asks for nothing', async () => {
    const fetch = vi.fn();
    const text = 'just words';
    expect(await localizeAttachments(text, { dataDir: dir, fetch })).toBe(text);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('a path that already exists here (a LOCAL pane) is untouched and nothing is fetched', async () => {
    // The server's attachments dir, and NOT the runner's data dir: the path is
    // honoured because it exists, not because it happens to be the copy.
    const att = join(dir, 'server-data', 'attachments');
    mkdirSync(att, { recursive: true });
    const path = join(att, '3f2a9c1e.png');
    writeFileSync(path, 'png');
    const fetch = vi.fn();
    const text = `what is this ${path}`;
    const runnerData = join(dir, 'runner-data');
    expect(await localizeAttachments(text, { dataDir: runnerData, fetch })).toBe(text);
    expect(existsSync(join(runnerData, 'attachments'))).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('a path missing here is fetched, written to THIS data dir, and the text rewritten to it', async () => {
    const fetch = vi.fn(
      async (): Promise<FetchResult> => ({ ok: true, bytes: Buffer.from('PNGBYTES') }),
    );
    const out = await localizeAttachments(`what is this ${MAC}/3f2a9c1e.png`, {
      dataDir: dir,
      fetch,
    });
    const local = join(dir, 'attachments', '3f2a9c1e.png');
    expect(fetch).toHaveBeenCalledWith('3f2a9c1e.png');
    expect(out).toBe(`what is this ${local}`);
    expect(readFileSync(local, 'utf8')).toBe('PNGBYTES');
    expect(out).not.toContain(MAC);
  });

  it('a second message naming the same attachment reuses the copy instead of fetching again', async () => {
    const fetch = vi.fn(async (): Promise<FetchResult> => ({ ok: true, bytes: Buffer.from('x') }));
    await localizeAttachments(`${MAC}/3f2a9c1e.png`, { dataDir: dir, fetch });
    const out = await localizeAttachments(`again ${MAC}/3f2a9c1e.png`, { dataDir: dir, fetch });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(out).toBe(`again ${join(dir, 'attachments', '3f2a9c1e.png')}`);
  });

  it('a path that cannot be fetched becomes an honest note — never a path to nothing', async () => {
    const fetch = vi.fn(
      async (): Promise<FetchResult> => ({ ok: false, reason: 'too large to transfer' }),
    );
    const out = await localizeAttachments(`see ${MAC}/aa11bb22.mp4 please`, {
      dataDir: dir,
      fetch,
    });
    expect(out).toBe(
      'see [attachment aa11bb22.mp4 could not be loaded on this machine: too large to transfer] please',
    );
    expect(existsSync(join(dir, 'attachments', 'aa11bb22.mp4'))).toBe(false);
  });

  it('a fetch that throws is a note too', async () => {
    const fetch = vi.fn(async (): Promise<FetchResult> => {
      throw new Error('boom');
    });
    const out = await localizeAttachments(`${MAC}/aa11bb22.png`, { dataDir: dir, fetch });
    expect(out).toContain('could not be loaded on this machine: boom');
  });
});

describe('AttachmentRequester', () => {
  it('settles with the bytes the server sends for its id', async () => {
    const sent: Array<{ id: string; name: string }> = [];
    const r = new AttachmentRequester({ send: (f) => sent.push(f) > 0 });
    const p = r.fetch('3f2a9c1e.png');
    expect(sent[0]?.name).toBe('3f2a9c1e.png');
    r.onData('someone-else', Buffer.from('no').toString('base64')); // ignored
    r.onData(sent[0]?.id, Buffer.from('yes').toString('base64'));
    const got = await p;
    expect(got.ok && got.bytes.toString()).toBe('yes');
  });

  it('carries the server’s refusal reason', async () => {
    const sent: Array<{ id: string }> = [];
    const r = new AttachmentRequester({ send: (f) => sent.push(f) > 0 });
    const p = r.fetch('x.png');
    r.onMissing(sent[0]?.id, 'not found');
    expect(await p).toEqual({ ok: false, reason: 'not found' });
  });

  it('an OLD server that never answers times out instead of hanging the turn', async () => {
    vi.useFakeTimers();
    const r = new AttachmentRequester({ send: () => true, timeoutMs: 1000 });
    const p = r.fetch('x.png');
    vi.advanceTimersByTime(1001);
    const got = await p;
    expect(got.ok).toBe(false);
    expect(!got.ok && got.reason).toMatch(/did not send it within 1s/);
  });

  it('no socket = an immediate refusal, not a wait', async () => {
    const r = new AttachmentRequester({ send: () => false });
    expect(await r.fetch('x.png')).toEqual({
      ok: false,
      reason: 'not connected to the muxpad server',
    });
  });
});
