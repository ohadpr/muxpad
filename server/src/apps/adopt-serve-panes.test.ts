import type { MuxpadEvent } from '@muxpad/shared';
import type Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { EventBus } from '../events.js';
import { AppStore } from '../store/AppStore.js';
import { GlobalsStore } from '../store/GlobalsStore.js';
import { PaneStore } from '../store/PaneStore.js';
import { TabStore } from '../store/TabStore.js';
import { WorkspaceStore } from '../store/WorkspaceStore.js';
import { openDb } from '../store/db.js';
import { APPS_WORKSPACE_KEY } from './AppRegistry.js';
import { KEY_ADOPTED, adoptServePanes, parseServeCommand } from './adopt-serve-panes.js';

// The two commands as they actually appear in the live database.
const NOTES_CMD =
  'muxpad serve --url https://example-host.example-tailnet.ts.net:4322 --label Notes -- ./start';
const READER_CMD =
  'muxpad serve --url https://example-host.example-tailnet.ts.net:4748 --label Reader -- ./start';

describe('parseServeCommand', () => {
  it('parses the live Notes command exactly', () => {
    expect(parseServeCommand(NOTES_CMD)).toEqual({
      url: 'https://example-host.example-tailnet.ts.net:4322',
      label: 'Notes',
      command: './start',
    });
  });

  it('parses the = form, the quoted form, and a multi-word command', () => {
    expect(parseServeCommand("muxpad serve --url='http://127.0.0.1:1' -- pnpm dev --host")).toEqual(
      {
        url: 'http://127.0.0.1:1',
        label: null,
        command: 'pnpm dev --host',
      },
    );
    expect(
      parseServeCommand("muxpad serve --url 'http://127.0.0.1:1' --label 'My App' -- ./go"),
    ).toEqual({ url: 'http://127.0.0.1:1', label: 'My App', command: './go' });
  });

  it('returns null rather than guessing', () => {
    for (const cmd of [
      null,
      '',
      'muxpad agent',
      'muxpad serve -- ./start', // no url
      'muxpad serve --url http://x', // no command
      'muxpad serve --url ftp://x -- ./start', // not http(s)
      'muxpad serve --url http://x --', // trailing separator, empty command
    ]) {
      expect(parseServeCommand(cmd)).toBeNull();
    }
  });
});

let db: Database.Database;
let workspaces: WorkspaceStore;
let tabs: TabStore;
let panes: PaneStore;
let apps: AppStore;
let events: EventBus;
let seen: MuxpadEvent[];

/** A serve pane alone in its own tab, the shape the live install has. */
function serveTab(workspaceId: string, name: string, cmd: string) {
  const tab = tabs.create({ name, layout: '', workspace_id: workspaceId });
  const pane = panes.create({
    tab_id: tab.id,
    shell: '/bin/zsh',
    cwd: '/tmp',
    startup_cmd: cmd,
  });
  panes.setName(pane.id, name);
  tabs.update(tab.id, { layout: pane.id });
  return { tab, pane };
}

beforeEach(() => {
  db = openDb(':memory:');
  workspaces = new WorkspaceStore(db);
  tabs = new TabStore(db);
  panes = new PaneStore(db);
  apps = new AppStore(db);
  events = new EventBus();
  seen = [];
  events.subscribe((e) => seen.push(e));
});

