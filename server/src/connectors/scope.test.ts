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

  it('SEALS when absent — a missing policy is a broken install, not consent', async () => {
    // Absent used to be UNSCOPED, which was right while scoping was being
    // rolled out: an install with no policy had to keep working. It is wrong
    // now that scoping is the live arrangement, because it means DELETING A
    // FILE switches every restraint off, silently.
    const { loadPolicy } = await import('./scope.js');
    const p = loadPolicy('/nonexistent/connectors.json');
    expect(p.enforce).toBe(true);
    expect(p.problem).toMatch(/missing/);
    expect(p.allow).toEqual({});
  });

  it('SEALS an `enforce` that is not a boolean — "true" is not true', async () => {
    // The most likely way to mistype this file. It read as FALSE and allowed
    // everything: a policy whose central switch cannot be read is a policy
    // that cannot be obeyed.
    // Asserted through `trustedBytes` — the path a real installed file takes.
    // `readPolicy` is the lenient variant for values from anywhere else.
    const { trustedBytes } = await import('./scope.js');
    const at = '/Library/muxpad/connectors.json';
    for (const bad of ['"true"', '1', '0', 'null', '"yes"']) {
      const p = trustedBytes(`{"enforce": ${bad}, "allow": {"slack": ["trayo"]}}`, at);
      expect(p.enforce, bad).toBe(true);
      expect(p.problem, bad).toBeTruthy();
      expect(p.allow, bad).toEqual({});
    }
    // …and a missing key is just as ambiguous.
    expect(trustedBytes('{"allow": {"slack": ["trayo"]}}', at).problem).toBeTruthy();
    // A real boolean still works, both ways.
    expect(trustedBytes('{"enforce": false, "allow": {}}', at).enforce).toBe(false);
    expect(trustedBytes('{"enforce": true, "allow": {"slack": ["trayo"]}}', at).enforce).toBe(true);
    expect(
      trustedBytes('{"enforce": true, "allow": {"slack": ["trayo"]}}', at).problem,
    ).toBeUndefined();
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
    const { trustProblem } = await import('./trusted-file.js');
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
    d.exec(
      'CREATE TABLE nodes (id TEXT PRIMARY KEY, name TEXT, endpoint TEXT, status TEXT, last_seen INTEGER, capabilities TEXT, created_at INTEGER)',
    );
    d.prepare('INSERT INTO nodes (id, name, endpoint) VALUES (?, ?, ?)').run(
      'trayo',
      'Trayo VM',
      'ws://x:1',
    );
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

  it('REFUSES an empty node id rather than reading it as local', async () => {
    // `POST /api/panes` accepts `node_id: ""`, which was a second spelling of
    // "local" that no policy names — so it inherited the machine with the most
    // access. An origin that is not a machine is refused.
    const { mayPaneUse } = await import('./scope.js');
    const d = mayPaneUse(db(), 'msgvault', 'p-empty', policy);
    expect(d.ok).toBe(false);
    expect(d.reason).toMatch(/not one muxpad knows \(blank\)/);
    expect(mayPaneUse(db(), 'slack', 'p-empty', policy).ok).toBe(false);
  });

  it('refuses a pane whose machine was removed from the table', async () => {
    const { mayPaneUse } = await import('./scope.js');
    const d = db();
    d.prepare('DELETE FROM nodes WHERE id = ?').run('trayo');
    const r = mayPaneUse(d, 'slack', 'p-vm', policy);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not one muxpad knows \(trayo\)/);
  });

  it('carries a sealed policy’s problem into the refusal', async () => {
    const { mayPaneUse } = await import('./scope.js');
    const sealedPolicy = { enforce: true, allow: {}, problem: 'tampered' };
    expect(mayPaneUse(db(), 'slack', 'p-vm', sealedPolicy).reason).toBe('tampered');
  });
});

