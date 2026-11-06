import { describe, expect, it } from 'vitest';
import { UNSCOPED, mayUse, readPolicy } from './scope.js';

/**
 * The function that decides whether a personal chat can touch the work Slack.
 * Pinned case by case, including the ones where failing open would be quiet.
 */
const P = (enforce: boolean, allow: Record<string, string[]>) => ({ enforce, allow });

describe('host scoping', () => {
  it('allows anything while enforcement is off — and SAYS it was not scoped', () => {
    // The flag travels with the decision so the prompt and the audit record can
    // state that nothing was checked, rather than implying a check happened.
    const d = mayUse('slack', 'local', UNSCOPED);
    expect(d.ok).toBe(true);
    expect(d.enforced).toBe(false);
  });

  it('refuses a connector with no entry when enforcing — deny is the default', () => {
    const d = mayUse('slack', 'trayo', P(true, {}));
    expect(d.ok).toBe(false);
    expect(d.reason).toMatch(/no machine is allowed/);
  });

  it('refuses a connector this build has never heard of', () => {
    expect(mayUse('whatsapp', 'trayo', P(true, { slack: ['trayo'] })).ok).toBe(false);
  });

  it('allows the owning host and refuses every other', () => {
    const policy = P(true, { slack: ['trayo'], msgvault: ['local'] });
    expect(mayUse('slack', 'trayo', policy).ok).toBe(true);
    expect(mayUse('msgvault', 'local', policy).ok).toBe(true);
    // The two cases the owner actually asked for.
    const personalSlack = mayUse('slack', 'local', policy);
    expect(personalSlack.ok).toBe(false);
    expect(personalSlack.reason).toMatch(/scoped to trayo.*runs on local/);
    expect(mayUse('msgvault', 'trayo', policy).ok).toBe(false);
  });

  it('carries the resolved origin into the decision, refused or not', () => {
    // The origin is never taken from a request body, so it has to come back
    // with the answer for the audit record to be worth anything.
    expect(mayUse('slack', 'trayo', P(true, { slack: ['local'] })).origin).toBe('trayo');
    expect(mayUse('slack', 'trayo', P(true, { slack: ['trayo'] })).origin).toBe('trayo');
  });
});

describe('reading the stored policy', () => {
  it('treats absent, empty and corrupt as UNSCOPED, never as deny-all', () => {
    // A corrupt pref must not silently switch a working connector off…
    for (const raw of [null, undefined, '', 'not json', '[]', '7', '{']) {
      expect(readPolicy(raw), String(raw)).toEqual(UNSCOPED);
    }
  });

  it('…and never as enforcement that was not asked for', () => {
    // …nor silently switch scoping ON, which would read as a working rule.
    expect(readPolicy('{"allow":{"slack":["trayo"]}}').enforce).toBe(false);
  });

  it('keeps only well-formed entries', () => {
    const p = readPolicy(
      JSON.stringify({
        enforce: true,
        allow: {
          slack: ['trayo'],
          'Bad Name': ['x'],
          // Uppercase must be DROPPED, not folded: a case-insensitive key regex
          // survived the first suite, and `Slack` reaching the same entry as
          // `slack` would mean two names for one rule.
          Slack: ['anywhere'],
          empty: [],
          notlist: 'trayo',
          mix: ['a', 7],
        },
      }),
    );
    expect(p.enforce).toBe(true);
    expect(Object.keys(p.allow).sort()).toEqual(['mix', 'slack']);
    expect(p.allow.slack).toEqual(['trayo']);
    expect(p.allow.mix).toEqual(['a']);
  });

  it('enforce must be exactly true, not truthy', () => {
    expect(readPolicy('{"enforce":"yes","allow":{"slack":["t"]}}').enforce).toBe(false);
    expect(readPolicy('{"enforce":1,"allow":{"slack":["t"]}}').enforce).toBe(false);
  });
});

