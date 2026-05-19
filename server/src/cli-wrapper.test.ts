import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { serve, type ServerType } from '@hono/node-server';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './server.js';
import { openDb } from './store/db.js';
import { EventBus } from './events.js';
import { WorkspaceStore } from './store/WorkspaceStore.js';
import { spawnPtyd, type SpawnedPtyd } from './test-helpers/spawnPtyd.js';
import { PtydCache } from './ptyd-cache.js';

const execFileAsync = promisify(execFile);

const MUXPAD_BIN = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'scripts',
  'muxpad',
);

/**
 * Boots a real HTTP server (not just Hono in-memory) so the bash
 * wrapper's curl calls hit it. One workspace round-trip end-to-end is
 * enough to prove the pipe; per-verb correctness is covered by the
 * route tests this wrapper is just a curl-shaped client for.
 */
describe('scripts/muxpad HTTP wrapper', () => {
  let server: ServerType;
  let port: number;
  let tmp: string;
  let ptyd: SpawnedPtyd;
  let workspaces: WorkspaceStore;

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'muxpad-cli-'));
    const db = openDb(':memory:');
    workspaces = new WorkspaceStore(db);
    ptyd = await spawnPtyd();
    const cache = new PtydCache();
    cache.attach(ptyd.client);
    const app = createApp({
      db,
      ptyd: ptyd.client,
      cache,
      dataDir: tmp,
      events: new EventBus(),
    });
    // serve() returns a node http server; bind to port 0 → kernel picks one.
    server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
    await new Promise<void>((r) => server.once('listening', () => r()));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no address');
    port = addr.port;
  });

  afterAll(async () => {
    await ptyd.cleanup();
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(tmp, { recursive: true, force: true });
  });

  it('workspace new returns the created id and persists in the server', async () => {
    const env = { ...process.env, MUXPAD_API_URL: `http://127.0.0.1:${port}` };
    const { stdout } = await execFileAsync(
      MUXPAD_BIN,
      ['workspace', 'new', '--name=test-from-cli'],
      { env, encoding: 'utf-8' },
    );
    // Server-generated ids are ULIDs (26 chars, Crockford base32). Extract
    // the first match and confirm the server has it.
    const idMatch = stdout.match(/[0-9A-HJKMNP-TV-Z]{26}/);
    expect(idMatch, `wrapper stdout did not contain a ULID:\n${stdout}`).not.toBeNull();
    const id = idMatch![0];
    const persisted = workspaces.getById(id);
    expect(persisted).not.toBeNull();
    expect(persisted!.name).toBe('test-from-cli');
  });

  it('--json emits raw server JSON', async () => {
    const env = { ...process.env, MUXPAD_API_URL: `http://127.0.0.1:${port}` };
    const { stdout } = await execFileAsync(
      MUXPAD_BIN,
      ['--json', 'workspace', 'new', '--name=json-cli'],
      { env, encoding: 'utf-8' },
    );
    // Must be parseable JSON with the fields we expect from POST /workspaces.
    const parsed = JSON.parse(stdout) as { id: string; name: string };
    expect(parsed.id).toMatch(/[0-9A-HJKMNP-TV-Z]{26}/);
    expect(parsed.name).toBe('json-cli');
    expect(workspaces.getById(parsed.id)).not.toBeNull();
  });
});
