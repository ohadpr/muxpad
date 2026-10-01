import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { BrowserAttention, BrowserWheel } from './BrowserWheel.js';

/**
 * Who is driving.
 *
 * Two things can drive one browser — the agent over the Playwright MCP, and a
 * person over the screencast — and nothing currently stops them doing it at the
 * same time. The failure that motivates this is specific: you are typing a card
 * number, the agent fires a click, and the form you were halfway through is
 * gone.
 *
 * THE ASYMMETRY IS THE WHOLE DESIGN. A person can take the wheel from an agent
 * whenever they like. An agent can NEVER take it from a person. Anything else
 * and the feature is a lie.
 *
 * It lives in SQLite rather than in the agent's memory because the agent
 * process dies and restarts routinely, and a wheel held by a dead process that
 * nobody can release is worse than no wheel at all — the browser would be
 * checked out forever.
 */

let db: Database.Database;
let now: number;
let wheel: BrowserWheel;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec('CREATE TABLE globals (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  now = 1_000_000;
  wheel = new BrowserWheel(db, () => now);
});

describe('taking it', () => {
  it('is free when nobody has asked', () => {
    expect(wheel.holder('shopping')).toBeNull();
    expect(wheel.canDrive('shopping', 'agent')).toBe(true);
  });

  it('grants the wheel and remembers who and why', () => {
    const lease = wheel.take('shopping', { holder: 'human', by: 'pane-7', reason: 'card entry' });
    expect(lease.granted).toBe(true);
    expect(wheel.holder('shopping')).toMatchObject({
      holder: 'human',
      by: 'pane-7',
      reason: 'card entry',
    });
  });

  it('lets the same holder re-take without a fight', () => {
    wheel.take('shopping', { holder: 'agent', by: 'chat-1' });
    expect(wheel.take('shopping', { holder: 'agent', by: 'chat-1' }).granted).toBe(true);
  });
});

describe('the asymmetry', () => {
  it('lets a HUMAN take the wheel from an agent', () => {
    wheel.take('shopping', { holder: 'agent', by: 'chat-1' });
    const lease = wheel.take('shopping', { holder: 'human', by: 'pane-7' });
    expect(lease.granted).toBe(true);
    expect(wheel.holder('shopping')?.holder).toBe('human');
  });

  it('NEVER lets an agent take it from a human', () => {
    wheel.take('shopping', { holder: 'human', by: 'pane-7' });
    const lease = wheel.take('shopping', { holder: 'agent', by: 'chat-1' });
    expect(lease.granted).toBe(false);
    expect(wheel.holder('shopping')?.holder).toBe('human');
  });

  it('refuses agent tool calls while a human is driving', () => {
    wheel.take('shopping', { holder: 'human', by: 'pane-7' });
    expect(wheel.canDrive('shopping', 'agent')).toBe(false);
    expect(wheel.canDrive('shopping', 'human')).toBe(true);
  });

  it('says WHY it refused, so the agent can report it instead of retrying', () => {
    wheel.take('shopping', { holder: 'human', by: 'pane-7', reason: 'solving a captcha' });
    const lease = wheel.take('shopping', { holder: 'agent', by: 'chat-1' });
    expect(lease.reason).toMatch(/human/i);
  });

  it('keeps one agent from stealing from another agent', () => {
    // Two chats sharing a profile would otherwise interleave clicks.
    wheel.take('shopping', { holder: 'agent', by: 'chat-1' });
    expect(wheel.take('shopping', { holder: 'agent', by: 'chat-2' }).granted).toBe(false);
  });
});

