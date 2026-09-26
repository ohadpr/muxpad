import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHAT_DECAY_MS, DAY_MS, type MuxpadEvent, type Tab } from '@muxpad/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventBus } from '../events.js';
import { PaneStore } from '../store/PaneStore.js';
import { TabStore } from '../store/TabStore.js';
import { openDb } from '../store/db.js';
import { type TestApp, createTestApp } from '../test-helpers/createTestApp.js';

/**
 * The CLOCK as the rest of the world sees it: on the decorated tab row, from
 * the server, always — so the sidebar, the `@` picker and anything else render
 * one lifecycle instead of three re-derivations of it.
 */
describe('the chat clock on the wire', () => {
  let test: TestApp;
  let tmp: string;
  let db: ReturnType<typeof openDb>;
  let events: EventBus;
  let tabs: TabStore;
  let wsId: string;

  async function post(path: string, body: unknown): Promise<Response> {
    return test.app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  async function listTabs(): Promise<Tab[]> {
    return (await (await test.app.request(`/api/tabs?workspaceId=${wsId}`)).json()) as Tab[];
  }

  async function newTab(name: string, extra: Record<string, unknown> = {}): Promise<Tab> {
    return (await (await post('/api/tabs', { name, workspace_id: wsId, ...extra })).json()) as Tab;
  }

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'muxpad-clock-'));
    db = openDb(':memory:');
    events = new EventBus();
    test = await createTestApp({ db, dataDir: tmp, events });
    tabs = new TabStore(db);
    const ws = (await (await post('/api/workspaces', { name: 'W' })).json()) as { id: string };
    wsId = ws.id;
  });

  afterEach(async () => {
    await test.cleanup();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('publishes done and the clock on every listed row', async () => {
    const fresh = await newTab('fresh');
    const old = await newTab('old');
    tabs.resetClock(old.id, Date.now() - 2 * DAY_MS);

    const rows = await listTabs();
    const f = rows.find((r) => r.id === fresh.id) as Tab;
    const o = rows.find((r) => r.id === old.id) as Tab;

    expect(f.done).toBe(false);
    expect(f.clock?.fill).toBeLessThan(0.01);
    expect(f.clock?.expires_at).toBeGreaterThan(Date.now());
    expect(o.clock?.fill).toBeCloseTo(0.5, 1);
    expect(o.clock?.last_day).toBe(false);
  });

  it('sends done and clock even when nothing is wrong, so coalescing cannot strand them', async () => {
    // Clients merge `tab.updated` onto the row they hold. A field omitted when
    // false would leave a stale `done: true` sitting there forever after a
    // revival — the chat would be live and invisible. Presence, not just
    // value, is the contract.
    const t = await newTab('fresh');
    const seen: Tab[] = [];
    events.subscribe((e: MuxpadEvent) => {
      if (e.type === 'tab.updated') seen.push(e.tab);
    });
    await test.app.request(`/api/tabs/${t.id}/unread`, { method: 'POST' });
    const row = seen[0] as Tab;
    expect('done' in row).toBe(true);
    expect(row.done).toBe(false);
    expect('clock' in row).toBe(true);
    expect((await listTabs()).every((r) => 'done' in r && 'clock' in r)).toBe(true);
  });

  it('marks a chat done once its clock has run out', async () => {
    const t = await newTab('gone');
    tabs.resetClock(t.id, Date.now() - CHAT_DECAY_MS - 1_000);
    const row = (await listTabs()).find((r) => r.id === t.id) as Tab;
    expect(row.done).toBe(true);
    // It is still THERE. Nothing is ever deleted — `done` is where it renders,
    // not whether it exists.
    expect(row.name).toBe('gone');
  });

  it('a pinned chat publishes a stopped clock and is never done', async () => {
    const t = await newTab('kept');
    tabs.resetClock(t.id, Date.now() - 40 * DAY_MS);
    await test.app.request(`/api/tabs/${t.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pinned: true }),
    });
    const row = (await listTabs()).find((r) => r.id === t.id) as Tab;
    expect(row.done).toBe(false);
    expect(row.clock?.stopped).toBe(true);
    expect(row.clock?.expires_at).toBeNull();
  });

  it('a tab.updated carries the same lifecycle the list does', async () => {
    // Every emitter routes through decorateTab for exactly this reason: a
    // hand-built payload blanks the fields on the client until the next poll.
    const t = await newTab('x');
    tabs.resetClock(t.id, Date.now() - CHAT_DECAY_MS - 1_000);
    const seen: Tab[] = [];
    events.subscribe((e: MuxpadEvent) => {
      if (e.type === 'tab.updated') seen.push(e.tab);
    });
    await test.app.request(`/api/tabs/${t.id}/unread`, { method: 'POST' });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.done).toBe(true);
    expect(seen[0]?.clock?.fill).toBe(1);
  });

  it('the single-tab read carries the same lifecycle as the list', async () => {
    // A client that merges this response over a decorated row would otherwise
    // blank both fields — the shape of bug this whole "compute it server-side"
    // rule exists to prevent.
    const t = await newTab('x');
    tabs.resetClock(t.id, Date.now() - CHAT_DECAY_MS - 1_000);
    const one = (await (await test.app.request(`/api/tabs/${t.id}`)).json()) as Tab;
    const listed = (await listTabs()).find((r) => r.id === t.id) as Tab;
    expect(one.done).toBe(true);
    expect(one.done).toBe(listed.done);
    expect(one.clock?.started_at).toBe(listed.clock?.started_at);
  });

  describe('spawned_by', () => {
    it('records the parent tab and shares its clock', async () => {
      const parent = await newTab('parent');
      tabs.resetClock(parent.id, Date.now() - 3 * DAY_MS);
      const child = await newTab('child', { spawned_by: parent.id });
      expect(child.spawned_by).toBe(parent.id);

      const rows = await listTabs();
      const p = rows.find((r) => r.id === parent.id) as Tab;
      const c = rows.find((r) => r.id === child.id) as Tab;
      expect(c.clock?.started_at).toBe(p.clock?.started_at);
      expect(c.clock?.last_day).toBe(true);
    });

    it('accepts a PANE id, for anything spawning from inside one', async () => {
      // The CLI knows $MUXPAD_PANE_ID and nothing else; making every such
      // caller do its own pane→tab lookup is how one of them ends up not
      // doing it.
      const parent = await newTab('parent');
      const pane = new PaneStore(db).create({
        tab_id: parent.id,
        shell: '/bin/zsh',
        cwd: '/tmp',
      });
      const child = await newTab('child', { spawned_by_pane: pane.id });
      expect(child.spawned_by).toBe(parent.id);
    });

    it('drops an unresolvable parent instead of refusing to spawn', async () => {
      // A worker must not fail to exist because the chat that asked for it has
      // since been deleted. It becomes a root with a clock of its own.
      const child = await newTab('child', { spawned_by: 'no-such-tab' });
      expect(child.spawned_by).toBeUndefined();
      const row = (await listTabs()).find((r) => r.id === child.id) as Tab;
      expect(row.done).toBe(false);
    });

    it('is absent, not null, for the ordinary hand-made chat', async () => {
      const t = await newTab('plain');
      expect('spawned_by' in t).toBe(false);
    });
  });
});
