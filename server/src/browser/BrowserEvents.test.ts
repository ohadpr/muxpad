import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { BROWSER_EVENT_CAP, BrowserEvents } from './BrowserEvents.js';

/**
 * A browser's moments, so they can sit IN a conversation.
 *
 * The card used to be pinned above the transcript, which made it a status
 * light: always there, saying whatever was true right now. That is the wrong
 * shape. A browser opening is a thing that HAPPENED, at a moment, in a
 * conversation — and an agent getting stuck is a second thing that happened
 * later. Both belong in the log where they occurred, with the chat continuing
 * past them, exactly like a spawned worker's launch and its report.
 *
 * So the server records moments, and the client draws them in place.
 */

let db: Database.Database;
let now: number;
let events: BrowserEvents;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec('CREATE TABLE globals (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  now = 1_000_000;
  events = new BrowserEvents(db, () => now);
});

describe('recording', () => {
  it('stamps an event with when it happened and where', () => {
    events.record('shopping', { kind: 'opened', tabId: 'tab-1' });
    expect(events.list('shopping')).toEqual([{ kind: 'opened', tabId: 'tab-1', at: 1_000_000 }]);
  });

  it('keeps a reason, which is the whole content of a summons', () => {
    events.record('shopping', { kind: 'needs-you', tabId: 'tab-1', reason: 'log in to Amazon' });
    expect(events.list('shopping')[0]).toMatchObject({ reason: 'log in to Amazon' });
  });

  it('keeps them in the order they happened', () => {
    events.record('shopping', { kind: 'opened', tabId: 'tab-1' });
    now += 5_000;
    events.record('shopping', { kind: 'needs-you', tabId: 'tab-1', reason: 'captcha' });
    expect(events.list('shopping').map((e) => e.kind)).toEqual(['opened', 'needs-you']);
  });

  it('records an event with no tab at all', () => {
    // A browser started from the CLI belongs to no conversation. It still
    // happened, and the client decides where to show it.
    events.record('shopping', { kind: 'opened' });
    expect(events.list('shopping')[0]?.tabId).toBeUndefined();
  });

  it('keeps profiles apart', () => {
    events.record('shopping', { kind: 'opened' });
    expect(events.list('research')).toEqual([]);
  });
});

describe('not growing forever', () => {
  it('caps the log, dropping the OLDEST', () => {
    // This rides every poll of /api/browsers. An unbounded array in a KV row
    // would quietly become the most expensive thing on the page.
    for (let i = 0; i < BROWSER_EVENT_CAP + 10; i++) {
      now += 1000;
      events.record('shopping', { kind: 'opened', reason: `e${i}` });
    }
    const list = events.list('shopping');
    expect(list).toHaveLength(BROWSER_EVENT_CAP);
    expect(list[0]?.reason).toBe(`e${10}`);
    expect(list.at(-1)?.reason).toBe(`e${BROWSER_EVENT_CAP + 9}`);
  });
});

describe('surviving bad data', () => {
  it('reads a corrupt row as no events rather than throwing', () => {
    // These are decoration on a conversation. A malformed row must not be able
    // to take the chat down with it.
    db.prepare('INSERT INTO globals (key, value) VALUES (?, ?)').run(
      'browser_events_shopping',
      'not json',
    );
    expect(events.list('shopping')).toEqual([]);
  });

  it('recovers by overwriting, so one bad write is not permanent', () => {
    db.prepare('INSERT INTO globals (key, value) VALUES (?, ?)').run(
      'browser_events_shopping',
      '{"not":"an array"}',
    );
    events.record('shopping', { kind: 'opened' });
    expect(events.list('shopping')).toHaveLength(1);
  });
});

describe('clearing', () => {
  it('forgets a profile’s history', () => {
    events.record('shopping', { kind: 'opened' });
    events.clear('shopping');
    expect(events.list('shopping')).toEqual([]);
  });
});

describe('a picture that arrives after the moment did', () => {
  /**
   * The browser photographs itself on the way OUT, so the card for a closed one
   * shows the last page it was on. A still captured when it opened would show
   * the first page it visited, presented as what it did — which is worse than no
   * picture, because it is confidently wrong.
   */
  it('marks the moment it belongs to', () => {
    const m = events.record('shopping', { kind: 'opened', tabId: 'tab-1' });
    expect(events.attachShot('shopping', m.at)).toBe(true);
    expect(events.list('shopping')[0]?.shot).toBe(true);
  });

  it('says no when there is no such moment, rather than inventing one', () => {
    events.record('shopping', { kind: 'opened' });
    expect(events.attachShot('shopping', 999)).toBe(false);
  });

  it('leaves the other moments alone', () => {
    const first = events.record('shopping', { kind: 'opened', tabId: 'tab-1' });
    now += 10;
    events.record('shopping', { kind: 'needs-you', reason: 'log in', tabId: 'tab-1' });
    events.attachShot('shopping', first.at);
    expect(events.list('shopping')[1]?.shot).toBeUndefined();
  });

  it('finds the newest moment, ignoring bookkeeping', () => {
    // `resolved` is not a card, so it is not something to illustrate.
    events.record('shopping', { kind: 'opened', tabId: 'tab-1' });
    now += 5;
    const ask = events.record('shopping', { kind: 'needs-you', reason: 'log in' });
    now += 5;
    events.record('shopping', { kind: 'resolved' });
    expect(events.newestMoment('shopping')?.at).toBe(ask.at);
  });

  it('has no newest moment when nothing has happened', () => {
    expect(events.newestMoment('quiet')).toBeNull();
  });
});
