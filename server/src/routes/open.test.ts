import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MuxpadEvent } from '@muxpad/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventBus } from '../events.js';
import { openDb } from '../store/db.js';
import { type TestApp, createTestApp } from '../test-helpers/createTestApp.js';

describe('open routes', () => {
  let test: TestApp;
  let tmp: string;
  let events: EventBus;
  let received: MuxpadEvent[];

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'muxpad-open-'));
    events = new EventBus();
    received = [];
    events.subscribe((e) => {
      received.push(e);
    });
    test = await createTestApp({ db: openDb(':memory:'), dataDir: tmp, events });
  });

  afterEach(async () => {
    await test.cleanup();
    rmSync(tmp, { recursive: true, force: true });
  });

  const post = (body: unknown) =>
    test.app.request('/api/open/external', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('emits external_url.open and returns 202', async () => {
    const res = await post({ url: 'https://example.com' });
    expect(res.status).toBe(202);
    expect(received).toEqual([{ type: 'external_url.open', url: 'https://example.com' }]);
  });

  it('passes tab_id and pane_id through verbatim', async () => {
    const res = await post({
      url: 'https://example.com',
      tab_id: 'tab_abc',
      pane_id: 'pane_xyz',
    });
    expect(res.status).toBe(202);
    expect(received).toEqual([
      {
        type: 'external_url.open',
        url: 'https://example.com',
        tab_id: 'tab_abc',
        pane_id: 'pane_xyz',
      },
    ]);
  });

  it('rejects empty url', async () => {
    const res = await post({ url: '' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(received).toEqual([]);
  });

  it('rejects missing url', async () => {
    const res = await post({});
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(received).toEqual([]);
  });

  it.each([
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///etc/passwd',
    'about:blank',
    'not a url at all',
  ])('rejects unsafe / non-allowlisted scheme: %s', async (url) => {
    const res = await post({ url });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(received).toEqual([]);
  });

  it.each(['http://example.com', 'https://example.com/path', 'mailto:foo@bar.com'])(
    'accepts allowlisted scheme: %s',
    async (url) => {
      const res = await post({ url });
      expect(res.status).toBe(202);
      expect(received).toEqual([{ type: 'external_url.open', url }]);
    },
  );
});
