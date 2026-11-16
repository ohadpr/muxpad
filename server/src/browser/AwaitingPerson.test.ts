import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { SUMMONS_HOLD_MS, awaitingPanes, liveSummonsAt } from './AwaitingPerson.js';
import { BrowserEvents } from './BrowserEvents.js';

describe('when a summons is still holding its chat', () => {
  const asked = { kind: 'needs-you', reason: 'a login', at: 1_000 };

  it('holds from the summons until it is answered', () => {
    expect(liveSummonsAt([asked], 2_000)).toBe(1_000);
    expect(liveSummonsAt([asked, { kind: 'resolved', at: 1_500 }], 2_000)).toBeNull();
  });

  it('lets go of one nobody answered within the hold', () => {
    // The evening this was built for: back after 41 minutes — inside the hold.
    expect(liveSummonsAt([asked], 1_000 + 41 * 60_000)).toBe(1_000);
    expect(liveSummonsAt([asked], 1_000 + SUMMONS_HOLD_MS)).toBeNull();
  });

  it('follows the newest summons, not the first', () => {
    const again = { kind: 'needs-you', reason: 'again', at: 3_000 };
    expect(liveSummonsAt([asked, { kind: 'resolved', at: 2_000 }, again], 4_000)).toBe(3_000);
  });
});

describe('which panes are parked', () => {
  const db = () => {
    const d = new Database(':memory:');
    d.exec(`CREATE TABLE apps (
      id TEXT PRIMARY KEY, slug TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
      cwd TEXT NOT NULL, command TEXT NOT NULL, url TEXT NOT NULL,
      autostart INTEGER NOT NULL, enabled INTEGER NOT NULL, pane_id TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE globals (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE panes (id TEXT PRIMARY KEY, tab_id TEXT NOT NULL,
                          kind TEXT NOT NULL DEFAULT 'shell', created_at INTEGER NOT NULL);`);
    return d;
  };
  const browser = (d: Database.Database, profile: string, tab: string, pane: string) => {
    d.prepare(
      `INSERT INTO apps VALUES (?, ?, ?, '/', 'x', 'http://127.0.0.1:1', 0, 1, NULL, 0, 0)`,
    ).run(`app-${profile}`, `browser-${profile}`, `browser ${profile}`);
    d.prepare('INSERT INTO globals VALUES (?, ?)').run(`browser_owner_${profile}`, tab);
    d.prepare('INSERT INTO panes VALUES (?,?,?,?)').run(pane, tab, 'agent', 1);
  };

  it('is the agent pane of every chat whose browser is waiting on a person', () => {
    const d = db();
    browser(d, 'shopping', 'TAB1', 'pane-1');
    browser(d, 'other', 'TAB2', 'pane-2');
    let now = 10_000;
    const events = new BrowserEvents(d, () => now);
    events.record('shopping', { kind: 'needs-you', reason: 'captcha' });
    expect(awaitingPanes(d, now + 1)).toEqual(new Set(['pane-1']));
    now = 20_000;
    events.record('shopping', { kind: 'resolved' });
    expect(awaitingPanes(d, now + 1)).toEqual(new Set());
  });
});
