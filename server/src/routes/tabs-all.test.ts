// GET /api/tabs/all — the one read behind the sidebar's search box.
//
// Live rows retain the same decoration and stored order as workspace navigation.
// Finished history is available on demand, not part of this hot response; a
// retired chat that still owns an unparked pane remains live work.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHAT_DECAY_MS, DAY_MS, type Tab } from '@muxpad/shared';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NodeStore } from '../store/NodeStore.js';
import { PaneStore } from '../store/PaneStore.js';
import { TabStore } from '../store/TabStore.js';
import { WorkspaceStore } from '../store/WorkspaceStore.js';
import { openDb } from '../store/db.js';
import { type TestApp, createTestApp } from '../test-helpers/createTestApp.js';

interface AllTabsBody {
  workspaces: Array<{ id: string; slug: string; name: string; tabs: Tab[] }>;
}

describe('GET /api/tabs/all — the cross-workspace search corpus', () => {
  let test: TestApp;
  let db: Database.Database;
  let tmp: string;

  const json = (body: unknown) => ({
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'muxpad-tabs-all-'));
    db = openDb(':memory:');
    test = await createTestApp({ db, dataDir: tmp });
    test.cache.runtimeInventoryTtlMs = 0;
  });

  afterEach(async () => {
    await test.cleanup();
    rmSync(tmp, { recursive: true, force: true });
  });

  async function makeWorkspace(name: string): Promise<{ id: string; slug: string }> {
    return (await (
      await test.app.request('/api/workspaces', { method: 'POST', ...json({ name }) })
    ).json()) as { id: string; slug: string };
  }
  async function makeTab(workspaceId: string, name: string): Promise<Tab> {
    return (await (
      await test.app.request('/api/tabs', {
        method: 'POST',
        ...json({ workspace_id: workspaceId, name }),
      })
    ).json()) as Tab;
  }
  /** A tab with the agent pane that makes it a CHAT — and therefore the only
   *  kind of row that carries a clock at all (tab-clock.ts `hasDecayClock`).
   *  Without one there is no lifecycle to compare between the two paths. */
  async function makeChat(workspaceId: string, name: string): Promise<Tab> {
    const tab = await makeTab(workspaceId, name);
    new PaneStore(db).create({ tab_id: tab.id, startup_cmd: 'muxpad agent', face: 'chat' });
    return tab;
  }
  const all = async (): Promise<AllTabsBody> =>
    (await (await test.app.request('/api/tabs/all')).json()) as AllTabsBody;

  it('answers an empty group list when there is nothing at all', async () => {
    expect(await all()).toEqual({ workspaces: [] });
  });

  it('groups every visible workspace with its name and slug', async () => {
    const a = await makeWorkspace('Alpha');
    const b = await makeWorkspace('Beta');
    await makeTab(a.id, 'one');
    await makeTab(b.id, 'two');
    const body = await all();
    expect(body.workspaces.map((w) => w.name)).toEqual(['Alpha', 'Beta']);
    // The slug is half the route a search result navigates to, which is the
    // whole reason the payload is grouped rather than a flat tab list.
    expect(body.workspaces[0]?.slug).toBe(a.slug);
    expect(body.workspaces.map((w) => w.tabs.map((t) => t.name))).toEqual([['one'], ['two']]);
  });

  it('lists a workspace with no tabs rather than dropping it', async () => {
    await makeWorkspace('Empty');
    const body = await all();
    expect(body.workspaces).toHaveLength(1);
    expect(body.workspaces[0]?.tabs).toEqual([]);
  });

  it('excludes the hidden system container — the navigator cannot reach it', async () => {
    const visible = await makeWorkspace('Visible');
    await makeTab(visible.id, 'reachable');
    const hidden = new WorkspaceStore(db).createHidden({ name: 'apps' });
    await makeTab(hidden.id, 'unreachable');
    const body = await all();
    expect(body.workspaces.map((w) => w.name)).toEqual(['Visible']);
    const names = body.workspaces.flatMap((w) => w.tabs.map((t) => t.name));
    expect(names).not.toContain('unreachable');
  });

  it('decorates rows exactly like the per-workspace list, in the same order', async () => {
    const ws = await makeWorkspace('W');
    const a = await makeChat(ws.id, 'A');
    const b = await makeChat(ws.id, 'B');
    const c = await makeChat(ws.id, 'C');
    db.prepare('UPDATE tabs SET last_activity_at = ?, last_user_at = ? WHERE id = ?').run(
      1,
      1,
      a.id,
    );
    db.prepare('UPDATE tabs SET last_activity_at = ?, last_user_at = ? WHERE id = ?').run(
      9999,
      9999,
      b.id,
    );
    db.prepare('UPDATE tabs SET last_activity_at = ?, last_user_at = ? WHERE id = ?').run(
      500,
      500,
      c.id,
    );
    // Three ages, so the comparison is over rows that are genuinely at
    // different points in their lives rather than three copies of "fresh".
    new TabStore(db).resetClock(a.id, Date.now() - 2 * DAY_MS);
    new TabStore(db).resetClock(b.id, Date.now() - (CHAT_DECAY_MS - 3600_000));
    await test.app.request(`/api/tabs/${c.id}`, { method: 'PATCH', ...json({ pinned: true }) });

    // ONE instant for both requests. `clock.fill` is CONTINUOUS in `now` by
    // design (shared/chat-clock.ts: the server must not be the thing that
    // makes a continuous visual jump), so two reads a millisecond apart
    // legitimately differ in the ninth decimal place — which is not the two
    // paths disagreeing, it is time passing between them. Freezing the clock
    // is what lets this stay an exact `toEqual` over every field, `fill`
    // included, instead of an approximate comparison that would stop
    // noticing a real divergence.
    const frozen = Date.now();
    const realNow = Date.now;
    Date.now = () => frozen;
    try {
      const perWorkspace = (await (
        await test.app.request(`/api/tabs?workspaceId=${ws.id}`)
      ).json()) as Tab[];
      const grouped = (await all()).workspaces[0]?.tabs ?? [];
      // Byte-identical, not merely "same set": the search list and the tree are
      // two renderings of one server-owned order, and a disagreement between
      // them is a result row that jumps when you land on it.
      expect(grouped).toEqual(perWorkspace);
      expect(grouped.map((t) => t.name)).toEqual([
        'C', // pinned — pins lead, whatever their age
        // Then the STORED order, which nothing in this fixture can move. A
        // new chat is created at the top of the unpinned block, so B (made
        // second) is above A.
        //
        // Every timestamp set above is here to prove it changes nothing:
        // `last_activity_at` says B=9999 A=1, and `resetClock` says A was
        // touched two days ago and B nearly a decay window ago. Two
        // conflicting claims about recency, and neither decides the order any
        // more — which is the whole point of the change.
        'B',
        'A',
      ]);

      // …and byte-identical INCLUDING KEY ORDER, which `toEqual` does not see.
      //
      // The web client depends on this exactly: `lib/all-tabs.mergeWorkspaceTabs`
      // takes the list the sidebar just fetched from THIS route's per-workspace
      // twin and splices it into the cross-workspace corpus, so the two surfaces
      // are the same bytes. It decides whether anything changed with a
      // `JSON.stringify` signature, which IS key-order sensitive. If the two
      // paths ever built their rows in a different key order the payloads would
      // stay deep-equal — this file would still pass — while every 5s poll
      // looked like a change and repainted every corpus reader, ChatPane
      // included. That is a silent performance cliff with no failing test, so
      // the stronger comparison is pinned here rather than inferred there.
      expect(JSON.stringify(grouped)).toBe(JSON.stringify(perWorkspace));
      // ANTI-VACUITY: prove the line above is strictly stronger than the
      // `toEqual` above it. A row with the same fields in a different order is
      // deep-equal and NOT stringify-equal — so if key order ever diverges,
      // only the new assertion catches it.
      const reordered = perWorkspace.map(
        (t) => Object.fromEntries(Object.entries(t).reverse()) as unknown as Tab,
      );
      expect(reordered).toEqual(perWorkspace);
      expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(perWorkspace));
      // Anti-vacuity: the rows being compared actually carry a lifecycle, and
      // not all the same one. Without agent panes these would all be
      // `clock: null` and the comparison would hold for the wrong reason.
      const byName = new Map(grouped.map((t) => [t.name, t]));
      expect(byName.get('A')?.clock?.fill).toBeGreaterThan(0.4);
      expect(byName.get('B')?.clock?.last_day).toBe(true);
      expect(byName.get('C')?.clock?.stopped).toBe(true);
    } finally {
      Date.now = realNow;
    }
  });

  it('is ONE snapshot: every row in a response resolves against the same instant', async () => {
    // The list pre-reads the clock index once per request; it now pre-reads
    // the INSTANT once too. Re-reading `Date.now()` per row means two rows in
    // one payload can straddle the same moment — the first still live, the
    // second already expired — in a response that is supposed to be one
    // picture of the sidebar.
    const ws = await makeWorkspace('W');
    const tabs = new TabStore(db);
    // MID-clock, deliberately: `fill` is clamped at both ends, so four expired
    // rows would all read 1 and the test would pass without measuring
    // anything. Half-buried, they agree only if they were resolved together.
    //
    // A REAL sidebar's worth of rows, and that is load-bearing: `Date.now()`
    // has millisecond resolution, so four rows decorate inside one tick and a
    // per-row clock would look identical by luck. Ninety rows — the size of
    // the database this was measured against — take tens of milliseconds to
    // walk, so a per-row clock genuinely straddles ticks.
    const born = Date.now() - 2 * DAY_MS;
    for (let i = 0; i < 90; i++) {
      tabs.resetClock((await makeChat(ws.id, `chat ${i}`)).id, born);
    }
    const rows = (await all()).workspaces[0]?.tabs ?? [];
    expect(rows).toHaveLength(90);
    expect(new Set(rows.map((t) => t.clock?.started_at)).size).toBe(1);
    expect(rows[0]?.clock?.fill).toBeCloseTo(0.5, 2);
    // Identical inputs, one `now` → one answer. Re-reading the clock per row
    // gives four values differing in the ninth decimal place: harmless on
    // screen, but it means the payload is four samples rather than one
    // picture, and on a threshold like `done` that difference has a side.
    expect(new Set(rows.map((t) => t.clock?.fill)).size).toBe(1);
  });

  it('carries the fields the search matches on: headline, status, pinned, activity', async () => {
    const ws = await makeWorkspace('W');
    const t = await makeTab(ws.id, 'Investing');
    db.prepare('UPDATE tabs SET headline = ? WHERE id = ?').run('portfolio rebalancing', t.id);
    const paneId = (
      (await (
        await test.app.request(`/api/tabs/${t.id}/panes`, {
          method: 'POST',
          ...json({ append_to_layout: true }),
        })
      ).json()) as { id: string }
    ).id;
    test.cache.setAgentBusy(paneId, true);

    const row = (await all()).workspaces[0]?.tabs[0];
    expect(row).toMatchObject({
      name: 'Investing',
      headline: 'portfolio rebalancing',
      status: 'working',
      pinned: false,
    });
    expect(typeof row?.last_activity_at).toBe('number');
    // The layout is what maps a message hit's pane back to its tab client-side.
    expect(JSON.stringify(row?.layout)).toContain(paneId);
  });

  it('does not collide with GET /api/tabs/:id', async () => {
    const ws = await makeWorkspace('W');
    const t = await makeTab(ws.id, 'A');
    const byId = (await (await test.app.request(`/api/tabs/${t.id}`)).json()) as Tab;
    expect(byId.id).toBe(t.id);
    // And the unknown-id path still 404s rather than being shadowed.
    expect((await test.app.request('/api/tabs/nope')).status).toBe(404);
  });

  it('still requires workspaceId on the per-workspace list', async () => {
    // `?all=1` is deliberately NOT a mode of the old route: the two answer
    // different SHAPES, and one endpoint returning an array or an object
    // depending on a query param is how a client ends up parsing both.
    expect((await test.app.request('/api/tabs')).status).toBe(400);
  });
  it('does not grow with finished or expired history, or build a historical clock snapshot', async () => {
    const ws = await makeWorkspace('W');
    const live = await makeChat(ws.id, 'live');
    const now = Date.now();
    const realNow = Date.now;
    Date.now = () => now;
    try {
      const before = await all();
      const tabs = new TabStore(db);
      for (let i = 0; i < 100; i++) {
        const old = await makeChat(ws.id, `finished ${i}`);
        tabs.retire(old.id, 'delivered');
        tabs.setUnread(old.id, true);
        db.prepare('UPDATE panes SET parked_at = ? WHERE tab_id = ?').run(now, old.id);
        db.prepare('UPDATE tabs SET spawn_report = ? WHERE id = ?').run(
          'report'.repeat(10_000),
          old.id,
        );
        const expired = await makeChat(ws.id, `expired ${i}`);
        tabs.resetClock(expired.id, now - CHAT_DECAY_MS - DAY_MS);
        db.prepare('UPDATE panes SET parked_at = ? WHERE tab_id = ?').run(now, expired.id);
      }
      // Candidate enumeration itself is bounded, before JSON/decorateTab.
      expect(tabs.corpusCandidates(now - CHAT_DECAY_MS).map((t) => t.id)).toEqual([live.id]);
      const original = tabs.clockRows;
      TabStore.prototype.clockRows = () => {
        throw new Error('whole-history clock scan');
      };
      try {
        expect(await all()).toEqual(before);
      } finally {
        TabStore.prototype.clockRows = original;
      }
    } finally {
      Date.now = realNow;
    }
  });

  it('keeps retired work with an unparked pane, then drops it when parked', async () => {
    const ws = await makeWorkspace('W');
    const chat = await makeChat(ws.id, 'still running');
    new TabStore(db).retire(chat.id, 'delivered');
    const pane = new PaneStore(db).listByTab(chat.id)[0]!;
    vi.spyOn(test.ptyd.client, 'listPanes').mockResolvedValue([pane.id]);
    const rows = (await all()).workspaces[0]?.tabs ?? [];
    expect(rows.map((t) => t.id)).toContain(chat.id);
    expect(rows.find((t) => t.id === chat.id)?.done).toBe(true);
    db.prepare('UPDATE panes SET parked_at = ? WHERE tab_id = ?').run(Date.now(), chat.id);
    expect((await all()).workspaces[0]?.tabs).toEqual([]);
  });

  it('preserves clock exceptions, including an old sub-chat with a finished parent', async () => {
    const ws = await makeWorkspace('W');
    const tabs = new TabStore(db);
    const terminal = await makeTab(ws.id, 'terminal');
    const pinned = await makeChat(ws.id, 'pinned');
    const parent = await makeChat(ws.id, 'finished parent');
    const child = tabs.create({
      name: 'old live child',
      workspace_id: ws.id,
      layout: '',
      spawned_by: parent.id,
    });
    new PaneStore(db).create({ tab_id: child.id, startup_cmd: 'muxpad agent' });
    for (const t of [terminal, pinned, parent, child]) {
      tabs.resetClock(t.id, Date.now() - CHAT_DECAY_MS - DAY_MS);
      db.prepare('UPDATE panes SET parked_at = ? WHERE tab_id = ?').run(Date.now(), t.id);
    }
    tabs.setPinned(pinned.id, true);
    tabs.retire(parent.id, 'delivered');
    expect(new Set((await all()).workspaces[0]?.tabs.map((t) => t.id))).toEqual(
      new Set([terminal.id, pinned.id, child.id]),
    );
    // Removing its agent changes the indexed content marker atomically.
    db.prepare('UPDATE panes SET startup_cmd = NULL WHERE tab_id = ?').run(parent.id);
    tabs.unretire(parent.id);
    expect((await all()).workspaces[0]?.tabs.map((t) => t.id)).toContain(parent.id);
  });

  it('keeps finished unread in the inbox while excluding it from the corpus', async () => {
    const ws = await makeWorkspace('W');
    const tabs = new TabStore(db);
    const manual = await makeChat(ws.id, 'manual unread');
    const pane = await makeChat(ws.id, 'pane unread');
    for (const t of [manual, pane]) {
      tabs.retire(t.id, 'archived');
      db.prepare('UPDATE panes SET parked_at = ? WHERE tab_id = ?').run(Date.now(), t.id);
      db.prepare(
        'UPDATE tabs SET spawn_report = ?, spawn_report_state = ?, spawn_report_at = ? WHERE id = ?',
      ).run('private long report', 'ok', 1, t.id);
    }
    tabs.setUnread(manual.id, true);
    db.prepare('UPDATE panes SET unread = 1 WHERE tab_id = ?').run(pane.id);
    expect((await all()).workspaces[0]?.tabs).toEqual([]);
    const inbox = (await (await test.app.request('/api/tabs/unread')).json()) as AllTabsBody;
    expect(new Set(inbox.workspaces[0]?.tabs.map((t) => t.id))).toEqual(
      new Set([manual.id, pane.id]),
    );
    expect(inbox.workspaces[0]?.tabs.every((t) => t.done && t.unread && !t.spawn_report)).toBe(
      true,
    );
  });

  it('looks up historical names and archive pane ids without a history corpus, with bounded results', async () => {
    const ws = await makeWorkspace('W');
    const old = await makeChat(ws.id, 'historical needle');
    const tabs = new TabStore(db);
    tabs.retire(old.id, 'delivered');
    db.prepare('UPDATE panes SET parked_at = ? WHERE tab_id = ?').run(Date.now(), old.id);
    const paneId = new PaneStore(db).listByTab(old.id)[0]?.id;
    const lookup = async (q: string) =>
      (await (await test.app.request(`/api/tabs/lookup?${q}`)).json()) as AllTabsBody;
    expect((await lookup('q=needle')).workspaces[0]?.tabs.map((t) => t.id)).toEqual([old.id]);
    expect((await lookup(`tabIds=${old.id}`)).workspaces[0]?.tabs.map((t) => t.id)).toEqual([
      old.id,
    ]);
    expect((await lookup(`paneIds=${paneId}`)).workspaces[0]?.tabs.map((t) => t.id)).toEqual([
      old.id,
    ]);
    expect((await lookup('q=')).workspaces[0]?.tabs).toEqual([]);
    for (let i = 0; i < 65; i++) await makeTab(ws.id, `needle ${i}`);
    expect((await lookup('q=needle')).workspaces[0]?.tabs).toHaveLength(60);
  });
  it('retains an expired parked parent while a live child is working', async () => {
    const ws = await makeWorkspace('W');
    const tabs = new TabStore(db);
    const parent = await makeChat(ws.id, 'old parent');
    tabs.resetClock(parent.id, Date.now() - CHAT_DECAY_MS - DAY_MS);
    db.prepare('UPDATE panes SET parked_at = ? WHERE tab_id = ?').run(Date.now(), parent.id);
    const child = tabs.create({
      name: 'working child',
      workspace_id: ws.id,
      layout: '',
      spawned_by: parent.id,
    });
    const pane = new PaneStore(db).create({ tab_id: child.id, startup_cmd: 'muxpad agent' });
    test.cache.setAgentBusy(pane.id, true);
    const row = (await all()).workspaces[0]?.tabs.find((t) => t.id === parent.id);
    expect(row).toMatchObject({ done: false, status: 'working', agents: 1 });
  });

  it('drops dead unparked history while retaining retired running work and offline evidence', async () => {
    const ws = await makeWorkspace('W');
    const tabs = new TabStore(db);
    const old = await makeChat(ws.id, 'dead unparked history');
    const running = await makeChat(ws.id, 'retired running work');
    for (const t of [old, running]) tabs.retire(t.id, 'delivered');
    const stalePane = new PaneStore(db).listByTab(old.id)[0]!;
    const livePane = new PaneStore(db).listByTab(running.id)[0]!;
    test.cache.seedCwds([{ id: stalePane.id, cwd: '/tmp' }]);
    const inventory = vi.spyOn(test.ptyd.client, 'listPanes').mockResolvedValue([livePane.id]);
    expect((await all()).workspaces[0]?.tabs.map((t) => t.id)).toEqual([running.id]);
    inventory.mockRejectedValueOnce(new Error('transport unavailable'));
    expect((await all()).workspaces[0]?.tabs.map((t) => t.id)).toEqual([running.id]);
    inventory.mockResolvedValue([]);
    expect((await all()).workspaces[0]?.tabs).toEqual([]);
  });

  it('does not resurrect an exited process from an older runtime inventory', async () => {
    const ws = await makeWorkspace('W');
    const chat = await makeChat(ws.id, 'exiting');
    new TabStore(db).retire(chat.id, 'delivered');
    const pane = new PaneStore(db).listByTab(chat.id)[0]!;
    test.cache.setRuntimePanes([pane.id]);
    let finish!: (ids: string[]) => void;
    const inventory = vi.spyOn(test.ptyd.client, 'listPanes').mockImplementation(
      () =>
        new Promise<string[]>((resolve) => {
          finish = resolve;
        }),
    );
    const response = all();
    await vi.waitFor(() => expect(inventory).toHaveBeenCalledTimes(1));
    test.ptyd.client.emit('paneExit', { id: pane.id, code: 0, cause: 'natural' });
    finish([pane.id]);
    expect((await response).workspaces[0]?.tabs).toEqual([]);
  });
  it('refreshes reachable nodes while retaining work on an unavailable node', async () => {
    const ws = await makeWorkspace('W');
    new NodeStore(db).add({ id: 'remote', name: 'Remote', endpoint: 'wss://remote.invalid' });
    const tabs = new TabStore(db);
    const local = await makeChat(ws.id, 'gone local');
    const remote = tabs.create({ name: 'remote work', workspace_id: ws.id, layout: '' });
    const remotePane = new PaneStore(db).create({
      tab_id: remote.id,
      startup_cmd: 'muxpad agent',
      node_id: 'remote',
    });
    const localPane = new PaneStore(db).listByTab(local.id)[0]!;
    tabs.retire(local.id, 'delivered');
    tabs.retire(remote.id, 'delivered');
    test.cache.setRuntimePanes([localPane.id, remotePane.id]);
    const read = vi
      .fn()
      .mockResolvedValueOnce({ value: [], unreachable: ['remote'] })
      .mockResolvedValue({ value: [], unreachable: [] });
    Object.assign(test.ptyd.client, { listPanesBestEffort: read });
    expect((await all()).workspaces[0]?.tabs.map((t) => t.id)).toEqual([remote.id]);
    expect((await all()).workspaces[0]?.tabs).toEqual([]);
  });
  it('ranks historical name matches before a broad workspace match reaches the lookup cap', async () => {
    const ws = await makeWorkspace('Needle');
    const exact = await makeChat(ws.id, 'Needle');
    new TabStore(db).retire(exact.id, 'delivered');
    for (let i = 0; i < 65; i++) await makeTab(ws.id, `other ${i}`);
    db.prepare('UPDATE tabs SET last_user_at = 0 WHERE id = ?').run(exact.id);
    const result = (await (
      await test.app.request('/api/tabs/lookup?q=needle')
    ).json()) as AllTabsBody;
    expect(result.workspaces[0]?.tabs).toHaveLength(60);
    expect(result.workspaces[0]?.tabs.map((t) => t.id)).toContain(exact.id);
  });
});
