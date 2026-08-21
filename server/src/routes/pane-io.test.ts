import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../store/db.js';
import { type TestApp, createTestApp } from '../test-helpers/createTestApp.js';
import { stripScrollback } from './pane-io.js';

describe('stripScrollback', () => {
  it('strips CSI color/cursor sequences', () => {
    expect(stripScrollback('\x1b[32mgreen\x1b[0m plain \x1b[2J\x1b[H')).toBe('green plain ');
  });

  it('strips OSC sequences (BEL- and ST-terminated)', () => {
    expect(stripScrollback('\x1b]0;window title\x07after')).toBe('after');
    expect(stripScrollback('\x1b]7771;muxpad;app;url=http://x\x1b\\after')).toBe('after');
  });

  it('emulates carriage-return overwrite (progress bars)', () => {
    expect(stripScrollback('10%\r20%\r100%\ndone')).toBe('100%\ndone');
    // Trailing bare \r keeps the prior text rather than blanking the line.
    expect(stripScrollback('progress\r\ndone')).toBe('progress\ndone');
  });

  it('keeps newlines and tabs, drops other control chars', () => {
    expect(stripScrollback('a\tb\nc\x07d\x00e')).toBe('a\tb\ncde');
  });
});

describe('pane io routes', () => {
  let test: TestApp;
  let tabId: string;
  let tmp: string;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'muxpad-pane-io-'));
    test = await createTestApp({ db: openDb(':memory:'), dataDir: tmp });
    const ws = (await (
      await test.app.request('/api/workspaces', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'W' }),
      })
    ).json()) as { id: string };
    const t = (await (
      await test.app.request('/api/tabs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'T', workspace_id: ws.id }),
      })
    ).json()) as { id: string };
    tabId = t.id;
  });

  afterEach(async () => {
    await test.cleanup();
    rmSync(tmp, { recursive: true, force: true });
  });

  const createPane = async (body: Record<string, unknown> = {}) =>
    (await (
      await test.app.request(`/api/tabs/${tabId}/panes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ shell: '/bin/sh', ...body }),
      })
    ).json()) as { id: string };

  const readScrollback = async (id: string, qs = '') => {
    const res = await test.app.request(`/api/panes/${id}/scrollback${qs}`);
    return { status: res.status, text: await res.text() };
  };

  /** Poll scrollback until it contains `needle` (PTY spawn/echo is async). */
  const waitForScrollback = async (id: string, needle: string, timeoutMs = 8000) => {
    const deadline = Date.now() + timeoutMs;
    let last = '';
    for (;;) {
      const { status, text } = await readScrollback(id);
      if (status === 200) last = text;
      if (last.includes(needle)) return last;
      if (Date.now() > deadline) {
        throw new Error(`scrollback never contained ${JSON.stringify(needle)}; last: ${last}`);
      }
      await new Promise((r) => setTimeout(r, 150));
    }
  };

  const sendInput = (id: string, body: unknown) =>
    test.app.request(`/api/panes/${id}/input`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('reads a pane scrollback via WS attach', async () => {
    const p = await createPane({ startup_cmd: 'echo muxpad-replay-marker' });
    const text = await waitForScrollback(p.id, 'muxpad-replay-marker');
    // ANSI-stripped by default: no escape bytes survive.
    expect(text).not.toContain('\x1b');
  }, 15000);

  it('trims to the last N lines with ?lines=', async () => {
    const p = await createPane({ startup_cmd: 'printf "one\\ntwo\\nthree\\n"' });
    await waitForScrollback(p.id, 'three');
    const { text } = await readScrollback(p.id, '?lines=1');
    expect(text.split('\n').length).toBe(1);
  }, 15000);

  it('keeps escapes with ?raw=1', async () => {
    const p = await createPane({ startup_cmd: 'printf "\\033[32mgreen\\033[0m\\n"' });
    await waitForScrollback(p.id, 'green');
    const { text } = await readScrollback(p.id, '?raw=1');
    expect(text).toContain('\x1b[32m');
  }, 15000);

  it('404s scrollback for a missing pane', async () => {
    const { status } = await readScrollback('nope');
    expect(status).toBe(404);
  });

  it('rejects scrollback with a bad lines param', async () => {
    const p = await createPane();
    const { status } = await readScrollback(p.id, '?lines=zero');
    expect(status).toBe(400);
  });

  it('injects text input that reaches the shell', async () => {
    const p = await createPane();
    const res = await sendInput(p.id, { text: 'echo muxpad-input-marker', enter: true });
    expect(res.status).toBe(204);
    // The echoed command AND its output both land in scrollback; assert on
    // the output line produced by the shell running it.
    await waitForScrollback(p.id, 'muxpad-input-marker');
  }, 15000);

  it('accepts named keys', async () => {
    const p = await createPane();
    const res = await sendInput(p.id, { keys: ['ctrl-c', 'enter'] });
    expect(res.status).toBe(204);
  });

  it('rejects unknown named keys', async () => {
    const p = await createPane();
    const res = await sendInput(p.id, { keys: ['ctrl-c', 'meta-x'] });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain('meta-x');
  });

  it('rejects text+keys together and an empty body', async () => {
    const p = await createPane();
    expect((await sendInput(p.id, { text: 'x', keys: ['enter'] })).status).toBe(400);
    expect((await sendInput(p.id, {})).status).toBe(400);
  });

  it('400s input when the pane has no live pty', async () => {
    const p = await createPane();
    await test.ptyd.client.killPane(p.id);
    const res = await sendInput(p.id, { text: 'rm -rf /', enter: true });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain('no live pty');
  });

  it('400s input for a url pane, 404s for a missing pane', async () => {
    const url = (await (
      await test.app.request(`/api/tabs/${tabId}/panes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'url', url: 'http://example.com' }),
      })
    ).json()) as { id: string };
    expect((await sendInput(url.id, { text: 'x' })).status).toBe(400);
    expect((await sendInput('nope', { text: 'x' })).status).toBe(404);
  });

  it('a headless scrollback read does not disturb another attached client', async () => {
    // Simulate the real browser: a second pty client attached for the whole
    // duration of a scrollback read must stay open and keep receiving output.
    const { default: WebSocket } = await import('ws');
    const p = await createPane();
    const browser = new WebSocket(`ws+unix://${test.ptyd.socketPath}:/pty/${p.id}`);
    browser.binaryType = 'nodebuffer';
    await new Promise<void>((resolve, reject) => {
      browser.once('open', () => resolve());
      browser.once('error', reject);
    });
    let closed = false;
    browser.on('close', () => {
      closed = true;
    });
    const { status } = await readScrollback(p.id);
    expect(status).toBe(200);
    // Inject input; the still-attached client must see the live output.
    const got = new Promise<void>((resolve) => {
      browser.on('message', (data: Buffer) => {
        if (data.toString('utf8').includes('bystander-sees-this')) resolve();
      });
    });
    await sendInput(p.id, { text: 'echo bystander-sees-this', enter: true });
    await got;
    expect(closed).toBe(false);
    browser.close();
  }, 15000);
});