describe('the policy file, every branch', () => {
  // The real checks need a uid-0 file inside uid-0 directories, which a test
  // cannot create — so the filesystem is injected. Twelve sabotages of this
  // logic used to pass the suite, including deleting the ancestor walk.
  const S = (
    o: Partial<{
      file: boolean;
      dir: boolean;
      link: boolean;
      uid: number;
      mode: number;
      nlink: number;
    }>,
  ) =>
    ({
      isFile: () => o.file === true,
      isDirectory: () => o.dir === true,
      isSymbolicLink: () => o.link === true,
      uid: o.uid ?? 0,
      mode: o.mode ?? 0o644,
      nlink: o.nlink ?? 1,
    }) as unknown as import('node:fs').Stats;

  const FILE = S({ file: true });
  const DIR = S({ dir: true, mode: 0o755 });

  /** A filesystem where the policy is good and every ancestor is root's. */
  const okIO = (
    over: Partial<Record<string, import('node:fs').Stats>> = {},
    body = '{"enforce":true,"allow":{"slack":["trayo"]}}',
  ) => {
    const dirs: Record<string, import('node:fs').Stats> = {
      '/Library/muxpad': DIR,
      '/Library': DIR,
      '/': DIR,
      ...over,
    };
    return {
      opened: [] as string[],
      readFrom: [] as number[],
      closed: 0,
      open(path: string) {
        this.opened.push(path);
        return 7;
      },
      fstat: () => over.__file__ ?? FILE,
      read(fd: number) {
        this.readFrom.push(fd);
        return body;
      },
      close() {
        this.closed++;
      },
      lstat: (p: string) => {
        const st = dirs[p];
        if (!st) throw Object.assign(new Error('nope'), { code: 'ENOENT' });
        return st;
      },
    };
  };

  it('loads a good file, reading from the FD rather than the path', async () => {
    const { loadPolicy } = await import('./scope.js');
    const io = okIO();
    const p = loadPolicy('/Library/muxpad/connectors.json', io);
    expect(p.enforce).toBe(true);
    expect(p.allow.slack).toEqual(['trayo']);
    expect(io.readFrom).toEqual([7]); // the fd, not a second open of the path
    expect(io.closed).toBe(1);
  });

  it('seals on each ancestor fault, naming the directory', async () => {
    const { loadPolicy } = await import('./scope.js');
    const path = '/Library/muxpad/connectors.json';
    const cases: Array<[string, import('node:fs').Stats, RegExp]> = [
      [
        'not root-owned',
        S({ dir: true, uid: 501, mode: 0o755 }),
        /\/Library\/muxpad is not root-owned/,
      ],
      ['group-writable', S({ dir: true, mode: 0o775 }), /writable by its group/],
      ['world-writable', S({ dir: true, mode: 0o757 }), /writable by its group or by everyone/],
      ['a symlink', S({ dir: true, link: true, mode: 0o755 }), /is a symlink/],
      ['not a directory', S({ file: true }), /is not a directory/],
    ];
    for (const [label, st, re] of cases) {
      const p = loadPolicy(path, okIO({ '/Library/muxpad': st }));
      expect(p.enforce, label).toBe(true);
      expect(p.allow, label).toEqual({});
      expect(p.problem, label).toMatch(re);
    }
  });

  it('walks ALL the way up, not just the parent', async () => {
    const { loadPolicy } = await import('./scope.js');
    // The parent is fine and the grandparent is not: a walk that stopped early
    // would load this, and one that started too high would miss the parent.
    const p = loadPolicy(
      '/Library/muxpad/connectors.json',
      okIO({ '/Library': S({ dir: true, uid: 501, mode: 0o755 }) }),
    );
    expect(p.problem).toMatch(/\/Library is not root-owned/);
  });

  it('checks the ROOT too, so a walk that stops short is caught', async () => {
    // With every intermediate directory fine, only a bad `/` distinguishes a
    // complete walk from one that gave up early — and giving up early survived
    // the suite until this case existed.
    const { loadPolicy } = await import('./scope.js');
    const p = loadPolicy(
      '/Library/muxpad/connectors.json',
      okIO({ '/': S({ dir: true, mode: 0o777 }) }),
    );
    expect(p.enforce).toBe(true);
    expect(p.problem).toMatch(/^\/ is writable/);
  });

  it('terminates at the root', async () => {
    const { ancestorProblem } = await import('./trusted-file.js');
    const io = okIO();
    expect(ancestorProblem('/Library/muxpad/connectors.json', io)).toBeNull();
  });

  it('seals when an ancestor cannot be inspected at all', async () => {
    const { loadPolicy } = await import('./scope.js');
    const io = okIO();
    io.lstat = () => {
      throw new Error('EACCES');
    };
    expect(loadPolicy('/Library/muxpad/connectors.json', io).problem).toMatch(
      /could not be inspected/,
    );
  });

  it('seals on EVERY open failure, ENOENT included', async () => {
    const { loadPolicy } = await import('./scope.js');
    const io = okIO();
    for (const [code, expectSealed] of [
      ['ENOENT', true],
      ['EACCES', true],
      ['ELOOP', true],
      ['ENOTDIR', true],
      [undefined, true],
    ] as Array<[string | undefined, boolean]>) {
      io.open = () => {
        throw Object.assign(new Error(String(code)), code ? { code } : {});
      };
      const p = loadPolicy('/Library/muxpad/connectors.json', io);
      expect(expectSealed, 'every open failure seals now').toBe(true);
      expect(p.enforce, String(code)).toBe(true);
      expect(p.problem, String(code)).toMatch(
        code === 'ENOENT' ? /missing/ : /could not be opened/,
      );
    }
  });

  it('seals an EMPTY trusted file — truncating it was a way to switch scoping off', async () => {
    const { loadPolicy } = await import('./scope.js');
    for (const body of ['', '   \n']) {
      const p = loadPolicy('/Library/muxpad/connectors.json', okIO({}, body));
      expect(p.enforce).toBe(true);
      expect(p.problem).toMatch(/is empty/);
    }
  });

  it('seals when the file metadata is wrong, before reading a byte', async () => {
    const { loadPolicy } = await import('./scope.js');
    for (const [st, re] of [
      [S({ file: true, uid: 501 }), /not root-owned/],
      [S({ file: true, mode: 0o666 }), /writable by its group/],
      [S({ file: true, nlink: 3 }), /more than one link/],
      [S({ dir: true }), /not a regular file/],
    ] as Array<[import('node:fs').Stats, RegExp]>) {
      const io = okIO({ __file__: st });
      const p = loadPolicy('/Library/muxpad/connectors.json', io);
      expect(p.problem).toMatch(re);
      expect(io.readFrom, 'must not read a file it refused').toEqual([]);
    }
  });

  it('closes the fd even when the decision is a refusal', async () => {
    const { loadPolicy } = await import('./scope.js');
    const io = okIO({ __file__: S({ file: true, uid: 501 }) });
    loadPolicy('/Library/muxpad/connectors.json', io);
    expect(io.closed).toBe(1);
  });

  it('survives a close that throws', async () => {
    const { loadPolicy } = await import('./scope.js');
    const io = okIO();
    io.close = () => {
      throw new Error('EBADF');
    };
    expect(loadPolicy('/Library/muxpad/connectors.json', io).enforce).toBe(true);
  });
});

