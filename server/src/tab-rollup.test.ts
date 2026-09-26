import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Tab, Workspace } from '@muxpad/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventBus } from './events.js';
import { PaneStore } from './store/PaneStore.js';
import { TabStore } from './store/TabStore.js';
import { openDb } from './store/db.js';
import { type TestApp, createTestApp } from './test-helpers/createTestApp.js';

/**
 * WHAT A TAB ROW SAYS ABOUT ITSELF — the two fields the chrome and the rail read
 * off it, resolved server-side so every surface reads one answer.
 *
 *   `takes_panes` — does this tab offer a `+` at all (tabTakesPanes).
 *   `agents`      — how much parallel work is running under it, which in muxpad
 *                   is mostly CHILD CHATS and not harness subagents.
 */
describe('the tab row’s rollups', () => {
  let test: TestApp;
  let tmp: string;
  let db: ReturnType<typeof openDb>;
  let panes: PaneStore;
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

  async function row(id: string): Promise<Tab> {
    return (await listTabs()).find((t) => t.id === id) as Tab;
  }

  async function workspaceRow(): Promise<Workspace> {
    const all = (await (await test.app.request('/api/workspaces')).json()) as Workspace[];
    return all.find((w) => w.id === wsId) as Workspace;
  }

  /** A chat: the row plus the agent pane that makes it one. */
  async function newChat(name: string, extra: Record<string, unknown> = {}): Promise<Tab> {
    const tab = (await (
      await post('/api/tabs', { name, workspace_id: wsId, ...extra })
    ).json()) as Tab;
    panes.create({ tab_id: tab.id, startup_cmd: 'muxpad agent', face: 'chat' });
    return tab;
  }

  async function newTerminal(name: string): Promise<Tab> {
    const tab = (await (await post('/api/tabs', { name, workspace_id: wsId })).json()) as Tab;
    panes.create({ tab_id: tab.id, shell: '/bin/zsh', cwd: '/tmp' });
    return tab;
  }

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'muxpad-rollup-'));
    db = openDb(':memory:');
    test = await createTestApp({ db, dataDir: tmp, events: new EventBus() });
    panes = new PaneStore(db);
    tabs = new TabStore(db);
    wsId = ((await (await post('/api/workspaces', { name: 'W' })).json()) as { id: string }).id;
  });

  afterEach(async () => {
    await test.cleanup();
    rmSync(tmp, { recursive: true, force: true });
  });

  describe('takes_panes', () => {
    it('is false for a chat — the `+` is gone from every agent-backed tab', async () => {
      expect((await row((await newChat('chat')).id)).takes_panes).toBe(false);
    });

    it('does not fork on the agent MODE', async () => {
      // "i don't want to care if its chat or agent." Chat mode rides the pane's
      // startup command; both spellings are the same primitive.
      const tab = (await (
        await post('/api/tabs', { name: 'c', workspace_id: wsId })
      ).json()) as Tab;
      panes.create({ tab_id: tab.id, startup_cmd: 'muxpad agent --mode chat', face: 'chat' });
      expect((await row(tab.id)).takes_panes).toBe(false);
    });

    it('is true for a terminal, where splitting is a real layout tool', async () => {
      expect((await row((await newTerminal('term')).id)).takes_panes).toBe(true);
    });

    it('is true for a MIXED tab — one working tool is enough to keep the `+`', async () => {
      const tab = await newChat('mixed');
      panes.create({ tab_id: tab.id, shell: '/bin/zsh', cwd: '/tmp' });
      expect((await row(tab.id)).takes_panes).toBe(true);
    });

    it('is true for an empty tab, which needs a way out', async () => {
      const tab = (await (
        await post('/api/tabs', { name: 'empty', workspace_id: wsId })
      ).json()) as Tab;
      expect((await row(tab.id)).takes_panes).toBe(true);
    });
  });

  /**
   * SPAWNED PANES COUNT AS RUNNING WORK.
   *
   * `agents` counted harness subagents only — and muxpad's own pattern is to
   * spawn PANES (they survive a runner restart; a subagent dies with the turn).
   * So the one indicator built to say "this chat has parallel work running" read
   * 0 while a dozen children were working, which is what the user hit twice: "i
   * see no indication that something is running".
   */
  describe('agents counts live children', () => {
    it('counts the chats spawned under this one', async () => {
      const parent = await newChat('parent');
      await newChat('kid-1', { spawned_by: parent.id });
      await newChat('kid-2', { spawned_by: parent.id });
      expect((await row(parent.id)).agents).toBe(2);
    });

    it('stops counting one that has DELIVERED', async () => {
      // A sub-chat retires on delivery — that is the moment its work stopped
      // being parallel work, and the card in the parent is where it lives now.
      const parent = await newChat('parent');
      const kid = await newChat('kid', { spawned_by: parent.id });
      tabs.retire(kid.id, 'delivered');
      expect((await row(parent.id)).agents).toBe(0);
    });

    it('does not count a GRANDCHILD as this chat’s own work', async () => {
      // Direct children only: the rail's number answers "what did I start", and
      // a transitive count would make one deep chain look like a fleet.
      const parent = await newChat('parent');
      const kid = await newChat('kid', { spawned_by: parent.id });
      await newChat('grandkid', { spawned_by: kid.id });
      expect((await row(parent.id)).agents).toBe(1);
      expect((await row(kid.id)).agents).toBe(1);
    });

    it('rolls up into the workspace, so a collapsed workspace still says so', async () => {
      const parent = await newChat('parent');
      await newChat('kid', { spawned_by: parent.id });
      // The child is a tab in this workspace too, hence 1 (its own) + 1 (the
      // parent's count of it) — the workspace number is "work running in here",
      // and a child chat with children of its own contributes both.
      expect((await workspaceRow()).agents).toBe(1);
    });

    it('rides the pane row as well, so the chat’s own status bar can see it', async () => {
      const parent = await newChat('parent');
      await newChat('kid', { spawned_by: parent.id });
      const detail = (await (await test.app.request(`/api/tabs/${parent.id}`)).json()) as {
        panes: { agents?: number }[];
      };
      expect(detail.panes[0]?.agents).toBe(1);
    });

    it('keeps counting a child of an ARCHIVED parent for nobody — the parent is gone', async () => {
      // Guard against a count that outlives what it describes: a retired parent
      // publishes its children the same way (it is still a row), but a DELETED
      // one takes its number with it and its children become roots.
      const parent = await newChat('parent');
      const kid = await newChat('kid', { spawned_by: parent.id });
      await test.app.request(`/api/tabs/${parent.id}`, { method: 'DELETE' });
      expect(tabs.getById(kid.id)?.spawned_by).toBe(parent.id); // dangling, by design
      expect((await row(kid.id)).agents).toBe(0);
    });
  });
});
