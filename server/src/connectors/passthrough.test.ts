import { describe, expect, it } from 'vitest';
import { judgeArgv, passthroughCommands, verbForCommand } from './passthrough.js';
import { classify } from './registry.js';

describe('the pass-through forwards msgvault’s own CLI', () => {
  it('allows an ordinary read with unambiguous flags', () => {
    const v = judgeArgv(['search', 'from:alice newer_than:30d', '--json', '--limit=20']);
    expect(v.ok).toBe(true);
    expect(v.command).toBe('search');
  });

  it('allows a draft verb', () => {
    expect(judgeArgv(['draft-reply', 'abc123', '--text=ok']).ok).toBe(true);
  });

  it('refuses nothing to run', () => {
    expect(judgeArgv([]).ok).toBe(false);
    // A flag with no command is refused for the same reason as a flag before
    // one: the command has to lead.
    expect(judgeArgv(['--json']).reason).toMatch(/put the command first/);
  });
});

describe('flags that would re-point the tool', () => {
  it('refuses both spellings', () => {
    for (const argv of [
      ['search', 'x', '--home', '/elsewhere'],
      ['search', 'x', '--home=/elsewhere'],
      ['search', 'x', '--config', '/tmp/c.toml'],
      ['search', 'x', '--config=/tmp/c.toml'],
      ['search', 'x', '--agent-url', 'http://evil'],
      ['search', 'x', '--agent-token-file=/tmp/t'],
      ['search', 'x', '--agent-allow-insecure'],
      ['search', 'x', '--local'],
    ]) {
      const v = judgeArgv(argv);
      expect(v.ok, argv.join(' ')).toBe(false);
      expect(v.reason, argv.join(' ')).toMatch(/somewhere other than the approved daemon/);
    }
  });

  it('refuses a lone `--` outright', () => {
    // Conventionally it ends option parsing; msgvault's parser does not treat
    // it that way for global flags, and nothing legitimate here needs it.
    expect(judgeArgv(['search', 'x', '--', '--home', '/elsewhere']).ok).toBe(false);
    expect(judgeArgv(['search', 'x', '--']).reason).toMatch(/bare `--`/);
  });

  it('refuses ANY flag placed before the command', () => {
    // The command path must lead, so nothing can sit in front of it — and
    // msgvault rejects most leading flags itself (`--json stats` is "unknown
    // flag: --json", because --json belongs to the subcommands).
    for (const f of ['--home', '--json', '--log-level', '-v'])
      expect(judgeArgv([f, 'search', 'x']).ok, f).toBe(false);
    expect(judgeArgv(['--json', 'search', 'x']).reason).toMatch(/put the command first/);
  });

  it('refuses a bare flag whose value could be the next word', () => {
    // THE BYPASS: `--log-file` takes a value, so msgvault consumes `search` as
    // that value and runs `query` — while a filter counting bare tokens saw
    // `search` and asked for a timed search.read. Arbitrary SQL, approved as a
    // search.
    // It is refused twice over now: the flag cannot lead, AND a bare
    // value-taking flag is refused wherever it appears.
    const lead = judgeArgv(['--log-file', 'search', 'query', 'SELECT * FROM messages']);
    expect(lead.ok).toBe(false);
    expect(lead.reason).toMatch(/put the command first/);
    const after = judgeArgv(['search', 'x', '--log-file', 'query']);
    expect(after.ok).toBe(false);
    expect(after.reason).toMatch(/cannot tell whether a bare flag takes the next word/);
    for (const f of ['--log-level', '--log-sql-slow-ms', '-o'])
      expect(judgeArgv(['search', 'x', f, 'query']).ok, f).toBe(false);
  });

  it('allows the value-less flags it knows, bare', () => {
    for (const f of ['--json', '--verbose', '-v', '--no-log-file', '--log-sql'])
      expect(judgeArgv(['search', 'x', f]).ok, f).toBe(true);
  });

  it('allows any unknown flag in the = form', () => {
    // muxpad cannot enumerate another project's per-command flags, so the
    // unambiguous form is always acceptable.
    expect(judgeArgv(['search', 'x', '--limit=20', '--some-new-flag=1']).ok).toBe(true);
  });

  it('refuses an empty argument', () => {
    expect(judgeArgv(['search', '']).ok).toBe(false);
  });
});