describe('adoptServePanes', () => {
  it('adopts the two live serve panes without restarting or deleting anything', () => {
    const ws = workspaces.create({ name: 'Apps' });
    const notes = serveTab(ws.id, 'Notes', NOTES_CMD);
    const reader = serveTab(ws.id, 'Reader', READER_CMD);

    const res = adoptServePanes({ db, events });
    expect(res.adopted.sort()).toEqual(['notes', 'reader']);

    const notesApp = apps.getBySlug('notes');
    expect(notesApp).toMatchObject({
      name: 'Notes',
      cwd: '/tmp',
      command: './start',
      url: 'https://example-host.example-tailnet.ts.net:4322',
      enabled: true,
      autostart: true,
      pane_id: notes.pane.id,
    });
    expect(apps.getBySlug('reader')?.pane_id).toBe(reader.pane.id);

    // THE PANES ARE UNTOUCHED — same ids, same startup command, still there. An
    // adoption that restarted the app would be unsafe to run on a live machine.
    expect(panes.getById(notes.pane.id)?.startup_cmd).toBe(NOTES_CMD);
    expect(panes.getById(reader.pane.id)?.startup_cmd).toBe(READER_CMD);

    // Their TABS left the sidebar, into the hidden container…
    const containerId = new GlobalsStore(db).get(APPS_WORKSPACE_KEY) as string;
    expect(workspaces.getById(containerId)?.hidden).toBe(true);
    expect(tabs.getWorkspaceId(notes.tab.id)).toBe(containerId);
    expect(tabs.getWorkspaceId(reader.tab.id)).toBe(containerId);
    // …and the container is invisible to every user-facing list.
    expect(workspaces.list().map((w) => w.id)).toEqual([ws.id]);

    // Nothing was destroyed: tabs, panes and the source workspace all survive.
    expect(tabs.getById(notes.tab.id)).not.toBeNull();
    expect(workspaces.getById(ws.id)).not.toBeNull();

    // Open clients are told the tabs left their sidebar — and NOT that a hidden
    // workspace gained them.
    const removed = seen.filter((e) => e.type === 'tab.removed');
    expect(removed.map((e) => (e as { tab_id: string }).tab_id).sort()).toEqual(
      [notes.tab.id, reader.tab.id].sort(),
    );
    expect(seen.some((e) => e.type === 'tab.added' || e.type === 'workspace.added')).toBe(false);
  });

  it('runs exactly once', () => {
    const ws = workspaces.create({ name: 'Apps' });
    serveTab(ws.id, 'Notes', NOTES_CMD);
    expect(adoptServePanes({ db }).adopted).toEqual(['notes']);
    expect(new GlobalsStore(db).get(KEY_ADOPTED)).toBe('1');

    // A user who deliberately drags an app's tab back into view must not have
    // it taken away again on the next boot.
    const tab = tabs.listByWorkspace(new GlobalsStore(db).get(APPS_WORKSPACE_KEY) as string)[0] as {
      id: string;
    };
    tabs.setWorkspace(tab.id, ws.id);
    expect(adoptServePanes({ db }).adopted).toEqual([]);
    expect(tabs.getWorkspaceId(tab.id)).toBe(ws.id);
  });

  it('does nothing at all on an install with no serve panes', () => {
    const ws = workspaces.create({ name: 'W' });
    const t = tabs.create({ name: 'T', layout: '', workspace_id: ws.id });
    panes.create({ tab_id: t.id, shell: '/bin/zsh', cwd: '/tmp', startup_cmd: 'muxpad agent' });
    const res = adoptServePanes({ db, events });
    expect(res.adopted).toEqual([]);
    // No stray hidden container for an install that will never have an app.
    expect(workspaces.list({ all: true })).toHaveLength(1);
    expect(seen).toEqual([]);
  });

  it.each([
    [
      'a serve pane sharing a tab with others',
      (ws: string) => {
        const { tab, pane } = serveTab(ws, 'Notes', NOTES_CMD);
        panes.create({ tab_id: tab.id, shell: '/bin/zsh', cwd: '/tmp' });
        return pane.id;
      },
      /ambiguous/,
    ],
    [
      'a serve pane whose command will not parse',
      (ws: string) => serveTab(ws, 'Weird', 'muxpad serve --label X -- ./start').pane.id,
      /could not parse/,
    ],
  ])('leaves %s alone, and says so', (_label, build, message) => {
    const ws = workspaces.create({ name: 'Apps' });
    const paneId = build(ws.id);
    const res = adoptServePanes({ db, events });
    expect(res.adopted).toEqual([]);
    expect(res.log.join('\n')).toMatch(message);
    // Left exactly where it was.
    const pane = panes.getById(paneId);
    expect(tabs.getWorkspaceId(pane?.tab_id as string)).toBe(ws.id);
    expect(apps.list()).toEqual([]);
  });

  it('skips a pane an app already claims', () => {
    const ws = workspaces.create({ name: 'Apps' });
    const { pane } = serveTab(ws.id, 'Notes', NOTES_CMD);
    const existing = apps.create({
      slug: 'notes',
      name: 'Notes',
      cwd: '/tmp',
      command: './start',
      url: 'http://127.0.0.1:1',
    });
    apps.setPane(existing.id, pane.id);
    const res = adoptServePanes({ db, events });
    expect(res.adopted).toEqual([]);
    expect(res.log.join('\n')).toMatch(/already an app/);
    expect(apps.list()).toHaveLength(1);
  });

  it('reuses the registry container rather than creating a second one', () => {
    const ws = workspaces.create({ name: 'Apps' });
    const existing = workspaces.createHidden({ name: '· apps ·' });
    new GlobalsStore(db).set(APPS_WORKSPACE_KEY, existing.id);
    serveTab(ws.id, 'Notes', NOTES_CMD);
    adoptServePanes({ db });
    expect(workspaces.list({ all: true }).filter((w) => w.hidden)).toHaveLength(1);
    expect(new GlobalsStore(db).get(APPS_WORKSPACE_KEY)).toBe(existing.id);
  });

  it('de-duplicates a slug that collides with an existing app', () => {
    const ws = workspaces.create({ name: 'Apps' });
    apps.create({
      slug: 'notes',
      name: 'Notes',
      cwd: '/tmp',
      command: 'x',
      url: 'http://127.0.0.1:9',
    });
    serveTab(ws.id, 'Notes', NOTES_CMD);
    expect(adoptServePanes({ db }).adopted).toEqual(['notes-2']);
  });
});

describe('adoption applies the same gates the API does', () => {
  it('refuses a url carrying a quote, and a multi-line command', () => {
    // Adoption writes a registry row WITHOUT going through routes/apps.ts, so
    // its validators would not otherwise run. A quoted url would later be
    // interpolated into `--url '<url>'` and escape its own quoting.
    expect(parseServeCommand("muxpad serve --url http://x/';id;' -- ./start")).toBeNull();
    expect(parseServeCommand('muxpad serve --url "http://x/\'" -- ./start')).toBeNull();
    expect(parseServeCommand('muxpad serve --url http://x -- ./start\nrm -rf /')).toBeNull();
  });
});
