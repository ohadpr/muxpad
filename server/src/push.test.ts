import type { PaneSpec } from '@muxpad/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from './events.js';
import { type PushPayload, type PushService, attachAttentionPush } from './push.js';
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
    cwd: '/tmp',
    env: null,
    created_at: 0,
    face: 'terminal',
    face_url: null,
    title: 'claude',
    attention,
  };
}

describe('attachAttentionPush', () => {
  let events: EventBus;
  let sent: PushPayload[];
  let push: PushService;
  let db: ReturnType<typeof openDb>;
  let tabId: string;
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
    wsSlug = ws.slug;
    tabSlug = tab.slug;
    clock = 100_000;
    attachAttentionPush({ events, db, push, now: () => clock, graceMs: 15_000 });
  });

  it('notifies on a rising edge with a workspace/tab deep link', () => {
    events.emit({ type: 'pane.added', tab_id: tabId, pane: makePane('p1', tabId, false) });
    events.emit({ type: 'pane.updated', tab_id: tabId, pane: makePane('p1', tabId, true) });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      url: `/w/${wsSlug}/t/${tabSlug}`,
      tag: 'p1',
    });
    expect(sent[0]?.body).toContain('claude');
  });

  it('does not re-notify while attention stays high, notifies again after clearing', () => {
    events.emit({ type: 'pane.added', tab_id: tabId, pane: makePane('p1', tabId, false) });
    events.emit({ type: 'pane.updated', tab_id: tabId, pane: makePane('p1', tabId, true) });
    events.emit({ type: 'pane.updated', tab_id: tabId, pane: makePane('p1', tabId, true) });
    expect(sent).toHaveLength(1);
    events.emit({ type: 'pane.updated', tab_id: tabId, pane: makePane('p1', tabId, false) });
    events.emit({ type: 'pane.updated', tab_id: tabId, pane: makePane('p1', tabId, true) });
    expect(sent).toHaveLength(2);
  });

  it('baselines unseen panes silently during the startup grace window', () => {
    // ptyd replays pre-restart attention right after boot — no blast.
    events.emit({ type: 'pane.updated', tab_id: tabId, pane: makePane('p1', tabId, true) });
    expect(sent).toHaveLength(0);
    // …but a rising edge after the baseline still notifies.
    events.emit({ type: 'pane.updated', tab_id: tabId, pane: makePane('p1', tabId, false) });
    events.emit({ type: 'pane.updated', tab_id: tabId, pane: makePane('p1', tabId, true) });
    expect(sent).toHaveLength(1);
  });

  it('notifies an unseen pane once the grace window has passed', () => {
    clock += 20_000;
    events.emit({ type: 'pane.updated', tab_id: tabId, pane: makePane('p1', tabId, true) });
    expect(sent).toHaveLength(1);
  });

  it('forgets removed panes', () => {
    events.emit({ type: 'pane.added', tab_id: tabId, pane: makePane('p1', tabId, false) });
    events.emit({ type: 'pane.removed', tab_id: tabId, pane_id: 'p1' });
    clock += 20_000;
    // Fresh sight of the id post-grace → rising edge fires.
    events.emit({ type: 'pane.updated', tab_id: tabId, pane: makePane('p1', tabId, true) });
    expect(sent).toHaveLength(1);
  });
});
