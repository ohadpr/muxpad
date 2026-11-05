import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChatActionStore } from '../store/ChatActionStore.js';
import { PaneStore } from '../store/PaneStore.js';
import { TabStore } from '../store/TabStore.js';
import { WorkspaceStore } from '../store/WorkspaceStore.js';
import { openDb } from '../store/db.js';
import { chatActionsRoutes } from './chat-actions.js';

let dir: string;
let db: ReturnType<typeof openDb>;
let app: Hono;
let pane: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'muxpad-actions-route-'));
  db = openDb(join(dir, 'db.sqlite'));
  const ws = new WorkspaceStore(db).create({ name: 'W' }).id;
  const tab = new TabStore(db).create({ name: 'T', layout: '', workspace_id: ws }).id;
  pane = new PaneStore(db).create({ tab_id: tab, shell: '/bin/zsh' }).id;
  app = chatActionsRoutes({ db });
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('GET /api/panes/:id/actions', () => {
  it('serves this chat’s acts, oldest first', async () => {
    const store = new ChatActionStore(db);
    store.record({ pane_id: pane, kind: 'slack.post', title: 'first', at: 1, ref: 'a' });
    store.record({ pane_id: pane, kind: 'slack.post', title: 'second', at: 2, ref: 'b' });
    const res = await app.request(`/${pane}/actions`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { actions: Array<{ title: string }> };
    expect(body.actions.map((a) => a.title)).toEqual(['first', 'second']);
  });

  it('is an empty list for a chat that has done nothing', async () => {
    const body = (await (await app.request(`/${pane}/actions`)).json()) as { actions: unknown[] };
    expect(body.actions).toEqual([]);
  });

  it('404s a pane that is gone — "nothing happened here" is a different fact', async () => {
    expect((await app.request('/ghost-pane/actions')).status).toBe(404);
  });

  it('is never cached: the whole point is learning the state by looking', async () => {
    const res = await app.request(`/${pane}/actions`);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('offers no way to WRITE one — a card is a record, not a claim', async () => {
    const res = await app.request(`/${pane}/actions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(404);
  });
});
