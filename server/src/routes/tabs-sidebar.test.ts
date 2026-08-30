// The living sidebar at the HTTP seam: GET /api/tabs ordering (pinned block
// in manual order, then blocked/attention → recency), PATCH pinned, and the
// fields the client needs to draw the divider.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Tab } from '@muxpad/shared';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../store/db.js';
import { TabActivity } from '../tab-activity.js';
import { type TestApp, createTestApp } from '../test-helpers/createTestApp.js';

describe('living sidebar — tab ordering + pinning', () => {
  let test: TestApp;
  let db: Database.Database;
  let wsId: string;
  let tmp: string;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'muxpad-sidebar-'));
    db = openDb(':memory:');
    test = await createTestApp({ db, dataDir: tmp });
    const ws = (await (
      await test.app.request('/api/workspaces', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'W' }),
      })
    ).json()) as { id: string };
    wsId = ws.id;
  });

  afterEach(async () => {
    await test.cleanup();
    rmSync(tmp, { recursive: true, force: true });
  });

  const json = (body: unknown) => ({
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  async function makeTab(name: string): Promise<Tab> {
    return (await (
      await test.app.request('/api/tabs', { method: 'POST', ...json({ workspace_id: wsId, name }) })
    ).json()) as Tab;
  }
  const list = async () =>
    (await (await test.app.request(`/api/tabs?workspaceId=${wsId}`)).json()) as Tab[];
  const names = async () => (await list()).map((t) => t.name);
  /** Write last_activity_at directly — the ordering input, whatever produced it. */
  const setActivity = (id: string, at: number | null) =>
    db.prepare('UPDATE tabs SET last_activity_at = ? WHERE id = ?').run(at, id);

  it('exposes pinned + last_activity_at on every listed tab', async () => {
    const t = await makeTab('A');
    const [row] = await list();
    expect(row?.pinned).toBe(false);
    // A brand-new tab is stamped: it IS the most recent thing you did.
    expect(typeof row?.last_activity_at).toBe('number');
    expect(row?.id).toBe(t.id);
  });

  it('orders the unpinned block by recency, most recent first', async () => {
    const a = await makeTab('A');
    const b = await makeTab('B');
    const c = await makeTab('C');
    setActivity(a.id, 300);
    setActivity(b.id, 100);
    setActivity(c.id, 200);
    expect(await names()).toEqual(['A', 'C', 'B']);
  });

  it('a working tab does NOT jump the queue — it lights its status mark instead', async () => {
    // Busy is no longer a sort key. It was the same signal encoded twice (glyph
    // AND position), so a tab that went to work shuffled up the list under your
    // cursor and dropped back when it went quiet. This asserts the LIVE wiring
    // of the replacement: the order holds, and the row reports `working` +
    // its subagent count so the rail can say it in place.
    const a = await makeTab('A'); // much more recent, idle
    const b = await makeTab('B'); // ancient, and about to start working
    setActivity(a.id, 9999);
    setActivity(b.id, 1);
    const bp = (
      (await (
        await test.app.request(`/api/tabs/${b.id}/panes`, { method: 'POST', ...json({}) })
      ).json()) as { id: string }
    ).id;
    expect(await names()).toEqual(['A', 'B']);

    test.cache.setAgentBusy(bp, true);
    expect(await names()).toEqual(['A', 'B']); // order unchanged — this is the fix
    const rows = (await (await test.app.request(`/api/tabs?workspaceId=${wsId}`)).json()) as Array<{
      name: string;
      status?: string;
      busy?: boolean;
      agents?: number;
    }>;
    const bRow = rows.find((t) => t.name === 'B');
    expect(bRow).toMatchObject({ status: 'working', busy: true, agents: 0 });

    // A background subagent keeps the tab working past turn-done, with a count.
    test.cache.setAgentBusy(bp, false);
    test.cache.setSubagentCount(bp, 2);
    const rows2 = (await (
      await test.app.request(`/api/tabs?workspaceId=${wsId}`)
    ).json()) as Array<{ name: string; status?: string; agents?: number }>;
    expect(rows2.find((t) => t.name === 'B')).toMatchObject({ status: 'working', agents: 2 });

    test.cache.setSubagentCount(bp, 0);
    expect(await names()).toEqual(['A', 'B']);
  });

  it('null last_activity_at (a migrated row) sinks below every known timestamp', async () => {
    const a = await makeTab('A');
    const b = await makeTab('B');
    setActivity(a.id, null);
    setActivity(b.id, 1);
    expect(await names()).toEqual(['B', 'A']);
  });

  it('the order is stable across repeated identical reads (no sidebar jitter)', async () => {
    const a = await makeTab('A');
    const b = await makeTab('B');
    const c = await makeTab('C');
    // Deliberately IDENTICAL on every signal — the tiebreak must be total.
    for (const t of [a, b, c]) setActivity(t.id, 500);
    const first = await names();
    for (let i = 0; i < 5; i++) expect(await names()).toEqual(first);
  });

  it('pinned tabs lead, in their manual order, ahead of a more recent unpinned one', async () => {
    const a = await makeTab('A');
    const b = await makeTab('B');
    const c = await makeTab('C');
    setActivity(a.id, 1);
    setActivity(b.id, 2);
    setActivity(c.id, 9999); // by recency C would lead
    await test.app.request(`/api/tabs/${b.id}`, { method: 'PATCH', ...json({ pinned: true }) });
    await test.app.request(`/api/tabs/${a.id}`, { method: 'PATCH', ...json({ pinned: true }) });
    // B was pinned first → it holds the first pinned slot (append semantics).
    expect(await names()).toEqual(['B', 'A', 'C']);
  });

  it('reorder rewrites the pinned block’s manual order', async () => {
    const a = await makeTab('A');
    const b = await makeTab('B');
    for (const t of [a, b]) {
      await test.app.request(`/api/tabs/${t.id}`, { method: 'PATCH', ...json({ pinned: true }) });
    }
    expect(await names()).toEqual(['A', 'B']);
    await test.app.request('/api/tabs/reorder', {
      method: 'POST',
      ...json({ ids: [b.id, a.id] }),
    });
    expect(await names()).toEqual(['B', 'A']);
  });

  it('a pinned tab is NOT re-sorted by attention/busy/recency', async () => {
    const a = await makeTab('A');
    const b = await makeTab('B');
    await test.app.request(`/api/tabs/${a.id}`, { method: 'PATCH', ...json({ pinned: true }) });
    setActivity(a.id, 1); // ancient
    setActivity(b.id, 9999); // fresh
    expect(await names()).toEqual(['A', 'B']);
  });

  it('unpinning returns the tab to the auto-sorted block', async () => {
    const a = await makeTab('A');
    const b = await makeTab('B');
    setActivity(a.id, 1);
    setActivity(b.id, 2);
    await test.app.request(`/api/tabs/${a.id}`, { method: 'PATCH', ...json({ pinned: true }) });
    expect(await names()).toEqual(['A', 'B']);
    await test.app.request(`/api/tabs/${a.id}`, { method: 'PATCH', ...json({ pinned: false }) });
    expect(await names()).toEqual(['B', 'A']);
  });

  it('PATCH pinned returns the fresh tab and 404s on an unknown id', async () => {
    const a = await makeTab('A');
    const res = await test.app.request(`/api/tabs/${a.id}`, {
      method: 'PATCH',
      ...json({ pinned: true }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as Tab).toMatchObject({ id: a.id, pinned: true });
    const missing = await test.app.request('/api/tabs/nope', {
      method: 'PATCH',
      ...json({ pinned: true }),
    });
    expect(missing.status).toBe(404);
  });

  it('pinning alongside a rename in one PATCH applies both', async () => {
    const a = await makeTab('A');
    const res = await test.app.request(`/api/tabs/${a.id}`, {
      method: 'PATCH',
      ...json({ pinned: true, name: 'Renamed' }),
    });
    expect((await res.json()) as Tab).toMatchObject({ name: 'Renamed', pinned: true });
  });

  it('deleting a tab drops its activity memo (the recorder is actually wired)', async () => {
    // Regression: TabActivity.forget existed but had no call site, so the
    // throttle map grew one permanent entry per tab ever touched. Assert the
    // wiring rather than the map: after a delete, a fresh tab reusing the
    // recorder must not be silently throttled by a stale entry.
    const forgotten: string[] = [];
    const db2 = openDb(':memory:');
    const recorder = new TabActivity(db2);
    const realForget = recorder.forget.bind(recorder);
    recorder.forget = (id: string) => {
      forgotten.push(id);
      realForget(id);
    };
    const t2 = await createTestApp({ db: db2, dataDir: tmp, tabActivity: recorder });
    try {
      const ws2 = (await (
        await t2.app.request('/api/workspaces', { method: 'POST', ...json({ name: 'W' }) })
      ).json()) as { id: string };
      const tab = (await (
        await t2.app.request('/api/tabs', {
          method: 'POST',
          ...json({ workspace_id: ws2.id, name: 'Doomed' }),
        })
      ).json()) as Tab;
      const res = await t2.app.request(`/api/tabs/${tab.id}`, { method: 'DELETE' });
      expect(res.status).toBe(204);
      expect(forgotten).toContain(tab.id);
    } finally {
      await t2.cleanup();
    }
  });

  it('pinning does not disturb the OTHER workspace’s ordering', async () => {
    const other = (await (
      await test.app.request('/api/workspaces', { method: 'POST', ...json({ name: 'W2' }) })
    ).json()) as { id: string };
    const x = (await (
      await test.app.request('/api/tabs', {
        method: 'POST',
        ...json({ workspace_id: other.id, name: 'X' }),
      })
    ).json()) as Tab;
    const a = await makeTab('A');
    await test.app.request(`/api/tabs/${a.id}`, { method: 'PATCH', ...json({ pinned: true }) });
    const otherList = (await (
      await test.app.request(`/api/tabs?workspaceId=${other.id}`)
    ).json()) as Tab[];
    expect(otherList.map((t) => t.id)).toEqual([x.id]);
    expect(otherList[0]?.pinned).toBe(false);
  });
});
