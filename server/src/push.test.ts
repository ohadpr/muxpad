import type { PaneSpec } from '@muxpad/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from './events.js';
import {
  Presence,
  type PushPayload,
  type PushService,
  attachAttentionPush,
  createPaneNotifier,
  notificationTitle,
  paneLabel,
} from './push.js';
import { PaneStore } from './store/PaneStore.js';
import { TabStore } from './store/TabStore.js';
import { WorkspaceStore } from './store/WorkspaceStore.js';
import { openDb } from './store/db.js';

function makePane(id: string, tabId: string, attention: boolean): PaneSpec {
  return {
    id,
    tab_id: tabId,
    kind: 'shell',
    url: null,
    shell: '/bin/zsh',
    startup_cmd: null,
    mode: 'deep',
    cwd: '/tmp',
    env: null,
    created_at: 0,
    face: 'terminal',
    face_url: null,
    title: 'claude',
    attention,
  };
}

describe('createPaneNotifier', () => {
  it('resolves pane → tab → workspace into title + deep link', () => {
    const db = openDb(':memory:');
    const ws = new WorkspaceStore(db).create({ name: 'Dev' });
    const tab = new TabStore(db).create({ name: 'muxpad', layout: '', workspace_id: ws.id });
    const pane = new PaneStore(db).create({ tab_id: tab.id, shell: '/bin/zsh', cwd: '/tmp' });
    const sent: PushPayload[] = [];
    const push = { send: async (p: PushPayload) => void sent.push(p) } as unknown as PushService;

    createPaneNotifier(db, push)(pane.id, 'agent finished its turn');
    expect(sent[0]).toMatchObject({
      title: tab.name,
      body: 'agent finished its turn',
      url: `/w/${ws.slug}/t/${tab.slug}?ptab=${tab.id}&pane=${pane.id}`,
      tab_id: tab.id,
      pane_id: pane.id,
      tag: pane.id,
    });
  });

  it('holds the push while a device is active, sends once presence lapses', () => {
    const db = openDb(':memory:');
    const ws = new WorkspaceStore(db).create({ name: 'Dev' });
    const tab = new TabStore(db).create({ name: 'muxpad', layout: '', workspace_id: ws.id });
    const pane = new PaneStore(db).create({ tab_id: tab.id, shell: '/bin/zsh', cwd: '/tmp' });
    const sent: PushPayload[] = [];
    const push = { send: async (p: PushPayload) => void sent.push(p) } as unknown as PushService;
    const presence = new Presence();
    const notify = createPaneNotifier(db, push, presence);

    presence.mark(); // a device just pinged
    notify(pane.id, 'finished its turn');
    expect(sent).toHaveLength(0); // held — user is active

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 120_000); // 2 min later, no heartbeat
    notify(pane.id, 'finished its turn');
    vi.useRealTimers();
    expect(sent).toHaveLength(1); // presence lapsed — push goes out
  });

  it('falls back to the root when the pane is unknown', () => {
    const db = openDb(':memory:');
    const sent: PushPayload[] = [];
    const push = { send: async (p: PushPayload) => void sent.push(p) } as unknown as PushService;
    createPaneNotifier(db, push)('nope', 'hello');
    expect(sent[0]).toMatchObject({ title: 'muxpad', url: '/' });
  });

  it('names the PANE in the title when the tab has more than one', () => {
    // The reported symptom: three agent panes in one tab produced three
    // notifications with identical titles and bodies that named nothing.
    const db = openDb(':memory:');
    const ws = new WorkspaceStore(db).create({ name: 'Dev' });
    const tab = new TabStore(db).create({ name: 'muxpad', layout: '', workspace_id: ws.id });
    const panes = new PaneStore(db);
    const a = panes.create({ tab_id: tab.id, shell: '/bin/zsh', cwd: '/tmp' });
    const b = panes.create({ tab_id: tab.id, shell: '/bin/zsh', cwd: '/tmp' });
    const sent: PushPayload[] = [];
    const push = { send: async (p: PushPayload) => void sent.push(p) } as unknown as PushService;
    const notify = createPaneNotifier(db, push, undefined, (id) =>
      id === a.id ? { title: 'claude' } : { fg: 'vite' },
    );

    notify(a.id, 'finished its turn');
    notify(b.id, 'finished its turn');
    expect(sent[0]?.title).toBe('claude · muxpad');
    expect(sent[1]?.title).toBe('vite · muxpad');
    // …and each still points at ITS OWN pane.
    expect(sent[0]?.pane_id).toBe(a.id);
    expect(sent[1]?.pane_id).toBe(b.id);
    expect(sent[0]?.tag).toBe(a.id);
    expect(sent[1]?.tag).toBe(b.id);
  });

  it('falls back to a position when a sibling pane has no label at all', () => {
    const db = openDb(':memory:');
    const ws = new WorkspaceStore(db).create({ name: 'Dev' });
    const tab = new TabStore(db).create({ name: 'muxpad', layout: '', workspace_id: ws.id });
    const panes = new PaneStore(db);
    panes.create({ tab_id: tab.id, shell: '/bin/zsh', cwd: '/tmp' });
    const b = panes.create({ tab_id: tab.id, shell: '/bin/zsh', cwd: '/tmp' });
    const sent: PushPayload[] = [];
    const push = { send: async (p: PushPayload) => void sent.push(p) } as unknown as PushService;
    createPaneNotifier(db, push)(b.id, 'wants your attention');
    expect(sent[0]?.title).toBe('Pane 2 · muxpad');
  });

  it('percent-encodes slugs in the deep link', () => {
    const db = openDb(':memory:');
    const tabs = new TabStore(db);
    const ws = new WorkspaceStore(db).create({ name: 'Dev' });
    const tab = tabs.create({ name: 'muxpad', layout: '', workspace_id: ws.id });
    tabs.update(tab.id, { slug: 'a b/c' });
    const pane = new PaneStore(db).create({ tab_id: tab.id, shell: '/bin/zsh', cwd: '/tmp' });
    const sent: PushPayload[] = [];
    const push = { send: async (p: PushPayload) => void sent.push(p) } as unknown as PushService;
    createPaneNotifier(db, push)(pane.id, 'hi');
    // An unescaped '/' would make the URL point at a DIFFERENT route entirely.
    expect(sent[0]?.url).toContain('/t/a%20b%2Fc?');
  });
});

