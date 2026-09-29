import { inboundTextKey } from '@muxpad/shared';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { InboundMessageStore, MAX_INBOUND_PER_TAB } from './InboundMessageStore.js';
import { TabStore } from './TabStore.js';
import { WorkspaceStore } from './WorkspaceStore.js';
import { runMigrations } from './migrations.js';

let db: Database.Database;
/** The receiving chat — a worker being briefed. */
let worker: string;
/** The sending chat — the coordinator doing the briefing. */
let boss: string;

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  const tabs = new TabStore(db);
  const ws = new WorkspaceStore(db).create({ name: 'W' }).id;
  boss = tabs.create({ name: 'muxpad', layout: '', workspace_id: ws }).id;
  worker = tabs.create({ name: 'from-agent-card', layout: '', workspace_id: ws }).id;
});

describe('InboundMessageStore', () => {
  it('records who sent a message and finds it back by the text', () => {
    const store = new InboundMessageStore(db);
    store.record({ tabId: worker, text: 'go check the PRs', fromTabId: boss, at: 100 });
    const rows = store.listByTab(worker);
    expect(rows).toEqual([{ key: inboundTextKey('go check the PRs'), at: 100, from_tab_id: boss }]);
  });

  it('keys on the TRIMMED text, matching what the relay actually delivers', () => {
    // ws.ts submitSend trims before it relays, so the transcript holds the
    // trimmed form — a heredoc's trailing newline must not cost it its card.
    const store = new InboundMessageStore(db);
    store.record({ tabId: worker, text: '  a brief\n', fromTabId: boss, at: 100 });
    expect(store.listByTab(worker)[0]?.key).toBe(inboundTextKey('a brief'));
  });

  it('records an unattributable send as a null sender rather than not at all', () => {
    // muxpad knows a send happened; it cannot name a chat behind it. The client
    // renders that as an ordinary bubble — never an invented attribution.
    const store = new InboundMessageStore(db);
    store.record({ tabId: worker, text: 'hello', fromTabId: null, at: 100 });
    expect(store.listByTab(worker)[0]?.from_tab_id).toBeNull();
  });

  it('keeps each tab to its own rows', () => {
    const store = new InboundMessageStore(db);
    store.record({ tabId: worker, text: 'for the worker', fromTabId: boss, at: 100 });
    store.record({ tabId: boss, text: 'for the boss', fromTabId: null, at: 100 });
    expect(store.listByTab(worker)).toHaveLength(1);
    expect(store.listByTab(worker)[0]?.key).toBe(inboundTextKey('for the worker'));
  });

  it('returns newest first, so a repeated text resolves to the latest send', () => {
    const store = new InboundMessageStore(db);
    store.record({ tabId: worker, text: 'again', fromTabId: boss, at: 100 });
    store.record({ tabId: worker, text: 'again', fromTabId: null, at: 200 });
    expect(store.listByTab(worker).map((r) => r.at)).toEqual([200, 100]);
  });

  it('caps the rows per tab, so a long-lived worker cannot grow this without bound', () => {
    const store = new InboundMessageStore(db);
    for (let i = 0; i < MAX_INBOUND_PER_TAB + 25; i++)
      store.record({ tabId: worker, text: `job ${i}`, fromTabId: boss, at: 100 + i });
    const rows = store.listByTab(worker);
    expect(rows).toHaveLength(MAX_INBOUND_PER_TAB);
    // The OLDEST are the ones dropped: a card for a message scrolled far out of
    // the log is worth less than one for the brief that just landed.
    expect(rows[rows.length - 1]?.key).toBe(inboundTextKey('job 25'));
  });

  it('drops a chat’s provenance when the chat is deleted', () => {
    const store = new InboundMessageStore(db);
    store.record({ tabId: worker, text: 'x', fromTabId: boss, at: 100 });
    db.prepare('DELETE FROM tabs WHERE id = ?').run(worker);
    expect(store.listByTab(worker)).toEqual([]);
  });

  it('KEEPS the record when the SENDER is deleted, unresolved rather than erased', () => {
    // Deleting the coordinator must not rewrite history in every worker it
    // briefed. The id stops resolving and the bubble renders unattributed.
    const store = new InboundMessageStore(db);
    store.record({ tabId: worker, text: 'x', fromTabId: boss, at: 100 });
    db.prepare('DELETE FROM tabs WHERE id = ?').run(boss);
    expect(store.listByTab(worker)).toHaveLength(1);
  });
});
