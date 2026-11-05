import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hostMayPublishAs } from './publish-actions.js';
import { recordSlackAction, resolveSlackAction, stateFromBroker } from './slack-actions.js';
import { ChatActionStore } from './store/ChatActionStore.js';
import { PaneStore } from './store/PaneStore.js';
import { TabStore } from './store/TabStore.js';
import { WorkspaceStore } from './store/WorkspaceStore.js';
import { openDb } from './store/db.js';

/**
 * A SLACK MESSAGE, AS A CARD IN THE CHAT THAT SENT IT.
 *
 * The conversation already holds the agent SAYING it posted — written before
 * the answer is known, because every outbound integration goes through an
 * approval. What was missing was the effect: a minute later "did that actually
 * go?" had no surface, since the approval alert vanishes the moment it is
 * answered.
 */

let dir: string;
let db: Database.Database;
let pane: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'muxpad-slack-actions-'));
  db = openDb(join(dir, 'db.sqlite'));
  const ws = new WorkspaceStore(db).create({ name: 'W' }).id;
  const tab = new TabStore(db).create({ name: 'T', layout: '', workspace_id: ws }).id;
  pane = new PaneStore(db).create({ tab_id: tab, shell: '/bin/zsh' }).id;
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const store = () => new ChatActionStore(db);
const REQ = '6c1b7c2a-0b1e-4c3d-9f8a-1b2c3d4e5f60';

describe('recording a post', () => {
  it('writes a card naming the channel and holding the message', () => {
    recordSlackAction(db, {
      action: 'slack.post',
      payload: { ref: '#general', text: 'the build is green' },
      pane,
      result: { id: REQ, state: 'pending' },
    });
    const [card] = store().listForPane(pane);
    expect(card?.kind).toBe('slack.post');
    expect(card?.title).toBe('Posted to #general');
    expect(card?.body).toBe('the build is green');
    // Waiting is the state it is BORN in, and usually stays in for a while.
    expect(card?.state).toBe('pending');
  });

  it('names a raw channel id as one rather than printing it bare', () => {
    recordSlackAction(db, {
      action: 'slack.post',
      payload: { ref: 'C01ABCDEF', text: 'x' },
      pane,
      result: { id: REQ, state: 'pending' },
    });
    expect(store().listForPane(pane)[0]?.title).toBe('Posted to a channel (C01ABCDEF)');
  });

  it('adds the # a person would have typed', () => {
    recordSlackAction(db, {
      action: 'slack.post',
      payload: { ref: 'general', text: 'x' },
      pane,
      result: { id: REQ, state: 'pending' },
    });
    expect(store().listForPane(pane)[0]?.title).toBe('Posted to #general');
  });

  it('draws every verb that is an ACT, and nothing that is a read', () => {
    const verbs = ['slack.post', 'slack.dm', 'slack.edit', 'slack.upload', 'slack.react'];
    for (const [i, action] of verbs.entries()) {
      recordSlackAction(db, {
        action,
        payload: { ref: '#g', text: 't', emoji: 'tada', filename: 'f.png' },
        pane,
        result: { id: `${REQ.slice(0, -1)}${i}`, state: 'pending' },
      });
    }
    // A read is not an act: `slack.read` has no title and records nothing.
    recordSlackAction(db, {
      action: 'slack.read',
      payload: { ref: '#g' },
      pane,
      result: { id: REQ, state: 'pending' },
    });
    expect(store().listForPane(pane)).toHaveLength(verbs.length);
  });

  it('records NOTHING without a broker request id', () => {
    // Without one the act can never be resolved, and a card stuck on "waiting
    // for you" forever is worse than no card.
    recordSlackAction(db, {
      action: 'slack.post',
      payload: { ref: '#g', text: 'x' },
      pane,
      result: { state: 'pending' },
    });
    expect(store().listForPane(pane)).toHaveLength(0);
  });

  it('never throws — a card is a record of a send, not a precondition', () => {
    // The table is dropped from under it: the message still has to go.
    db.exec('DROP TABLE chat_actions');
    expect(() =>
      recordSlackAction(db, {
        action: 'slack.post',
        payload: { ref: '#g', text: 'x' },
        pane,
        result: { id: REQ, state: 'pending' },
      }),
    ).not.toThrow();
  });
});