describe('being told to do it by another machine', () => {
  const mk = () => {
    const Database = require('better-sqlite3');
    const d = new Database(':memory:');
    d.exec(`CREATE TABLE panes (id TEXT PRIMARY KEY, tab_id TEXT, node_id TEXT, created_at INTEGER);
            CREATE TABLE nodes (id TEXT PRIMARY KEY, name TEXT, endpoint TEXT);
            CREATE TABLE inbound_messages (id TEXT PRIMARY KEY, tab_id TEXT, at INTEGER, text_key TEXT, from_tab_id TEXT)`);
    d.prepare('INSERT INTO nodes (id, name, endpoint) VALUES (?,?,?)').run('trayo', 'VM', 'ws://x');
    d.prepare('INSERT INTO panes VALUES (?,?,?,?)').run('p-vm', 't-vm', 'trayo', 1);
    d.prepare('INSERT INTO panes VALUES (?,?,?,?)').run('p-local', 't-local', null, 1);
    return d;
  };
  const policy = { enforce: true, allow: { slack: ['trayo'], msgvault: ['local'] } };
  const direct = (d: ReturnType<typeof mk>, into: string, from: string, at: number) =>
    d.prepare('INSERT INTO inbound_messages VALUES (?,?,?,?,?)').run(`i${at}`, into, at, 'k', from);

  it('refuses a work-chat post that a personal chat asked for', async () => {
    // The hole scoping alone leaves: the instruction crosses the boundary even
    // though the request does not.
    const { mayPaneUse, directingOrigin } = await import('./scope.js');
    const d = mk();
    direct(d, 't-vm', 't-local', 1000);
    expect(directingOrigin(d, 'p-vm', 1000)).toBe('local');
    const r = mayPaneUse(d, 'slack', 'p-vm', policy, directingOrigin(d, 'p-vm', 1000));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/directed to by a chat on local/);
  });

  it('refuses the mirror image — a work chat driving a personal chat into the mail', async () => {
    const { mayPaneUse, directingOrigin } = await import('./scope.js');
    const d = mk();
    direct(d, 't-local', 't-vm', 1000);
    const r = mayPaneUse(d, 'msgvault', 'p-local', policy, directingOrigin(d, 'p-local', 1000));
    expect(r.ok).toBe(false);
  });

  it('allows a chat directed by one on the SAME machine', async () => {
    const { mayPaneUse, directingOrigin } = await import('./scope.js');
    const d = mk();
    d.prepare('INSERT INTO panes VALUES (?,?,?,?)').run('p-vm2', 't-vm2', 'trayo', 1);
    direct(d, 't-vm', 't-vm2', 1000);
    expect(mayPaneUse(d, 'slack', 'p-vm', policy, directingOrigin(d, 'p-vm', 1000)).ok).toBe(true);
  });

  it('forgets an instruction older than the window', async () => {
    const { mayPaneUse, directingOrigin, DIRECTED_WINDOW_MS } = await import('./scope.js');
    const d = mk();
    direct(d, 't-vm', 't-local', 1000);
    const later = 1000 + DIRECTED_WINDOW_MS + 1;
    expect(directingOrigin(d, 'p-vm', later)).toBeNull();
    expect(mayPaneUse(d, 'slack', 'p-vm', policy, directingOrigin(d, 'p-vm', later)).ok).toBe(true);
  });

  it('takes the MOST RECENT instruction, not the first', async () => {
    const { directingOrigin } = await import('./scope.js');
    const d = mk();
    d.prepare('INSERT INTO panes VALUES (?,?,?,?)').run('p-vm2', 't-vm2', 'trayo', 1);
    direct(d, 't-vm', 't-local', 1000);
    direct(d, 't-vm', 't-vm2', 2000);
    expect(directingOrigin(d, 'p-vm', 2000)).toBe('trayo');
  });

  it('ignores a human message, which has no sending tab', async () => {
    const { directingOrigin } = await import('./scope.js');
    const d = mk();
    d.prepare('INSERT INTO inbound_messages VALUES (?,?,?,?,?)').run('h', 't-vm', 1000, 'k', null);
    expect(directingOrigin(d, 'p-vm', 1000)).toBeNull();
  });

  it('is not WASHED by a later human message', async () => {
    // The dangerous shape: a personal chat directs the work chat, then anything
    // without a sending tab lands after it. A query that took the most recent
    // row REGARDLESS of provenance would read that as "nobody directed this"
    // and allow the post — laundering with one extra step.
    const { directingOrigin, mayPaneUse } = await import('./scope.js');
    const d = mk();
    direct(d, 't-vm', 't-local', 1000);
    d.prepare('INSERT INTO inbound_messages VALUES (?,?,?,?,?)').run('h', 't-vm', 1500, 'k', null);
    expect(directingOrigin(d, 'p-vm', 1500)).toBe('local');
    expect(mayPaneUse(d, 'slack', 'p-vm', policy, directingOrigin(d, 'p-vm', 1500)).ok).toBe(false);
  });

  it('is a no-op while enforcement is off', async () => {
    const { mayPaneUse, directingOrigin } = await import('./scope.js');
    const d = mk();
    direct(d, 't-vm', 't-local', 1000);
    expect(mayPaneUse(d, 'slack', 'p-vm', UNSCOPED, directingOrigin(d, 'p-vm', 1000)).ok).toBe(
      true,
    );
  });
});

