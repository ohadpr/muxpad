import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { BrowserOwner } from './BrowserOwner.js';

let db: Database.Database;
let owner: BrowserOwner;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec('CREATE TABLE globals (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  owner = new BrowserOwner(db);
});

describe('remembering which chat a browser belongs to', () => {
  it('keeps the tab id exactly as given', () => {
    // EXACTLY. A card is shown only in the chat whose id matches, and the
    // profile name is a lowercased slug of this — so recomputing it from the
    // profile would produce a card that appears in no conversation at all.
    owner.set('s-01krg3emb8f6', '01KRG3EMB8F6NFHXZH40HNKZGK');
    expect(owner.get('s-01krg3emb8f6')).toBe('01KRG3EMB8F6NFHXZH40HNKZGK');
  });

  it('knows nothing about a browser nobody registered', () => {
    expect(owner.get('default')).toBeNull();
  });

  it('takes the newest answer when a browser is registered again', () => {
    owner.set('s-a', 'TAB-1');
    owner.set('s-a', 'TAB-2');
    expect(owner.get('s-a')).toBe('TAB-2');
  });

  it('forgets on request, so a reaped browser leaves no row', () => {
    owner.set('s-a', 'TAB-1');
    owner.clear('s-a');
    expect(owner.get('s-a')).toBeNull();
  });

  it('keeps profiles apart', () => {
    owner.set('s-a', 'TAB-1');
    expect(owner.get('s-b')).toBeNull();
  });
});
