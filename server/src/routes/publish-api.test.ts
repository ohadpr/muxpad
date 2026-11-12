import { readFileSync } from 'node:fs';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Funnel } from '../funnel.js';
import { openDb } from '../store/db.js';
import { type TestApp, createTestApp } from '../test-helpers/createTestApp.js';

/**
 * THE CLIENT'S TYPE AND THE ROUTE'S ANSWER, PINNED TO EACH OTHER.
 *
 * `web/src/api.ts` declared `GET /api/publish` as `{ items: [...] }`. The
 * route answers `{ publishes: [...] }`. Nothing caught it: `req<T>` CASTS the
 * response rather than parsing it, so TypeScript had nothing to disagree
 * with, and the drawer's own tests mock `listPublished`, so they agreed with
 * the mock instead of with the server.
 *
 * What the user got was the artifacts tab replaced by "Something went wrong!
 * Cannot read properties of undefined (reading 'find')", because
 * `live.items` was undefined.
 *
 * Same seam that bit the msgvault `/run` route, and the same fix: read the
 * CLIENT's expectation out of its own source and check the real route against
 * it. A field renamed on either side fails here.
 */
describe('GET /api/publish — the shape the web is written against', () => {
  let test: TestApp;
  let db: Database.Database;
  let dataDir: string;
  let srcDir: string;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'muxpad-publish-api-'));
    srcDir = mkdtempSync(join(tmpdir(), 'muxpad-publish-api-src-'));
    db = openDb(':memory:');
    const funnel: Funnel = {
      async ensure() {
        return { baseUrl: 'https://example.ts.net:8443' };
      },
    };
    test = await createTestApp({ db, dataDir, publish: { funnel } });
  });
  afterEach(async () => {
    await test.cleanup();
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(srcDir, { recursive: true, force: true });
  });

  /** The field names web/src/api.ts says this route returns. */
  function clientContract(): { array: string; row: string[] } {
    const src = readFileSync(join(__dirname, '../../../web/src/api.ts'), 'utf8');
    const at = src.indexOf('listPublished: () =>');
    expect(at, 'listPublished is gone — this test is about nothing').toBeGreaterThan(-1);
    const decl = src.slice(at, src.indexOf("'/api/publish'", at));
    // `publishes: {` … then one `name: type;` per line.
    const array = decl.match(/\n\s{6}(\w+):\s*\{/)?.[1] as string;
    const row = [...decl.matchAll(/\n\s{8}(\w+):/g)].map((m) => m[1] as string);
    return { array, row };
  }

  it('answers with the array the client destructures, under that exact name', async () => {
    const { array } = clientContract();
    const body = (await (await test.app.request('/api/publish')).json()) as Record<string, unknown>;
    expect(array, 'the client must name an array').toBeTruthy();
    expect(Array.isArray(body[array]), `the route answers with \`${array}\``).toBe(true);
  });

  it('names every field the drawer reads off a row', async () => {
    const { array, row } = clientContract();
    const dir = join(srcDir, 'site');
    mkdirSync(dir);
    writeFileSync(join(dir, 'index.html'), 'hello');
    const made = await test.app.request('/api/publish', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: dir, name: 'shape' }),
    });
    expect(made.status).toBe(201);

    const body = (await (await test.app.request('/api/publish')).json()) as Record<
      string,
      Array<Record<string, unknown>>
    >;
    const first = body[array]?.[0];
    expect(first, 'something was published, so something is listed').toBeDefined();
    expect(row.length, 'the client reads at least a slug and a url').toBeGreaterThan(1);
    for (const field of row) expect(first, field).toHaveProperty(field);
  });
});
