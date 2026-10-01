import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  agentPaneForTab,
  handbackMessage,
  nudgeForHandback,
  outstandingSummons,
} from './ResumeAfterHandback.js';

describe('what the agent is told when the browser comes back', () => {
  it('says the wait is over', () => {
    expect(handbackMessage(null)).toContain('yours again');
  });

  it('names what it was asked for, so a queued message still makes sense later', () => {
    // It can arrive a turn later, after other things have happened. A bare "go
    // ahead" would then be an instruction with no subject.
    expect(handbackMessage('Amazon needs a login')).toContain('Amazon needs a login');
  });

  it('tells it to look at the page before acting on what it remembers', () => {
    // Resuming from the snapshot taken before the handoff is the documented way
    // this exchange goes wrong: the url has usually changed and the DOM has.
    expect(handbackMessage(null).toLowerCase()).toContain('changed');
  });

  it('survives a reason that is only whitespace', () => {
    expect(handbackMessage('   ')).toBe(handbackMessage(null));
  });
});

describe('when a hand-back should wake somebody', () => {
  const held = { holder: 'human' as const, by: 'viewer-default' };
  const needsYou = { reason: 'a login' };
  const base = { held, by: 'viewer-default', needsYou, paneId: 'pane-1' };

  it('wakes the conversation that asked', () => {
    const n = nudgeForHandback(base);
    expect(n?.paneId).toBe('pane-1');
    expect(n?.text).toContain('a login');
  });

  it('stays quiet when an AGENT releases its own wheel', () => {
    // The agent is the thing being told. Telling it would be a loop, and the
    // agent releases its wheel as ordinary bookkeeping many times a session.
    expect(
      nudgeForHandback({
        ...base,
        held: { holder: 'agent', by: 'pane-1' },
        by: 'pane-1',
      }),
    ).toBeNull();
  });

  it('stays quiet when nobody was asked for', () => {
    // Somebody took the wheel to look at something. They interrupted nothing,
    // so there is nothing to hand back to.
    expect(nudgeForHandback({ ...base, needsYou: null })).toBeNull();
  });

  it('stays quiet when the release was not the holder', () => {
    // A failed release changed nothing, and must not announce that it did.
    expect(nudgeForHandback({ ...base, by: 'somebody-else' })).toBeNull();
  });

  it('stays quiet when nothing held the wheel', () => {
    expect(nudgeForHandback({ ...base, held: null })).toBeNull();
  });

  it('stays quiet when the conversation has no pane to deliver into', () => {
    // A chat whose pane is gone. Nothing to send to, and a nudge addressed to a
    // dead pane is a message nobody will ever read.
    expect(nudgeForHandback({ ...base, paneId: null })).toBeNull();
  });
});

describe('finding the pane a conversation is running in', () => {
  const db = () => {
    const d = new Database(':memory:');
    d.exec(`CREATE TABLE tabs (id TEXT PRIMARY KEY);
            CREATE TABLE panes (id TEXT PRIMARY KEY, tab_id TEXT NOT NULL,
                                kind TEXT NOT NULL DEFAULT 'shell',
                                created_at INTEGER NOT NULL);`);
    return d;
  };

  it('finds the agent pane of a tab', () => {
    const d = db();
    d.prepare('INSERT INTO panes VALUES (?,?,?,?)').run('p1', 'TAB1', 'agent', 1);
    expect(agentPaneForTab(d, 'TAB1')).toBe('p1');
  });

  it('ignores a terminal sharing the tab', () => {
    // A chat can have a shell pane beside the agent. Sending a sentence of
    // English to a shell types it at a prompt.
    const d = db();
    d.prepare('INSERT INTO panes VALUES (?,?,?,?)').run('sh', 'TAB1', 'shell', 2);
    d.prepare('INSERT INTO panes VALUES (?,?,?,?)').run('p1', 'TAB1', 'agent', 1);
    expect(agentPaneForTab(d, 'TAB1')).toBe('p1');
  });

  it('takes the newest, because a respawned pane replaces its predecessor', () => {
    // Resolved at hand-back rather than remembered from the summons for exactly
    // this reason: the pane that raised the card may be dead by the time
    // somebody gets to their phone.
    const d = db();
    d.prepare('INSERT INTO panes VALUES (?,?,?,?)').run('old', 'TAB1', 'agent', 1);
    d.prepare('INSERT INTO panes VALUES (?,?,?,?)').run('new', 'TAB1', 'agent', 9);
    expect(agentPaneForTab(d, 'TAB1')).toBe('new');
  });

  it('answers nothing for a tab with no agent', () => {
    expect(agentPaneForTab(db(), 'NOPE')).toBeNull();
  });

  it('answers nothing rather than throwing on a database without panes', () => {
    const d = new Database(':memory:');
    expect(agentPaneForTab(d, 'TAB1')).toBeNull();
  });
});

describe('whether anybody is still being waited on', () => {
  /**
   * Read from the log rather than the live flag, because the flag is already
   * gone: taking the wheel clears it on purpose — arriving IS the
   * acknowledgement. Gating the nudge on it meant the nudge never fired, which
   * is how this was caught.
   */
  it('finds a summons nobody has answered', () => {
    expect(outstandingSummons([{ kind: 'needs-you', reason: 'a login' }])).toEqual({
      reason: 'a login',
    });
  });

  it('forgets one that was already resolved', () => {
    expect(
      outstandingSummons([{ kind: 'needs-you', reason: 'a login' }, { kind: 'resolved' }]),
    ).toBeNull();
  });

  it('takes the LATEST, so a second errand is not answered with the first', () => {
    expect(
      outstandingSummons([
        { kind: 'needs-you', reason: 'a login' },
        { kind: 'resolved' },
        { kind: 'needs-you', reason: 'a captcha' },
      ]),
    ).toEqual({ reason: 'a captcha' });
  });

  it('ignores moments that are not summonses', () => {
    expect(outstandingSummons([{ kind: 'opened' }, { kind: 'closing' }])).toBeNull();
  });

  it('answers nothing for an empty log', () => {
    expect(outstandingSummons([])).toBeNull();
  });
});
