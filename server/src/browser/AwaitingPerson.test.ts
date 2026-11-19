import type Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { browserTestDb } from '../test-helpers/browserTestDb.js';
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
    // The REAL schema — see test-helpers/browserTestDb.
    return browserTestDb();
  };
  const browser = (d: Database.Database, profile: string, tab: string, pane: string) => {
    // COLUMNS NAMED, not positional. `INSERT INTO apps VALUES (…)` broke the
    // moment the table gained a column — which is the same brittleness as
    // hand-rolling the schema, one layer down.
    d.prepare(
      `INSERT INTO apps (id, slug, name, cwd, command, url, autostart, enabled, pane_id,
         created_at, updated_at)
       VALUES (?, ?, ?, '/', 'x', 'http://127.0.0.1:1', 0, 1, NULL, 0, 0)`,
    ).run(`app-${profile}`, `browser-${profile}`, `browser ${profile}`);
    d.prepare('INSERT INTO globals (key, value) VALUES (?, ?)').run(
      `browser_owner_${profile}`,
      tab,
    );
    // A WORKSPACE AND A TAB FOR THE PANE TO BELONG TO. The fixture used to
    // insert a dangling pane; on the real schema that is a foreign key
    // violation, which is the schema telling the truth about a pane with no
    // conversation.
    d.prepare(
      'INSERT INTO workspaces (id, slug, name, created_at, updated_at) VALUES (?,?,?,0,0)',
    ).run(`ws-${tab}`, `ws-${tab}`, 'W');
    d.prepare(
      `INSERT INTO tabs (id, slug, name, layout, workspace_id, created_at, updated_at)
       VALUES (?,?,?,?,?,0,0)`,
    ).run(tab, tab.toLowerCase(), tab, JSON.stringify(pane), `ws-${tab}`);
    d.prepare('INSERT INTO panes (id, tab_id, kind, created_at) VALUES (?,?,?,?)').run(
      pane,
      tab,
      'agent',
      1,
    );
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