describe('paneLabel', () => {
  it('prefers a pinned name over everything', () => {
    expect(paneLabel({ name: 'runner' }, { title: 'zsh', fg: 'vite' })).toBe('runner');
  });
  it('uses the host for a url pane', () => {
    expect(paneLabel({ kind: 'url', url: 'https://example.com/x' })).toBe('example.com');
  });
  it('keeps an unparseable url verbatim rather than dropping the label', () => {
    expect(paneLabel({ kind: 'url', url: 'not a url' })).toBe('not a url');
  });
  it('falls back live title → foreground command → null', () => {
    expect(paneLabel({}, { title: 'claude', fg: 'zsh' })).toBe('claude');
    expect(paneLabel({}, { title: '  ', fg: 'zsh' })).toBe('zsh');
    expect(paneLabel({}, {})).toBeNull();
    expect(paneLabel({})).toBeNull();
  });
});

describe('notificationTitle', () => {
  const base = { tabName: 'muxpad', label: null, position: 0, siblings: 1 };
  it('is the tab name alone for an unlabelled lone pane', () => {
    expect(notificationTitle(base)).toBe('muxpad');
  });
  it('qualifies with a real label even on a lone pane', () => {
    expect(notificationTitle({ ...base, label: 'claude' })).toBe('claude · muxpad');
  });
  it('does NOT invent a position for a lone pane', () => {
    expect(notificationTitle({ ...base, siblings: 1 })).toBe('muxpad');
    expect(notificationTitle({ ...base, siblings: 2, position: 1 })).toBe('Pane 2 · muxpad');
  });
  it('never stutters when the pane label equals the tab name', () => {
    expect(notificationTitle({ ...base, label: 'MuxPad ' })).toBe('muxpad');
  });
  it('degrades to the app name with no tab', () => {
    expect(notificationTitle({ ...base, tabName: null, label: 'claude' })).toBe('muxpad');
  });
});