describe('expiry', () => {
  it('expires, so a holder that died does not hold it forever', () => {
    // The decisive case: the human taps "take the wheel", puts the phone down,
    // and goes to sleep. Without a TTL the browser is checked out until someone
    // notices, which is exactly the "no owner, no alarm" failure muxpad keeps
    // running into.
    wheel.take('shopping', { holder: 'human', by: 'pane-7', ttlMs: 60_000 });
    now += 59_000;
    expect(wheel.holder('shopping')).not.toBeNull();
    now += 2_000;
    expect(wheel.holder('shopping')).toBeNull();
    expect(wheel.canDrive('shopping', 'agent')).toBe(true);
  });

  it('renews while somebody is actually there', () => {
    wheel.take('shopping', { holder: 'human', by: 'pane-7', ttlMs: 60_000 });
    now += 50_000;
    expect(wheel.renew('shopping', 'pane-7')).toBe(true);
    now += 50_000;
    expect(wheel.holder('shopping')).not.toBeNull();
  });

  it('will not renew for someone who is not holding it', () => {
    wheel.take('shopping', { holder: 'human', by: 'pane-7', ttlMs: 60_000 });
    expect(wheel.renew('shopping', 'chat-1')).toBe(false);
  });

  it('will not renew a lease that has already lapsed', () => {
    wheel.take('shopping', { holder: 'human', by: 'pane-7', ttlMs: 60_000 });
    now += 61_000;
    expect(wheel.renew('shopping', 'pane-7')).toBe(false);
  });
});

describe('releasing', () => {
  it('frees the wheel for its holder', () => {
    wheel.take('shopping', { holder: 'human', by: 'pane-7' });
    expect(wheel.release('shopping', 'pane-7')).toBe(true);
    expect(wheel.holder('shopping')).toBeNull();
  });

  it('cannot be released by anyone else', () => {
    // An agent quietly releasing the human's wheel and carrying on is the same
    // bug as taking it, wearing a different hat.
    wheel.take('shopping', { holder: 'human', by: 'pane-7' });
    expect(wheel.release('shopping', 'chat-1')).toBe(false);
    expect(wheel.holder('shopping')?.holder).toBe('human');
  });
});

describe('durability', () => {
  it('survives the process that granted it', () => {
    // The point of putting this in SQLite. A lease in the agent's memory dies
    // with the agent, and the browser stays checked out to nobody.
    wheel.take('shopping', { holder: 'human', by: 'pane-7' });
    const reborn = new BrowserWheel(db, () => now);
    expect(reborn.holder('shopping')?.by).toBe('pane-7');
  });

  it('keeps profiles apart', () => {
    wheel.take('shopping', { holder: 'human', by: 'pane-7' });
    expect(wheel.holder('research')).toBeNull();
    expect(wheel.canDrive('research', 'agent')).toBe(true);
  });

  it('treats a corrupt row as free rather than throwing', () => {
    // A wheel that cannot be read must not be a wheel that cannot be taken.
    db.prepare('INSERT INTO globals (key, value) VALUES (?, ?)').run(
      'browser_wheel_shopping',
      'not json',
    );
    expect(wheel.holder('shopping')).toBeNull();
    expect(wheel.take('shopping', { holder: 'agent', by: 'chat-1' }).granted).toBe(true);
  });
});

describe('asking for a person', () => {
  it('is SEPARATE from the wheel — the agent keeps driving while it waits', () => {
    // If asking for help released the wheel, the browser would sit unclaimed and
    // another agent could wander in and click through the very page somebody is
    // being summoned to.
    const attention = new BrowserAttention(db, () => now);
    wheel.take('shopping', { holder: 'agent', by: 'chat-1' });
    attention.raise('shopping', 'log in to Amazon');
    expect(wheel.holder('shopping')?.holder).toBe('agent');
    expect(attention.get('shopping')).toMatchObject({ reason: 'log in to Amazon' });
  });

  it('is cleared, and stays cleared', () => {
    const attention = new BrowserAttention(db, () => now);
    attention.raise('shopping', 'captcha');
    attention.clear('shopping');
    expect(attention.get('shopping')).toBeNull();
  });

  it('keeps profiles apart', () => {
    const attention = new BrowserAttention(db, () => now);
    attention.raise('shopping', 'captcha');
    expect(attention.get('research')).toBeNull();
  });

  it('treats a corrupt or empty row as nobody asking', () => {
    const attention = new BrowserAttention(db, () => now);
    db.prepare('INSERT INTO globals (key, value) VALUES (?, ?)').run(
      'browser_needs_you_shopping',
      'not json',
    );
    expect(attention.get('shopping')).toBeNull();
  });
});
