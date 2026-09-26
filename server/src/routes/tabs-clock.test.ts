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

  /**
   * A CHAT: the row, plus the agent pane that makes it one.
   *
   * The pane is not decoration. A clock's only exit is a message, so a tab
   * with nothing to send a message to publishes no clock at all (F2,
   * `hasDecayClock`) — creating the row alone would be creating a terminal and
   * then asserting it behaves like a conversation. Inserted directly rather
   * than through `bootstrap: 'agent'` so the test does not need a ptyd.
   */
  async function newTab(name: string, extra: Record<string, unknown> = {}): Promise<Tab> {
    const tab = (await (
      await post('/api/tabs', { name, workspace_id: wsId, ...extra })
    ).json()) as Tab;
    new PaneStore(db).create({ tab_id: tab.id, startup_cmd: 'muxpad agent', face: 'chat' });
    return tab;
  }

  /** A tab with no agent in it — a plain shell, and nothing to message. */
  async function newTerminalTab(name: string): Promise<Tab> {
    const tab = (await (await post('/api/tabs', { name, workspace_id: wsId })).json()) as Tab;
    new PaneStore(db).create({ tab_id: tab.id, shell: '/bin/zsh', cwd: '/tmp' });
    return tab;
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

  it('a terminal tab publishes no clock and never goes done', async () => {
    // F2, on the wire, where it bites: the clock's only exit is a message and
    // a terminal has no inbox, so decaying one does not rest it, it loses it.
    // The client has no unarchive button, `noteUserMessage` has one production
    // caller and it is the agent send path, and pinning is the only way back.
    const t = await newTerminalTab('Trayobot');
    tabs.resetClock(t.id, Date.now() - 40 * DAY_MS);
    const row = (await listTabs()).find((r) => r.id === t.id) as Tab;
    expect(row.done).toBe(false);
    expect(row.clock).toBeNull();
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

  describe('archive — the manual path into done', () => {
    it('lands in the same place decay does, and says which it was', async () => {
      const t = await newTab('x');
      const res = await test.app.request(`/api/tabs/${t.id}/archive`, { method: 'POST' });
      expect(res.status).toBe(204);
      const row = (await listTabs()).find((r) => r.id === t.id) as Tab;
      expect(row.done).toBe(true);
      expect(row.done_reason).toBe('archived');
    });

    it('does NOT delete — the row, its panes and its name are all still there', async () => {
      // This is the whole reason × becomes archive: the gesture stops being
      // one you have to be sure about.
      const t = await newTab('keepme');
      const pane = new PaneStore(db).create({ tab_id: t.id, shell: '/bin/zsh', cwd: '/tmp' });
      await test.app.request(`/api/tabs/${t.id}/archive`, { method: 'POST' });
      expect(tabs.getById(t.id)?.name).toBe('keepme');
      expect(new PaneStore(db).getById(pane.id)).not.toBeNull();
    });

    it('clears READY on the way out', async () => {
      const t = await newTab('x');
      const pane = new PaneStore(db).create({ tab_id: t.id, shell: '/bin/zsh', cwd: '/tmp' });
      new PaneStore(db).setUnread(pane.id, true);
      await test.app.request(`/api/tabs/${t.id}/archive`, { method: 'POST' });
      expect(new PaneStore(db).getById(pane.id)?.unread).toBe(false);
    });

    it('announces it, so the row leaves every sidebar at once', async () => {
      const t = await newTab('x');
      const seen: Tab[] = [];
      events.subscribe((e: MuxpadEvent) => {
        if (e.type === 'tab.updated') seen.push(e.tab);
      });
      await test.app.request(`/api/tabs/${t.id}/archive`, { method: 'POST' });
      expect(seen.at(-1)?.done).toBe(true);
    });

    it('unarchive brings it back live, on a full clock', async () => {
      const t = await newTab('x');
      tabs.resetClock(t.id, Date.now() - CHAT_DECAY_MS - 1_000); // expired when archived
      await test.app.request(`/api/tabs/${t.id}/archive`, { method: 'POST' });
      const res = await test.app.request(`/api/tabs/${t.id}/unarchive`, { method: 'POST' });
      expect(res.status).toBe(204);
      const row = (await listTabs()).find((r) => r.id === t.id) as Tab;
      // Not merely un-retired: un-retired onto the expired clock it left with,
      // it would be done again on this very read.
      expect(row.done).toBe(false);
      expect(row.clock?.fill).toBeLessThan(0.01);
    });

    it('is idempotent, and 404s on a tab that is not there', async () => {
      const t = await newTab('x');
      await test.app.request(`/api/tabs/${t.id}/archive`, { method: 'POST' });
      expect((await test.app.request(`/api/tabs/${t.id}/archive`, { method: 'POST' })).status).toBe(
        204,
      );
      expect((await test.app.request('/api/tabs/ghost/archive', { method: 'POST' })).status).toBe(
        404,
      );
      expect((await test.app.request('/api/tabs/ghost/unarchive', { method: 'POST' })).status).toBe(
        404,
      );
    });

    it('REFUSES a pinned chat instead of accepting a click that does nothing', async () => {
      // F6. Pinning is the universal override, so a pinned chat is never
      // `done` however it got there — that rule is untouched. What was wrong
      // was this route answering 204 to a press of × that moved nothing on
      // screen and explained nothing, which reads as a broken button. Worse,
      // it WROTE the retirement: unpin a month later and the chat dropped
      // into `done` on the strength of a click nobody remembers.
      const t = await newTab('kept');
      await test.app.request(`/api/tabs/${t.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pinned: true }),
      });

      const res = await test.app.request(`/api/tabs/${t.id}/archive`, { method: 'POST' });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('pinned');

      // And nothing was stored, so there is no delayed detonation on unpin.
      // Read the raw column: `retired_at` is deliberately not on the wire
      // (`done`/`done_reason` are what the client is told), so the only place
      // a stored-but-invisible retirement would show up is the table itself.
      expect(tabs.clockRow(t.id)?.retired_at).toBeNull();
      await test.app.request(`/api/tabs/${t.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pinned: false }),
      });
      expect(((await listTabs()).find((r) => r.id === t.id) as Tab).done).toBe(false);
    });

    it('archives a sub-chat by hand without calling it delivered', async () => {
      const parent = await newTab('parent');
      const child = await newTab('child', { spawned_by: parent.id });
      await test.app.request(`/api/tabs/${child.id}/archive`, { method: 'POST' });
      const row = (await listTabs()).find((r) => r.id === child.id) as Tab;
      expect(row.done_reason).toBe('archived');
    });
  });

  describe('spawned_by', () => {
    it('records the parent, and publishes NO clock for the child', async () => {
      // A sub-chat does not share its parent's clock and does not have one of
      // its own: it is work, and it leaves when the work lands. `null` says
      // that; a 0%-full clock would claim elapsed time means something here.
      const parent = await newTab('parent');
      tabs.resetClock(parent.id, Date.now() - 3 * DAY_MS);
      const child = await newTab('child', { spawned_by: parent.id });
      expect(child.spawned_by).toBe(parent.id);

      const rows = await listTabs();
      const p = rows.find((r) => r.id === parent.id) as Tab;
      const c = rows.find((r) => r.id === child.id) as Tab;
      expect(c.clock).toBeNull();
      expect(c.done).toBe(false);
      expect(p.clock?.last_day).toBe(true);
    });

    it('the child outlives a parent that decays', async () => {
      const parent = await newTab('parent');
      tabs.resetClock(parent.id, Date.now() - CHAT_DECAY_MS - 1_000);
      const child = await newTab('child', { spawned_by: parent.id });
      const rows = await listTabs();
      expect((rows.find((r) => r.id === parent.id) as Tab).done).toBe(true);
      expect((rows.find((r) => r.id === child.id) as Tab).done).toBe(false);
    });

    it('a worker whose parent is DELETED is promoted live, not straight into done', async () => {
      // F5, through the real door. `cron --new-tab` with close_when_done runs
      // this exact delete on every clean fire, so any agent that spawned a
      // worker from inside a cron tab is orphaning one minutes later. The
      // worker inherits a clock stamped at its birth and never once read —
      // so before the fix a ten-day-old worker was `decayed` the instant its
      // parent went away, mid-job, with no announcement.
      const parent = await newTab('parent');
      const child = await newTab('child', { spawned_by: parent.id });
      tabs.resetClock(child.id, Date.now() - 10 * DAY_MS);

      expect(
        (await test.app.request(`/api/tabs/${parent.id}`, { method: 'DELETE' })).status,
      ).toBeLessThan(300);

      const row = (await listTabs()).find((r) => r.id === child.id) as Tab;
      expect(row.done).toBe(false);
      expect(row.clock).not.toBeNull(); // it IS a root now
      expect(row.clock?.fill).toBeLessThan(0.01); // …on a clock that starts here
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

  /**
   * WHERE A SPAWN LANDS — from its parent, never from whoever asked.
   *
   * The caller's `workspace_id` was an ambient guess (for the CLI, an env value
   * frozen into the spawning pane at its birth), and it produced two symptoms
   * the user reported separately: a workspace they had abandoned re-seeding
   * itself through generations of agents, and children that never nested
   * because the sidebar groups by workspace before it groups by parent.
   */
  describe('where a spawn lands', () => {
    /** A second, unrelated workspace — the wrong answer, available. */
    async function otherWorkspace(): Promise<string> {
      return (
        (await (await post('/api/workspaces', { name: 'Elsewhere' })).json()) as { id: string }
      ).id;
    }

    async function tabsIn(workspaceId: string): Promise<Tab[]> {
      return (await (
        await test.app.request(`/api/tabs?workspaceId=${workspaceId}`)
      ).json()) as Tab[];
    }

    it('takes the PARENT’s workspace and ignores the one the caller named', async () => {
      const parent = await newTab('parent');
      const elsewhere = await otherWorkspace();
      const child = (await (
        await post('/api/tabs', { name: 'child', workspace_id: elsewhere, spawned_by: parent.id })
      ).json()) as Tab & { workspace_id?: string };

      expect(child.workspace_id).toBe(wsId);
      expect((await tabsIn(wsId)).map((t) => t.id)).toContain(child.id);
      // Not merely "also in the parent's workspace" — NOT in the other one. A
      // child in a different workspace from its parent is what does not draw.
      expect((await tabsIn(elsewhere)).map((t) => t.id)).not.toContain(child.id);
    });

    it('needs no workspace at all when it has a parent', async () => {
      const parent = await newTab('parent');
      const res = await post('/api/tabs', { name: 'child', spawned_by: parent.id });
      expect(res.status).toBe(201);
      expect(((await res.json()) as { workspace_id?: string }).workspace_id).toBe(wsId);
    });

    it('does the same through a PANE id — the CLI’s only door', async () => {
      // `muxpad agent new` from inside a pane knows $MUXPAD_PANE_ID and nothing
      // trustworthy about workspaces, which is the whole point of the fix.
      const parent = await newTab('parent');
      const pane = new PaneStore(db).create({ tab_id: parent.id, shell: '/bin/zsh', cwd: '/tmp' });
      const elsewhere = await otherWorkspace();
      const child = (await (
        await post('/api/tabs', {
          name: 'child',
          workspace_id: elsewhere,
          spawned_by_pane: pane.id,
        })
      ).json()) as Tab & { workspace_id?: string };
      expect(child.workspace_id).toBe(wsId);
      expect(child.spawned_by).toBe(parent.id);
    });

    it('follows the parent after it MOVES — the stale-env case, live', async () => {
      // The reported symptom: a chat moved out of an old workspace kept
      // spawning agents back into it, because the id in its pane's environment
      // was stamped at birth and never revisited. Parentage is read from the
      // row, so a move is simply the new answer.
      const parent = await newTab('parent');
      const elsewhere = await otherWorkspace();
      expect((await post(`/api/tabs/${parent.id}/move`, { workspace_id: elsewhere })).status).toBe(
        200,
      );
      const child = (await (
        await post('/api/tabs', { name: 'child', workspace_id: wsId, spawned_by: parent.id })
      ).json()) as Tab & { workspace_id?: string };
      expect(child.workspace_id).toBe(elsewhere);
    });

    it('still requires one for a ROOT tab, which has nothing to inherit', async () => {
      const res = await post('/api/tabs', { name: 'orphan' });
      expect(res.status).toBe(400);
    });

    it('falls back to the caller’s workspace when the parent is GONE', async () => {
      // The link is dropped rather than refused (a worker must not fail to
      // exist because the chat that asked for it was deleted), so there is no
      // parentage left to read and the caller's answer is the only one there is.
      const child = (await (
        await post('/api/tabs', { name: 'child', workspace_id: wsId, spawned_by: 'no-such-tab' })
      ).json()) as Tab & { workspace_id?: string };
      expect(child.workspace_id).toBe(wsId);
      expect(child.spawned_by).toBeUndefined();
    });
  });
});