describe('nested subcommands', () => {
  it('classifies the PAIR, not the parent', () => {
    // `calendar` as a parent said nothing: create, delete and move are writes
    // that can notify guests, and the parent mapped to a timed read.
    expect(judgeArgv(['calendar', 'freebusy', 'primary']).command).toBe('calendar freebusy');
    expect(verbForCommand('calendar freebusy')).toBe('msgvault.calendar.read');
  });

  it('refuses a calendar write, which has no mapping', () => {
    for (const sub of ['create', 'update', 'delete', 'move', 'respond'])
      expect(judgeArgv(['calendar', sub, '--send-updates=all']).ok, sub).toBe(false);
  });

  it('refuses a parent with no subcommand', () => {
    expect(judgeArgv(['calendar']).ok).toBe(false);
    expect(judgeArgv(['person']).reason).toMatch(/no approval mapping/);
  });

  it('refuses a flag BETWEEN a parent and its subcommand', () => {
    // There is no mapping for `calendar` alone, so this cannot resolve — which
    // is the fail-closed answer rather than a guess at what was meant.
    expect(judgeArgv(['calendar', '--json', 'freebusy']).ok).toBe(false);
  });

  it('handles a THREE-level path, which the pair rule could not', () => {
    // `person provider add` is real. "Parent plus one" classified `person
    // provider`, which says nothing about `add`.
    const v = judgeArgv(['person', 'provider', 'add', '--endpoint=https://x']);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/no approval mapping/);
  });

  it('resolves the LONGEST mapped prefix, so operands are not mistaken for it', () => {
    expect(judgeArgv(['search', 'from:x']).command).toBe('search');
    expect(judgeArgv(['calendar', 'freebusy', 'primary']).command).toBe('calendar freebusy');
  });
});

describe('subcommands that read more than an approval can describe', () => {
  it('refuses arbitrary SQL', () => {
    // `query` under a search.read grant would read the whole archive.
    const v = judgeArgv(['query', 'SELECT * FROM messages']);
    expect(v.ok).toBe(false);
    expect(v.command).toBe('query');
    expect(v.reason).toMatch(/more of the archive than an approval can describe/);
  });

  it('refuses the export family and the credential dump', () => {
    for (const c of [
      'export-messages',
      'export-eml',
      'export-attachments',
      'create-subset',
      'export-token',
      'credentials',
      'backup',
      'gc',
      'remove-account',
    ])
      expect(judgeArgv([c]).ok, c).toBe(false);
  });

  it('refuses the long-lived surfaces', () => {
    for (const c of ['tui', 'mcp', 'serve', 'daemon', 'setup', 'update'])
      expect(judgeArgv([c]).ok, c).toBe(false);
  });

  it('refuses it even with flags in front', () => {
    expect(judgeArgv(['--json', 'query', 'SELECT 1']).ok).toBe(false);
  });

  it('does not refuse an OPERAND that happens to name a banned command', () => {
    // "query" as a search term is not a subcommand; only the first bare token is.
    expect(judgeArgv(['search', 'query']).ok).toBe(true);
    expect(judgeArgv(['search', 'subject:backup']).ok).toBe(true);
  });
});

describe('the verb an approval is asked for', () => {
  it('maps a command onto msgvault’s own permission vocabulary', () => {
    expect(verbForCommand('search')).toBe('msgvault.search.read');
    expect(verbForCommand('draft-reply')).toBe('msgvault.draft.create');
  });

  it('returns null for anything unmapped — the fail-closed half', () => {
    // judgeArgv only knows what is BANNED. A command nobody classified must
    // not run just because it is not on the ban list.
    expect(verbForCommand('sync-full')).toBeNull();
    expect(verbForCommand('add-account')).toBeNull();
    expect(verbForCommand('constructor')).toBeNull();
  });

  it('asks for a verb the registry can classify, for every mapped command', () => {
    // Otherwise a command would be allowed here and refused at the broker.
    for (const c of passthroughCommands()) {
      const verb = verbForCommand(c);
      expect(verb, c).toBeTruthy();
      expect(classify(verb as string).ok, `${c} → ${verb}`).toBe(true);
    }
  });

  it('never maps a command onto a write that could ride a timed grant', () => {
    for (const c of passthroughCommands()) {
      const k = classify(verbForCommand(c) as string);
      if (k.kind === 'write') expect(k.timed, c).toBe(false);
    }
  });

  it('maps no command onto a send or a calendar invite', () => {
    const verbs = passthroughCommands().map((c) => verbForCommand(c));
    expect(verbs).not.toContain('msgvault.calendar.invite');
    expect(verbs.filter((v) => /send/.test(v ?? ''))).toEqual([]);
  });
});