describe('resolving it', () => {
  const recorded = () => {
    recordSlackAction(db, {
      action: 'slack.post',
      payload: { ref: '#general', text: 'hello' },
      pane,
      result: { id: REQ, state: 'pending' },
    });
  };

  it('marks it sent, and keeps the permalink it came back with', () => {
    recorded();
    resolveSlackAction(db, {
      id: REQ,
      state: 'complete',
      permalink: 'https://slack.example/p123',
    });
    const card = store().listForPane(pane)[0];
    expect(card?.state).toBe('sent');
    expect(card?.url).toBe('https://slack.example/p123');
  });

  it('keeps a DECLINE apart from a failure', () => {
    // One is a decision and the other is a fault. Drawing a decision as a
    // failure invites somebody to retry it.
    recorded();
    resolveSlackAction(db, { id: REQ, state: 'rejected' });
    const card = store().listForPane(pane)[0];
    expect(card?.state).toBe('declined');
    expect(card?.detail).toMatch(/declined/i);
  });

  it('reports the reason a send failed', () => {
    recorded();
    resolveSlackAction(db, { id: REQ, state: 'failed', error: 'channel_not_found' });
    expect(store().listForPane(pane)[0]?.detail).toBe('channel_not_found');
  });

  it('says so when an approval simply ran out', () => {
    recorded();
    resolveSlackAction(db, { id: REQ, state: 'expired' });
    const card = store().listForPane(pane)[0];
    expect(card?.state).toBe('failed');
    expect(card?.detail).toMatch(/expired/i);
  });

  it('ignores the in-between states instead of churning the row', () => {
    // The broker reports `verifying` and `executing` on the way, and the
    // approvals poll asks about every outstanding request repeatedly.
    recorded();
    for (const state of ['pending', 'verifying', 'executing']) {
      resolveSlackAction(db, { id: REQ, state });
      expect(store().listForPane(pane)[0]?.state).toBe('pending');
    }
  });

  it('does NOT walk a finished act back, however late the poll', () => {
    // The broker's status endpoint keeps answering after an act completes. The
    // card is the history of the act, not a mirror of the last poll.
    recorded();
    resolveSlackAction(db, { id: REQ, state: 'complete' });
    resolveSlackAction(db, { id: REQ, state: 'failed', error: 'late' });
    expect(store().listForPane(pane)[0]?.state).toBe('sent');
  });

  it('shrugs at a request it has no card for', () => {
    // Normal: muxpad polls every request it knows about, including ones made
    // before this table existed and by verbs that record nothing.
    expect(() => resolveSlackAction(db, { id: REQ, state: 'complete' })).not.toThrow();
  });
});

describe('the broker’s states, mapped', () => {
  it('treats anything unrecognised as still open', () => {
    // Asserting an outcome muxpad has not been told is the one wrong answer.
    expect(stateFromBroker('complete')).toBe('sent');
    expect(stateFromBroker('rejected')).toBe('declined');
    expect(stateFromBroker('failed')).toBe('failed');
    expect(stateFromBroker('expired')).toBe('failed');
    expect(stateFromBroker('verifying')).toBe('pending');
    expect(stateFromBroker('something-new')).toBe('pending');
    expect(stateFromBroker(undefined)).toBe('pending');
  });
});