describe('the policy file', () => {
  const tmp = async () => {
    const { mkdtempSync, writeFileSync, chmodSync, symlinkSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    return {
      dir: mkdtempSync(join(tmpdir(), 'cpol-')),
      writeFileSync,
      chmodSync,
      symlinkSync,
      join,
    };
  };

  it('is UNSCOPED when absent — the state this ships in', async () => {
    const { loadPolicy } = await import('./scope.js');
    expect(loadPolicy('/nonexistent/connectors.json')).toEqual(UNSCOPED);
  });

  it('SEALS everything when the file is not root-owned', async () => {
    // The cheapest attack on a policy you ignore when it looks broken is to
    // break it. So an untrusted file denies rather than disabling scoping.
    const { loadPolicy } = await import('./scope.js');
    const t = await tmp();
    const f = t.join(t.dir, 'connectors.json');
    t.writeFileSync(f, JSON.stringify({ enforce: true, allow: { slack: ['trayo'] } }));
    const p = loadPolicy(f); // owned by the test user, not root
    expect(p.enforce).toBe(true);
    expect(p.allow).toEqual({});
    expect(p.problem).toMatch(/not root-owned/);
    expect(mayUse('slack', 'trayo', p).ok).toBe(false);
  });

  it('seals a symlink even if its target would be fine', async () => {
    const { loadPolicy } = await import('./scope.js');
    const t = await tmp();
    const real = t.join(t.dir, 'real.json');
    const link = t.join(t.dir, 'link.json');
    t.writeFileSync(real, '{"enforce":false,"allow":{}}');
    t.symlinkSync(real, link);
    // O_NOFOLLOW refuses the open outright now, so the reason is the errno
    // rather than our own word for it. Either way it seals.
    const p = loadPolicy(link);
    expect(p.enforce).toBe(true);
    expect(p.allow).toEqual({});
    expect(p.problem).toMatch(/ELOOP|symlink/);
  });
});

describe('exact match, pinned', () => {
  // A prefix or case-insensitive comparison survived the whole first suite.
  const policy = { enforce: true, allow: { slack: ['trayo'] } };
  it('refuses a node whose name merely starts with an allowed one', () => {
    expect(mayUse('slack', 'trayo2', policy).ok).toBe(false);
    expect(mayUse('slack', 'tray', policy).ok).toBe(false);
  });
  it('refuses a different case and stray whitespace', () => {
    expect(mayUse('slack', 'Trayo', policy).ok).toBe(false);
    expect(mayUse('slack', 'trayo ', policy).ok).toBe(false);
  });
  it('allows only the exact name', () => {
    expect(mayUse('slack', 'trayo', policy).ok).toBe(true);
  });
});

describe('a connector named after an Object property', () => {
  it('is refused, not thrown', async () => {
    // These matched the key regex and reached Object's own properties, so
    // `allowed.length` was read off a function and threw instead of refusing.
    const { readPolicy } = await import('./scope.js');
    const p = readPolicy(JSON.stringify({ enforce: true, allow: { slack: ['trayo'] } }));
    // Two defences, and each needs its own case. `readPolicy` builds a
    // null-prototype allow, so a lookup cannot reach Object at all…
    const names = ['constructor', 'hasOwnProperty', 'isPrototypeOf', 'toString', 'valueOf'];
    for (const name of names) {
      expect(() => mayUse(name, 'trayo', p), name).not.toThrow();
      expect(mayUse(name, 'trayo', p).ok, name).toBe(false);
    }
    // …but a caller can hand in an ordinary object literal, which has one. The
    // `Object.hasOwn` guard is what covers that, and without this case a
    // sabotage of it survives.
    const literal = { enforce: true, allow: { slack: ['trayo'] } };
    for (const name of names) {
      expect(() => mayUse(name, 'trayo', literal), `literal ${name}`).not.toThrow();
      expect(mayUse(name, 'trayo', literal).ok, `literal ${name}`).toBe(false);
    }
  });
});

describe('file metadata, table-tested', () => {
  const st = (
    o: Partial<{ file: boolean; dir: boolean; uid: number; mode: number; nlink: number }>,
  ) =>
    ({
      isFile: () => o.file !== false,
      isDirectory: () => o.dir === true,
      uid: o.uid ?? 0,
      mode: o.mode ?? 0o644,
      nlink: o.nlink ?? 1,
    }) as unknown as import('node:fs').Stats;

  it('names each refusal, and passes a root-owned 0644 regular file', async () => {
    const { trustProblem } = await import('./scope.js');
    expect(trustProblem(st({}), 'f')).toBeNull();
    expect(trustProblem(st({ file: false }), 'f')).toMatch(/not a regular file/);
    expect(trustProblem(st({ uid: 501 }), 'f')).toMatch(/not root-owned/);
    expect(trustProblem(st({ mode: 0o664 }), 'f')).toMatch(/group or by everyone/);
    expect(trustProblem(st({ mode: 0o646 }), 'f')).toMatch(/group or by everyone/);
    expect(trustProblem(st({ nlink: 2 }), 'f')).toMatch(/more than one link/);
  });
});

describe('a trusted file that does not parse', () => {
  it('SEALS rather than quietly dropping the policy', async () => {
    const { parsePolicy } = await import('./scope.js');
    // A trailing comma in a hand-edited policy is not consent to stop scoping.
    expect(parsePolicy('{"enforce":true,"allow":{"slack":["trayo"],}}')).toBeNull();
    expect(parsePolicy('{')).toBeNull();
    expect(parsePolicy('7')).toBeNull();
    expect(parsePolicy('[]')).toBeNull();
    expect(parsePolicy('null')).toBeNull();
    // …while a string from anywhere else stays lenient.
    expect(readPolicy('{')).toEqual(UNSCOPED);
  });

  it('seals when the trusted bytes do not parse — the branch, directly', async () => {
    // Reachable only through a root-owned file, so it is tested here instead:
    // the fail-open version of this survived every sabotage.
    const { trustedBytes } = await import('./scope.js');
    const bad = trustedBytes('{"enforce":true,', '/p.json');
    expect(bad.enforce).toBe(true);
    expect(bad.allow).toEqual({});
    expect(bad.problem).toMatch(/not valid JSON/);
    // …and passes a good one through untouched.
    const good = trustedBytes('{"enforce":true,"allow":{"slack":["trayo"]}}', '/p.json');
    expect(good.problem).toBeUndefined();
    expect(good.allow.slack).toEqual(['trayo']);
  });

  it('tolerates a BOM, which editors write and JSON.parse rejects', async () => {
    const { parsePolicy } = await import('./scope.js');
    const p = parsePolicy('﻿{"enforce":true,"allow":{"slack":["trayo"]}}');
    expect(p?.enforce).toBe(true);
    expect(p?.allow.slack).toEqual(['trayo']);
  });
});

describe('mayPaneUse — the function that resolves an origin', () => {
  const db = () => {
    const Database = require('better-sqlite3');
    const d = new Database(':memory:');
    d.exec('CREATE TABLE panes (id TEXT PRIMARY KEY, node_id TEXT)');
    d.prepare('INSERT INTO panes (id, node_id) VALUES (?, ?)').run('p-local', null);
    d.prepare('INSERT INTO panes (id, node_id) VALUES (?, ?)').run('p-vm', 'trayo');
    d.prepare('INSERT INTO panes (id, node_id) VALUES (?, ?)').run('p-empty', '');
    return d;
  };
  const policy = { enforce: true, allow: { slack: ['trayo'], msgvault: ['local'] } };

  it('resolves a pane with no node row as local', async () => {
    const { mayPaneUse } = await import('./scope.js');
    const d = mayPaneUse(db(), 'msgvault', 'p-local', policy);
    expect(d.origin).toBe('local');
    expect(d.ok).toBe(true);
  });

  it('resolves a remote pane to its machine, and refuses the wrong connector', async () => {
    const { mayPaneUse } = await import('./scope.js');
    expect(mayPaneUse(db(), 'slack', 'p-vm', policy).ok).toBe(true);
    const d = mayPaneUse(db(), 'msgvault', 'p-vm', policy);
    expect(d.ok).toBe(false);
    expect(d.origin).toBe('trayo');
  });

  it('REFUSES a pane that does not exist, rather than calling it local', async () => {
    // The bypass: any connector scoped to `local` was reachable by naming a
    // pane id that resolves to nothing.
    const { mayPaneUse } = await import('./scope.js');
    const d = mayPaneUse(db(), 'msgvault', 'invented', policy);
    expect(d.ok).toBe(false);
    expect(d.reason).toMatch(/no such chat/);
  });

  it('refuses a pane whose row was deleted with its machine', async () => {
    const { mayPaneUse } = await import('./scope.js');
    const d = db();
    d.prepare('DELETE FROM panes WHERE id = ?').run('p-vm');
    expect(mayPaneUse(d, 'msgvault', 'p-vm', policy).ok).toBe(false);
  });

  it('treats an EMPTY node id as local, which the panes route accepts', async () => {
    // It exists, so it is not the unknown-pane case; `''` is how a pane on this
    // machine can be recorded, and it must not become a hole either way.
    const { mayPaneUse } = await import('./scope.js');
    expect(mayPaneUse(db(), 'msgvault', 'p-empty', policy).origin).toBe('local');
    expect(mayPaneUse(db(), 'slack', 'p-empty', policy).ok).toBe(false);
  });

  it('carries a sealed policy’s problem into the refusal', async () => {
    const { mayPaneUse } = await import('./scope.js');
    const sealedPolicy = { enforce: true, allow: {}, problem: 'tampered' };
    expect(mayPaneUse(db(), 'slack', 'p-vm', sealedPolicy).reason).toBe('tampered');
  });
});
