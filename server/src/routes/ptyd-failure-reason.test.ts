// When a pane will not start, SAY WHAT ACTUALLY WENT WRONG.
//
// Every one of these endpoints used to answer "ptyd is unreachable" for any
// failure at all, having thrown the real error away with a bare `catch {}`. That
// message was false in the one case that mattered: with the pty table full —
// macOS caps /dev/ptmx handles at kern.tty.ptmx_max, 511 here — ptyd is
// perfectly reachable and simply cannot make another pty. The day that happened,
// every surface on the machine blamed a healthy daemon and hours went into it
// before anyone counted descriptors. The first true line printed afterwards was
// "posix_spawnp failed".
//
// So: the 503 and its `code` stay (a client still needs "could not start, retry
// later"), but the MESSAGE has to carry what threw.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../store/db.js';
import { type TestApp, createTestApp } from '../test-helpers/createTestApp.js';

describe('a pane that will not start reports the real reason', () => {
  let test: TestApp;
  let db: Database.Database;
  let tmp: string;
  /** A shell pane — what respawn and cwd act on. */
  let paneId: string;
  /** A Chat pane with no messages — what the conversion endpoints act on. */
  let chatId: string;

  // What node-pty actually throws once the table is full. Not a connection error.
  const PTY_TABLE_FULL = 'posix_spawnp failed.';

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'muxpad-ptyd-reason-'));
    db = openDb(':memory:');
    test = await createTestApp({ db, dataDir: tmp });
    const ws = (await (
      await test.app.request('/api/workspaces', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'W' }),
      })
    ).json()) as { id: string };
    const tab = (await (
      await test.app.request('/api/tabs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspace_id: ws.id, bootstrap: 'shell' }),
      })
    ).json()) as { id: string };
    const detail = (await (await test.app.request(`/api/tabs/${tab.id}`)).json()) as {
      panes: { id: string }[];
    };
    const first = detail.panes[0];
    if (!first) throw new Error('a shell tab should bootstrap with one pane');
    paneId = first.id;

    // agent-backend and as-terminal are CONVERSIONS: they refuse a shell pane
    // with a 409 long before they ask for a pty. Give them a fresh Chat pane,
    // which is what the UI offers them on.
    const chatTab = (await (
      await test.app.request('/api/tabs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workspace_id: ws.id,
          bootstrap: 'agent',
          backend: 'claude',
          mode: 'chat',
        }),
      })
    ).json()) as { id: string };
    const chatDetail = (await (await test.app.request(`/api/tabs/${chatTab.id}`)).json()) as {
      panes: { id: string }[];
    };
    const chatPane = chatDetail.panes[0];
    if (!chatPane) throw new Error('an agent tab should bootstrap with one pane');
    chatId = chatPane.id;

    // ptyd is REACHABLE and answering. It just cannot make another pty.
    test.ptyd.client.ensurePane = async () => {
      throw new Error(PTY_TABLE_FULL);
    };
  });

  afterEach(async () => {
    await test.cleanup();
    rmSync(tmp, { recursive: true, force: true });
  });

  const post = async (path: string, body?: unknown): Promise<Response> =>
    await test.app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  const cases: [string, () => Promise<Response>][] = [
    ['respawn', () => post(`/api/panes/${paneId}/respawn`)],
    ['agent-backend', () => post(`/api/panes/${chatId}/agent-backend`, { backend: 'codex' })],
    ['as-terminal', () => post(`/api/panes/${chatId}/as-terminal`)],
    ['cwd', () => post(`/api/panes/${paneId}/cwd`, { cwd: tmp })],
  ];

  for (const [name, call] of cases) {
    it(`${name} carries what threw, and does not claim ptyd is unreachable`, async () => {
      const res = await call();
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: { code: string; message: string } };
      // Still a "try again" for the client.
      expect(body.error.code).toBe('ptyd_unavailable');
      // The real reason is in the message.
      expect(body.error.message).toContain(PTY_TABLE_FULL);
      // And it must not assert a thing it did not check.
      expect(body.error.message).not.toMatch(/unreachable/i);
    });
  }
});