describe('the cards of a chat', () => {
  it('come back oldest first, so they place into the log in order', () => {
    for (const [i, text] of ['one', 'two', 'three'].entries()) {
      store().record({
        pane_id: pane,
        kind: 'slack.post',
        title: `Posted ${text}`,
        at: 1_000 + i,
        ref: `r${i}`,
      });
    }
    expect(
      store()
        .listForPane(pane)
        .map((a) => a.title),
    ).toEqual(['Posted one', 'Posted two', 'Posted three']);
  });

  it('go when the chat goes', () => {
    store().record({ pane_id: pane, kind: 'slack.post', title: 'x', ref: 'r' });
    new PaneStore(db).delete(pane);
    expect(store().listForPane(pane)).toHaveLength(0);
  });

  it('belong to ONE chat', () => {
    const other = new PaneStore(db).create({
      tab_id: new TabStore(db).create({
        name: 'T2',
        layout: '',
        workspace_id: new WorkspaceStore(db).list()[0]?.id as string,
      }).id,
      shell: '/bin/zsh',
    }).id;
    store().record({ pane_id: pane, kind: 'slack.post', title: 'mine', ref: 'r1' });
    store().record({ pane_id: other, kind: 'slack.post', title: 'theirs', ref: 'r2' });
    expect(
      store()
        .listForPane(pane)
        .map((a) => a.title),
    ).toEqual(['mine']);
  });

  it('cannot be written for a chat that does not exist', () => {
    // The FK is what makes `deleteForPane` unnecessary at every pane-delete
    // site — and it also refuses a card nothing could ever display.
    expect(() =>
      store().record({ pane_id: 'no-such-pane', kind: 'slack.post', title: 'x', ref: 'r3' }),
    ).toThrow();
  });
});

/**
 * WHO OWNS A PUBLISHED NAME.
 *
 * `--name` is republish-in-place against one flat namespace, so a host naming
 * an artifact it does not own replaces that artifact at the url somebody has
 * already shared — no `update: true` needed. Found in review; this is the rule
 * that closes it, and the ownership record is the publish action itself.
 */
describe('hostMayPublishAs', () => {
  const store = () => new ChatActionStore(db);

  it('allows a name nothing is published under', () => {
    expect(hostMayPublishAs(db, null, 'trayo')).toBe(true);
  });

  it('allows a host to republish ITS OWN artifact', () => {
    const tab = new TabStore(db).create({
      name: 'T',
      layout: '',
      workspace_id: new WorkspaceStore(db).list()[0]?.id as string,
    }).id;
    const remote = new PaneStore(db).create({ tab_id: tab, shell: '/bin/bash' }).id;
    db.prepare('UPDATE panes SET node_id = ? WHERE id = ?').run('trayo', remote);
    store().record({
      pane_id: remote,
      kind: 'publish.create',
      title: 'Published report',
      ref: 'publish:report-ab12',
    });
    expect(hostMayPublishAs(db, 'report-ab12', 'trayo')).toBe(true);
  });

  it('REFUSES a host the artifact a LOCAL chat published', () => {
    // The attack: a compromised VM names the mac's weekly report and replaces
    // it at its established public url.
    store().record({
      pane_id: pane, // the local pane from the outer beforeEach
      kind: 'publish.create',
      title: 'Published report',
      ref: 'publish:report-ab12',
    });
    expect(hostMayPublishAs(db, 'report-ab12', 'trayo')).toBe(false);
  });

  it('REFUSES an UNOWNED artifact, and that is deliberate', () => {
    // Hundreds predate the record and have no row. Treating "no owner" as
    // "anyone's" would leave exactly the hole this closes — and those are the
    // oldest and most-shared links on the install.
    expect(hostMayPublishAs(db, 'ancient-slug-9z', 'trayo')).toBe(false);
  });

  it('refuses when it cannot tell at all', () => {
    // No table, no join, no answer — and "I cannot tell" must not authorise
    // replacing public content.
    db.exec('DROP TABLE chat_actions');
    expect(hostMayPublishAs(db, 'report-ab12', 'trayo')).toBe(false);
  });
});
