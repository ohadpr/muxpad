import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_TRANSCRIPT_CHARS } from '../chat/clean-transcript.js';
import { openDb } from '../store/db.js';
import { cleanTranscriptRoutes } from './clean-transcript.js';

// The model is stubbed in every case — this suite never reaches the network.

describe('POST /api/clean-transcript', () => {
  let db: Database.Database;
  let dataDir: string;

  beforeEach(() => {
    db = openDb(':memory:');
    dataDir = mkdtempSync(join(tmpdir(), 'clean-route-'));
  });
  afterEach(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const mount = (model: (p: string, s: AbortSignal) => Promise<string>) =>
    cleanTranscriptRoutes({ db, dataDir, model });

  const post = (app: ReturnType<typeof mount>, body: unknown) =>
    app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });

  it('returns the corrected text and flags that it changed', async () => {
    const app = mount(async () => 'check the cron schedule on muxpad');
    const res = await post(app, { text: 'check the crown schedule on Max pad' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: 'check the cron schedule on muxpad', changed: true });
  });

  it('reports changed:false when the model found nothing to fix', async () => {
    const text = 'this sentence was transcribed correctly';
    const app = mount(async () => text);
    const res = await post(app, { text });
    expect(await res.json()).toEqual({ text, changed: false });
  });

  it('sends the live glossary to the model', async () => {
    db.prepare(
      'INSERT INTO workspaces (id, slug, name, position, created_at, updated_at) VALUES (?,?,?,0,0,0)',
    ).run('w1', 'w1', 'Acme GTM');
    const model = vi.fn().mockResolvedValue('the Acme GTM workspace is here');
    const res = await post(mount(model), { text: 'the academy go to market workspace is here' });
    expect(res.status).toBe(200);
    expect(model.mock.calls[0]?.[0]).toContain('Acme GTM');
    // Static vocabulary rides along too.
    expect(model.mock.calls[0]?.[0]).toContain('ptyd');
  });

  it('builds the glossary once for a burst of requests', async () => {
    const model = vi.fn().mockResolvedValue('cleaned up text here');
    const app = cleanTranscriptRoutes({ db, dataDir, model, glossaryTtlMs: 60_000 });
    const spy = vi.spyOn(db, 'prepare');
    for (let i = 0; i < 5; i++) await post(app, { text: 'some dictated text here' });
    // Whatever the per-build query count is, five requests must not multiply it.
    const firstBuild = spy.mock.calls.length;
    expect(firstBuild).toBeGreaterThan(0);
    for (let i = 0; i < 5; i++) await post(app, { text: 'some dictated text here' });
    expect(spy.mock.calls.length).toBe(firstBuild);
    spy.mockRestore();
  });

  // ── Failure paths. None of these may answer 200 with the input echoed back.

  it('400s on empty text', async () => {
    const model = vi.fn();
    const res = await post(mount(model), { text: '   ' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('bad_request');
    expect(model).not.toHaveBeenCalled();
  });

  it('400s on a missing text field', async () => {
    const res = await post(mount(vi.fn()), {});
    expect(res.status).toBe(400);
  });

  it('400s on a body that is not JSON', async () => {
    const res = await post(mount(vi.fn()), 'not json at all');
    expect(res.status).toBe(400);
  });

  it('413s on oversized input, without calling the model', async () => {
    const model = vi.fn();
    const res = await post(mount(model), { text: 'x'.repeat(MAX_TRANSCRIPT_CHARS + 1) });
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('too_large');
    expect(model).not.toHaveBeenCalled();
  });

  it('502s when the model is unreachable — it does not echo the input', async () => {
    const res = await post(
      mount(async () => {
        throw new Error('spawn claude ENOENT');
      }),
      { text: 'check the crown schedule on Max pad' },
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string }; text?: string };
    expect(body.error.code).toBe('unavailable');
    expect(body.text).toBeUndefined();
  });

  it('502s when the model returns nothing', async () => {
    const res = await post(
      mount(async () => ''),
      { text: 'check the crown schedule on Max pad' },
    );
    expect(res.status).toBe(502);
  });

  it('502s when the model answers the message instead of correcting it', async () => {
    const res = await post(
      mount(
        async () =>
          'Certainly! A cron schedule is a time specification. Here is how it works, in detail, with several examples that go well beyond what you asked for.',
      ),
      { text: 'check the crown schedule' },
    );
    expect(res.status).toBe(502);
  });
});
