import { describe, expect, it } from 'vitest';
import { AppStore } from './AppStore.js';
import { PaneStore } from './PaneStore.js';
import { TabStore } from './TabStore.js';
import { WorkspaceStore } from './WorkspaceStore.js';
import { openDb } from './db.js';

function db() {
  return openDb(':memory:');
}

describe('AppStore', () => {
  it('creates, reads back and resolves by id or slug', () => {
    const d = db();
    const apps = new AppStore(d);
    const app = apps.create({
      slug: 'notes',
      name: 'Notes',
      cwd: '/tmp/notes',
      command: './start',
      url: 'http://127.0.0.1:4322',
    });
    expect(app.enabled).toBe(true);
    expect(app.autostart).toBe(true);
    expect(app.pane_id).toBeNull();
    expect(apps.getById(app.id)).toEqual(app);
    expect(apps.getBySlug('notes')).toEqual(app);
    expect(apps.resolve('notes')?.id).toBe(app.id);
    expect(apps.resolve(app.id)?.slug).toBe('notes');
    expect(apps.resolve('nope')).toBeNull();
    d.close();
  });

  it('slugifies names and never collides', () => {
    expect(AppStore.slugify('My Notes App')).toBe('my-notes-app');
    expect(AppStore.slugify('  Reader!!  ')).toBe('reader');
    expect(AppStore.slugify('🙂')).toBe('');
    const d = db();
    const apps = new AppStore(d);
    expect(apps.uniqueSlug('notes')).toBe('notes');
    apps.create({
      slug: 'notes',
      name: 'Notes',
      cwd: '/tmp',
      command: 'x',
      url: 'http://127.0.0.1:1',
    });
    expect(apps.uniqueSlug('notes')).toBe('notes-2');
    apps.create({
      slug: 'notes-2',
      name: 'N2',
      cwd: '/tmp',
      command: 'x',
      url: 'http://127.0.0.1:2',
    });
    expect(apps.uniqueSlug('notes')).toBe('notes-3');
    d.close();
  });

  it('rejects a duplicate slug at the schema level', () => {
    const d = db();
    const apps = new AppStore(d);
    const mk = () =>
      apps.create({
        slug: 'dup',
        name: 'D',
        cwd: '/tmp',
        command: 'x',
        url: 'http://127.0.0.1:1',
      });
    mk();
    expect(mk).toThrow();
    d.close();
  });

  it('refuses to let two apps claim the same pane', () => {
    const d = db();
    const apps = new AppStore(d);
    const a = apps.create({
      slug: 'a',
      name: 'A',
      cwd: '/tmp',
      command: 'x',
      url: 'http://127.0.0.1:1',
    });
    const b = apps.create({
      slug: 'b',
      name: 'B',
      cwd: '/tmp',
      command: 'x',
      url: 'http://127.0.0.1:2',
    });
    apps.setPane(a.id, 'PANE1');
    // Two registry rows pointing at one pty is the state that would have two
    // supervisors fighting over it — the partial unique index forbids it.
    expect(() => apps.setPane(b.id, 'PANE1')).toThrow();
    // …but any number of apps may sit unmaterialised (NULL is not unique).
    expect(() => apps.setPane(b.id, null)).not.toThrow();
    d.close();
  });

  it('keeps the registry row when the pane is cleared', () => {
    const d = db();
    const apps = new AppStore(d);
    const a = apps.create({
      slug: 'a',
      name: 'A',
      cwd: '/tmp',
      command: 'x',
      url: 'http://127.0.0.1:1',
    });
    apps.setPane(a.id, 'P');
    expect(apps.getByPane('P')?.id).toBe(a.id);
    apps.setPane(a.id, null);
    expect(apps.getById(a.id)).not.toBeNull();
    expect(apps.getByPane('P')).toBeNull();
    d.close();
  });

  it('patches only the given fields', () => {
    const d = db();
    const apps = new AppStore(d);
    const a = apps.create({
      slug: 'a',
      name: 'A',
      cwd: '/tmp',
      command: 'x',
      url: 'http://127.0.0.1:1',
    });
    const patched = apps.update(a.id, { enabled: false });
    expect(patched?.enabled).toBe(false);
    expect(patched?.name).toBe('A');
    expect(patched?.command).toBe('x');
    expect(apps.update('missing', { enabled: false })).toBeNull();
    d.close();
  });

  it('lists the pane ids of stopped apps, and only those', () => {
    const d = db();
    const apps = new AppStore(d);
    const on = apps.create({
      slug: 'on',
      name: 'On',
      cwd: '/tmp',
      command: 'x',
      url: 'http://127.0.0.1:1',
    });
    const off = apps.create({
      slug: 'off',
      name: 'Off',
      cwd: '/tmp',
      command: 'x',
      url: 'http://127.0.0.1:2',
    });
    apps.setPane(on.id, 'P_ON');
    apps.setPane(off.id, 'P_OFF');
    apps.update(off.id, { enabled: false });
    expect(apps.disabledPaneIds()).toEqual(['P_OFF']);
    d.close();
  });
});

describe('PaneStore.listServePanes with apps', () => {
  it('excludes the pane of a STOPPED app but keeps every other serve pane', () => {
    const d = db();
    const workspaces = new WorkspaceStore(d);
    const tabs = new TabStore(d);
    const panes = new PaneStore(d);
    const apps = new AppStore(d);
    const ws = workspaces.create({ name: 'W' });
    const tab = tabs.create({ name: 'T', layout: '', workspace_id: ws.id });

    const plain = panes.create({
      tab_id: tab.id,
      shell: '/bin/zsh',
      cwd: '/tmp',
      startup_cmd: 'muxpad serve --url http://127.0.0.1:1 -- ./start',
    });
    const running = panes.create({
      tab_id: tab.id,
      shell: '/bin/zsh',
      cwd: '/tmp',
      startup_cmd: 'muxpad serve --url http://127.0.0.1:2 -- ./start',
    });
    const stopped = panes.create({
      tab_id: tab.id,
      shell: '/bin/zsh',
      cwd: '/tmp',
      startup_cmd: 'muxpad serve --url http://127.0.0.1:3 -- ./start',
    });
    const onApp = apps.create({
      slug: 'on',
      name: 'On',
      cwd: '/tmp',
      command: './start',
      url: 'http://127.0.0.1:2',
    });
    const offApp = apps.create({
      slug: 'off',
      name: 'Off',
      cwd: '/tmp',
      command: './start',
      url: 'http://127.0.0.1:3',
    });
    apps.setPane(onApp.id, running.id);
    apps.setPane(offApp.id, stopped.id);
    apps.update(offApp.id, { enabled: false });

    const swept = panes.listServePanes().map((p) => p.id);
    expect(swept).toContain(plain.id);
    expect(swept).toContain(running.id);
    expect(swept).not.toContain(stopped.id);
    d.close();
  });
});