describe('whether there is anything to mediate yet', () => {
  it('refuses while the archive is owned by the agents’ own account', async () => {
    // The live state today: ~/.msgvault/msgvault.db is 0644, owned by the
    // account every agent runs as. Filtering CLI arguments while that is true
    // tells the owner a boundary exists where none does.
    const { mediationReady } = await import('./passthrough.js');
    const r = mediationReady({ uid: 501, mode: 0o600 }, 501);
    expect(r.ready).toBe(false);
    expect(r.problem).toMatch(/owned by the account agents run as/);
  });

  it('refuses a group- or world-readable archive owned by someone else', async () => {
    const { mediationReady } = await import('./passthrough.js');
    expect(mediationReady({ uid: 0, mode: 0o644 }, 501).problem).toMatch(
      /group- or world-readable/,
    );
    expect(mediationReady({ uid: 0, mode: 0o640 }, 501).problem).toMatch(
      /group- or world-readable/,
    );
    expect(mediationReady({ uid: 0, mode: 0o604 }, 501).problem).toMatch(
      /group- or world-readable/,
    );
  });

  it('refuses when there is no archive at all', async () => {
    const { mediationReady } = await import('./passthrough.js');
    expect(mediationReady(null, 501).ready).toBe(false);
  });

  it('is ready only for an archive another account keeps to itself', async () => {
    const { mediationReady } = await import('./passthrough.js');
    expect(mediationReady({ uid: 0, mode: 0o600 }, 501)).toEqual({ ready: true });
    expect(mediationReady({ uid: 285, mode: 0o660 }, 501).ready).toBe(false);
  });
});

describe('the environment the child gets', () => {
  it('is an allowlist, so MSGVAULT_* cannot do what --home is refused for', async () => {
    // `--home` is blocked and `MSGVAULT_HOME` does the same job with no flag;
    // so do MSGVAULT_REMOTE_URL and friends. A filter that reads argv and
    // inherits the caller's environment has a second, unexamined input.
    const { spawnEnv } = await import('./passthrough.js');
    const env = spawnEnv(
      {
        PATH: '/usr/bin',
        TZ: 'UTC',
        MSGVAULT_HOME: '/tmp/evil',
        MSGVAULT_REMOTE_URL: 'http://evil',
        MSGVAULT_ENABLE_REMOTE_DELETE: '1',
        SOME_OTHER: 'x',
      },
      { MSGVAULT_HOME: '/opt/mediated' },
    );
    expect(env.PATH).toBe('/usr/bin');
    expect(env.TZ).toBe('UTC');
    expect(env.SOME_OTHER).toBeUndefined();
    expect(env.MSGVAULT_REMOTE_URL).toBeUndefined();
    expect(env.MSGVAULT_ENABLE_REMOTE_DELETE).toBeUndefined();
  });

  it('lets the injected values win over the caller’s', async () => {
    const { spawnEnv } = await import('./passthrough.js');
    const env = spawnEnv(
      { PATH: '/usr/bin', MSGVAULT_HOME: '/tmp/evil' },
      { MSGVAULT_HOME: '/opt/mediated' },
    );
    expect(env.MSGVAULT_HOME).toBe('/opt/mediated');
  });

  it('has no prototype, so a variable named __proto__ cannot reach Object', async () => {
    const { spawnEnv } = await import('./passthrough.js');
    const env = spawnEnv({ PATH: '/usr/bin' }, {});
    expect(Object.getPrototypeOf(env)).toBeNull();
  });
});

describe('resolving a command path', () => {
  it('takes the LONGEST mapped prefix, not the first one it finds', async () => {
    // Pinned with an injected map, because no real pair is mapped both ways —
    // so a fixture could not tell longest-first from shortest-first, and a
    // mutation of the direction survived the suite.
    const { resolveCommand } = await import('./passthrough.js');
    const map = { calendar: 'read', 'calendar freebusy': 'read', 'a b c': 'read' };
    expect(resolveCommand(['calendar', 'freebusy', 'primary'], map)).toBe('calendar freebusy');
    expect(resolveCommand(['calendar'], map)).toBe('calendar');
    expect(resolveCommand(['a', 'b', 'c'], map)).toBe('a b c');
  });

  it('stops at three tokens, and returns undefined for an unmapped path', async () => {
    const { resolveCommand } = await import('./passthrough.js');
    expect(resolveCommand(['a', 'b', 'c', 'd'], { 'a b c d': 'read' })).toBeUndefined();
    expect(resolveCommand(['nope'], { search: 'read' })).toBeUndefined();
    expect(resolveCommand([], { search: 'read' })).toBeUndefined();
  });

  it('cannot be fooled by a path named after an Object property', async () => {
    const { resolveCommand } = await import('./passthrough.js');
    expect(resolveCommand(['constructor'], { search: 'read' })).toBeUndefined();
    expect(resolveCommand(['toString'], { search: 'read' })).toBeUndefined();
  });
});