describe('attachAttentionPush', () => {
  let events: EventBus;
  let sent: PushPayload[];
  let push: PushService;
  let db: ReturnType<typeof openDb>;
  let tabId: string;
  let paneId: string;
  let wsSlug: string;
  let tabSlug: string;
  let clock: number;

  beforeEach(() => {
    events = new EventBus();
    sent = [];
    push = { send: vi.fn(async (p: PushPayload) => void sent.push(p)) } as unknown as PushService;
    db = openDb(':memory:');
    const ws = new WorkspaceStore(db).create({ name: 'Dev' });
    const tab = new TabStore(db).create({ name: 'muxpad', layout: '', workspace_id: ws.id });
    tabId = tab.id;
    // The notifier resolves pane → tab → workspace from the DB, so the
    // pane must exist as a real row, with its store-minted id.
    paneId = new PaneStore(db).create({ tab_id: tab.id, shell: '/bin/zsh', cwd: '/tmp' }).id;
    wsSlug = ws.slug;
    tabSlug = tab.slug;
    clock = 100_000;
    attachAttentionPush({ events, db, push, now: () => clock, graceMs: 15_000 });
  });

  it('notifies on a rising edge with a workspace/tab deep link', () => {
    events.emit({ type: 'pane.added', tab_id: tabId, pane: makePane(paneId, tabId, false) });
    events.emit({ type: 'pane.updated', tab_id: tabId, pane: makePane(paneId, tabId, true) });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      url: `/w/${wsSlug}/t/${tabSlug}?ptab=${tabId}&pane=${paneId}`,
      tag: paneId,
      // The live pane label rides the TITLE now; the body says what happened.
      title: 'claude · muxpad',
      body: 'wants your attention',
    });
  });

  it('does not re-notify while attention stays high, notifies again after clearing', () => {
    events.emit({ type: 'pane.added', tab_id: tabId, pane: makePane(paneId, tabId, false) });
    events.emit({ type: 'pane.updated', tab_id: tabId, pane: makePane(paneId, tabId, true) });
    events.emit({ type: 'pane.updated', tab_id: tabId, pane: makePane(paneId, tabId, true) });
    expect(sent).toHaveLength(1);
    events.emit({ type: 'pane.updated', tab_id: tabId, pane: makePane(paneId, tabId, false) });
    events.emit({ type: 'pane.updated', tab_id: tabId, pane: makePane(paneId, tabId, true) });
    expect(sent).toHaveLength(2);
  });

  it('baselines unseen panes silently during the startup grace window', () => {
    // ptyd replays pre-restart attention right after boot — no blast.
    events.emit({ type: 'pane.updated', tab_id: tabId, pane: makePane(paneId, tabId, true) });
    expect(sent).toHaveLength(0);
    // …but a rising edge after the baseline still notifies.
    events.emit({ type: 'pane.updated', tab_id: tabId, pane: makePane(paneId, tabId, false) });
    events.emit({ type: 'pane.updated', tab_id: tabId, pane: makePane(paneId, tabId, true) });
    expect(sent).toHaveLength(1);
  });

  it('notifies an unseen pane once the grace window has passed', () => {
    clock += 20_000;
    events.emit({ type: 'pane.updated', tab_id: tabId, pane: makePane(paneId, tabId, true) });
    expect(sent).toHaveLength(1);
  });

  it('forgets removed panes', () => {
    events.emit({ type: 'pane.added', tab_id: tabId, pane: makePane(paneId, tabId, false) });
    events.emit({ type: 'pane.removed', tab_id: tabId, pane_id: paneId });
    clock += 20_000;
    // Fresh sight of the id post-grace → rising edge fires.
    events.emit({ type: 'pane.updated', tab_id: tabId, pane: makePane(paneId, tabId, true) });
    expect(sent).toHaveLength(1);
  });
});
