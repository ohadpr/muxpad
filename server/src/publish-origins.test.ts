import type Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { publishOriginTabs } from './publish-origins.js';
import { openDb } from './store/db.js';

/**
 * WHICH CHAT PUBLISHED EACH SLUG — read out of a record that already existed.
 *
 * `POST /api/publish` writes a chat action with `ref = 'publish:<slug>'`: the
 * card that appears in the conversation that published it. That is the record;
 * there is no second one. Everything here is about reading it honestly,
 * including the cases where the answer is "we don't know".
 */
describe('publishOriginTabs', () => {
  let db: Database.Database;
  const NOW = 1_800_000_000_000;

  const chat = (tabId: string, paneId: string) => {
    db.prepare(
      'INSERT INTO workspaces (id, slug, name, created_at, updated_at) VALUES (?,?,?,?,?)',
    ).run(`w-${tabId}`, `w-${tabId}`, 'W', NOW, NOW);
    db.prepare(
      `INSERT INTO tabs (id, slug, name, layout, workspace_id, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?)`,
    ).run(tabId, tabId, tabId, JSON.stringify(paneId), `w-${tabId}`, NOW, NOW);
    db.prepare('INSERT INTO panes (id, tab_id, shell, cwd, created_at) VALUES (?,?,?,?,?)').run(
      paneId,
      tabId,
      '/bin/zsh',
      '/tmp',
      NOW,
    );
  };

  const published = (slug: string, paneId: string, at: number) => {
    db.prepare(
      `INSERT INTO chat_actions (id, pane_id, at, kind, title, body, url, state, detail, ref)
       VALUES (?,?,?,?,?,NULL,?,?,NULL,?)`,
    ).run(
      `act-${slug}-${at}`,
      paneId,
      at,
      'publish.create',
      `Published ${slug}`,
      'u',
      'sent',
      `publish:${slug}`,
    );
  };

  beforeEach(() => {
    // `openDb`, which is what the server calls — one schema, one set of
    // pragmas, no drift. (It states `foreign_keys = ON`; better-sqlite3
    // already defaults to it, measured rather than assumed. The cascade this
    // file relies on is therefore real either way.)
    db = openDb(':memory:');
  });

  it('maps a slug to the TAB of the pane that published it', () => {
    // The action records a pane; a chat is a tab. The join is the whole job.
    chat('home', 'p1');
    published('games-aaaaaaaa', 'p1', NOW);
    expect(publishOriginTabs(db).get('games-aaaaaaaa')).toBe('home');
  });

  it('has no answer for a slug nobody published from a chat', () => {
    // `muxpad publish` from an ordinary shell sends no pane, so no action is
    // written. That is the common case, not a defect.
    expect(publishOriginTabs(db).size).toBe(0);
  });

  it('ignores actions that are not publishes', () => {
    chat('home', 'p1');
    db.prepare(
      `INSERT INTO chat_actions (id, pane_id, at, kind, title, body, url, state, detail, ref)
       VALUES ('a1','p1',?, 'slack.post','Posted',NULL,NULL,'sent',NULL,'slack:C123/1.2')`,
    ).run(NOW);
    expect(publishOriginTabs(db).size).toBe(0);
  });

  it('lets the LATEST publish win, so an --update from another chat moves it', () => {
    // The current answer to "where does this come from" is the chat that
    // updated it, which is why the query is ORDERED rather than arbitrary.
    //
    // INSERTED NEWEST-FIRST on purpose. With the rows inserted in time order,
    // SQLite returns them in rowid order and an unordered query gets the right
    // answer by accident — which it did: dropping the ORDER BY left this test
    // green. Writing the later publish first means only the sort can save it.
    chat('first', 'p1');
    chat('second', 'p2');
    published('report-aaaaaaaa', 'p2', NOW + 1000);
    published('report-aaaaaaaa', 'p1', NOW);
    expect(publishOriginTabs(db).get('report-aaaaaaaa')).toBe('second');
  });

  it('has no origin once the chat that published it is deleted', () => {
    // A pane that no longer exists is not a place to go back to. The artifact
    // is still published and still listed; it simply has no origin.
    //
    // THE CASCADE DOES THIS, not the join: `chat_actions.pane_id` is
    // `ON DELETE CASCADE`, so the card goes with the conversation. The inner
    // join in the query is a second guard against an orphan this schema
    // cannot actually produce — worth keeping, not worth claiming a test for.
    chat('home', 'p1');
    published('games-aaaaaaaa', 'p1', NOW);
    expect(publishOriginTabs(db).size).toBe(1);
    db.prepare('DELETE FROM panes WHERE id = ?').run('p1');
    expect(db.prepare('SELECT COUNT(*) AS n FROM chat_actions').get()).toEqual({ n: 0 });
    expect(publishOriginTabs(db).size).toBe(0);
  });

  it('answers with an empty map rather than throwing when the table is absent', () => {
    // A label is never a precondition for listing what is published.
    expect(publishOriginTabs({ prepare: () => ({ all: () => [] }) } as never).size).toBe(0);
    expect(
      publishOriginTabs({
        prepare: () => {
          throw new Error('no such table: chat_actions');
        },
      } as never).size,
    ).toBe(0);
  });
});
