import { describe, expect, it } from 'vitest';
import { judgeArgv, passthroughCommands, verbForCommand } from './passthrough.js';
import { classify } from './registry.js';

describe('the pass-through forwards msgvault’s own CLI', () => {
  it('allows an ordinary read, flags and all', () => {
    const v = judgeArgv(['search', 'from:alice newer_than:30d', '--json', '--limit', '20']);
    expect(v.ok).toBe(true);
    expect(v.command).toBe('search');
  });

  it('allows a draft verb', () => {
    expect(judgeArgv(['draft-reply', 'abc123', '--text', 'ok']).ok).toBe(true);
  });

  it('refuses nothing to run', () => {
    expect(judgeArgv([]).ok).toBe(false);
    expect(judgeArgv(['--json']).reason).toMatch(/no subcommand/);
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

  it('refuses one hidden behind a lone `--`', () => {
    // Conventionally `--` ends option parsing. msgvault's own parser does not
    // stop there for global flags, so trusting it would hand the flag over.
    expect(judgeArgv(['search', 'x', '--', '--home', '/elsewhere']).ok).toBe(false);
  });

  it('refuses one placed before the subcommand', () => {
    expect(judgeArgv(['--home', '/elsewhere', 'search', 'x']).ok).toBe(false);
  });

  it('does not refuse an operand that merely looks like a path', () => {
    expect(judgeArgv(['search', 'from:x', '-o', '/tmp/out.json']).ok).toBe(true);
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