describe('directingOrigin cannot throw, and breaks ties deterministically', () => {
  const mk = () => {
    const Database = require('better-sqlite3');
    const d = new Database(':memory:');
    d.exec(`CREATE TABLE panes (id TEXT PRIMARY KEY, tab_id TEXT, node_id TEXT, created_at INTEGER);
            CREATE TABLE nodes (id TEXT PRIMARY KEY, name TEXT, endpoint TEXT);
            CREATE TABLE inbound_messages (id TEXT PRIMARY KEY, tab_id TEXT, at INTEGER, text_key TEXT, from_tab_id TEXT)`);
    d.prepare('INSERT INTO nodes (id, name, endpoint) VALUES (?,?,?)').run('trayo', 'VM', 'ws://x');
    d.prepare('INSERT INTO panes VALUES (?,?,?,?)').run('p-vm', 't-vm', 'trayo', 1);
    d.prepare('INSERT INTO panes VALUES (?,?,?,?)').run('p-local', 't-local', null, 1);
    return d;
  };

  it('answers null for a sending tab that has no panes left', async () => {
    // A tab can be deleted while its message survives. Reading `.n` off the
    // missing row threw, and a security check that throws becomes a 500
    // instead of a refusal — a mutation run found the guard untested.
    const { directingOrigin } = await import('./scope.js');
    const d = mk();
    d.prepare('INSERT INTO inbound_messages VALUES (?,?,?,?,?)').run(
      'i',
      't-vm',
      100,
      'k',
      't-gone',
    );
    expect(() => directingOrigin(d, 'p-vm', 100)).not.toThrow();
    expect(directingOrigin(d, 'p-vm', 100)).toBeNull();
  });

  it('answers null for a pane that does not exist', async () => {
    const { directingOrigin } = await import('./scope.js');
    expect(directingOrigin(mk(), 'nobody', 100)).toBeNull();
  });

  it('breaks a same-millisecond tie by insertion order, not arbitrarily', async () => {
    // Two directions in the same millisecond ordered arbitrarily, so a test
    // would have pinned whichever the engine happened to return. `rowid DESC`
    // makes the later-recorded one win, which is the one that actually arrived
    // last.
    const { directingOrigin } = await import('./scope.js');
    const d = mk();
    d.prepare('INSERT INTO panes VALUES (?,?,?,?)').run('p-vm2', 't-vm2', 'trayo', 1);
    d.prepare('INSERT INTO inbound_messages VALUES (?,?,?,?,?)').run(
      'a',
      't-vm',
      500,
      'k',
      't-local',
    );
    d.prepare('INSERT INTO inbound_messages VALUES (?,?,?,?,?)').run(
      'b',
      't-vm',
      500,
      'k',
      't-vm2',
    );
    expect(directingOrigin(d, 'p-vm', 500)).toBe('trayo');
    // …and the other way round, to prove it is insertion order and not luck.
    const e = mk();
    e.prepare('INSERT INTO panes VALUES (?,?,?,?)').run('p-vm2', 't-vm2', 'trayo', 1);
    e.prepare('INSERT INTO inbound_messages VALUES (?,?,?,?,?)').run(
      'a',
      't-vm',
      500,
      'k',
      't-vm2',
    );
    e.prepare('INSERT INTO inbound_messages VALUES (?,?,?,?,?)').run(
      'b',
      't-vm',
      500,
      'k',
      't-local',
    );
    expect(directingOrigin(e, 'p-vm', 500)).toBe('local');
  });
});
