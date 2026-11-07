import { describe, expect, it } from 'vitest';
import { INTEGRATIONS, type PreflightEnv, nextStep, preflight, ready } from './preflight.js';

/**
 * These checks encode an hour of copy-paste-and-see. Each one failed for real
 * during the msgvault lockdown, so each one is pinned with the shape it failed
 * in — not with a tidy version of it.
 */
const AGENT_UID = 501;
const SERVICE_UID = 489;

const env = (
  over: Record<string, { uid: number; mode: number; isFile?: boolean } | null>,
): PreflightEnv => ({
  selfUid: AGENT_UID,
  stat: (p) => {
    const v = over[p];
    return v ? { uid: v.uid, mode: v.mode, isFile: v.isFile ?? true } : null;
  },
  daemonRunning: () => null,
});

/** Everything as it ended up after the install. */
const GOOD = {
  '/usr/local/var/msgvault': { uid: SERVICE_UID, mode: 0o700 },
  '/usr/local/libexec/msgvault/msgvault': { uid: 0, mode: 0o755 },
  '/usr/local/libexec/msgvault/libduckdb.dylib': { uid: 0, mode: 0o755 },
  '/var/log/msgvault.out.log': { uid: SERVICE_UID, mode: 0o640 },
  '/var/log/msgvault.err.log': { uid: SERVICE_UID, mode: 0o640 },
  '/Library/muxpad/connectors.json': { uid: 0, mode: 0o644 },
};
const by = (rs: ReturnType<typeof preflight>, id: string) => rs.find((r) => r.id === id);

describe('the archive', () => {
  it('blocks while it is owned by the account agents share — the live state before the move', () => {
    const r = by(
      preflight(
        'msgvault',
        env({ ...GOOD, '/usr/local/var/msgvault': { uid: AGENT_UID, mode: 0o700 } }),
      ),
      'archive-out-of-reach',
    );
    expect(r?.state).toBe('blocked');
    expect(r?.found).toMatch(/owned by the account agents run as/);
    expect(r?.remedy).toMatch(/theatre/);
  });

  it('blocks a group- or world-readable archive even under another account', () => {
    const r = by(
      preflight(
        'msgvault',
        env({ ...GOOD, '/usr/local/var/msgvault': { uid: SERVICE_UID, mode: 0o750 } }),
      ),
      'archive-out-of-reach',
    );
    expect(r?.state).toBe('blocked');
    expect(r?.remedy).toMatch(/chmod 700/);
  });

  it('passes when it is 700 under a service account', () => {
    expect(by(preflight('msgvault', env(GOOD)), 'archive-out-of-reach')?.state).toBe('ok');
  });
});

describe('the runtime', () => {
  it('blocks a binary the admin account can overwrite', () => {
    const r = by(
      preflight(
        'msgvault',
        env({ ...GOOD, '/usr/local/libexec/msgvault/msgvault': { uid: AGENT_UID, mode: 0o755 } }),
      ),
      'binary-root-owned',
    );
    expect(r?.state).toBe('blocked');
  });

  it('names the re-sign in the dylib remedy, because skipping it is silent', () => {
    // install_name_tool invalidates the signature and the binary then does not
    // launch at all on Apple Silicon — with no error that says so.
    const r = by(
      preflight('msgvault', env({ ...GOOD, '/usr/local/libexec/msgvault/libduckdb.dylib': null })),
      'dylib-root-owned',
    );
    expect(r?.state).toBe('blocked');
    expect(r?.remedy).toMatch(/codesign --force --sign -/);
    expect(r?.remedy).toMatch(/NOT optional/);
  });
});

describe('the daemon’s log files', () => {
  it('blocks when they do not exist, and says why that is fatal', () => {
    // The least obvious failure in the install: launchd cannot open the file,
    // exits 78 before the program runs, and writes no log saying so — because
    // the log is the thing it could not open.
    const r = by(
      preflight('msgvault', env({ ...GOOD, '/var/log/msgvault.out.log': null })),
      'daemon-logs-writable',
    );
    expect(r?.state).toBe('blocked');
    expect(r?.remedy).toMatch(/touch \/var\/log\/msgvault\.out\.log/);
  });

  it('blocks a root-owned log file, because the daemon is not root', () => {
    const r = by(
      preflight('msgvault', env({ ...GOOD, '/var/log/msgvault.err.log': { uid: 0, mode: 0o640 } })),
      'daemon-logs-writable',
    );
    expect(r?.state).toBe('blocked');
    expect(r?.remedy).toMatch(/chown _msgvault/);
  });
});

describe('what muxpad cannot see', () => {
  it('reports the daemon as UNKNOWN rather than guessing', () => {
    const r = by(preflight('msgvault', env(GOOD)), 'daemon-running');
    expect(r?.state).toBe('unknown');
    // …and hands over the command that answers it, including the trap.
    expect(r?.remedy).toMatch(/crash loop that KeepAlive is hiding/);
  });

  it('does NOT count unknown as ready', () => {
    // A check muxpad could not run is a check nobody ran. "Probably fine" is
    // not a thing to say about the barrier between an agent and the mail.
    const rs = preflight('msgvault', env(GOOD));
    expect(rs.every((r) => r.state !== 'blocked')).toBe(true);
    expect(ready(rs)).toBe(false);
  });

  it('is not ready when there is nothing to check either', () => {
    expect(ready([])).toBe(false);
    expect(preflight('nope', env(GOOD))).toEqual([]);
  });
});

describe('what to do next', () => {
  it('is the first thing that is not ok, in declared order', () => {
    const rs = preflight(
      'msgvault',
      env({
        ...GOOD,
        '/usr/local/var/msgvault': { uid: AGENT_UID, mode: 0o700 },
        '/var/log/msgvault.out.log': null,
      }),
    );
    expect(nextStep(rs)?.id).toBe('archive-out-of-reach');
  });

  it('is null when every check passed', () => {
    expect(nextStep([{ id: 'a', question: 'q', state: 'ok' }])).toBeNull();
  });
});

describe('Slack’s policy check', () => {
  it('calls an absent policy UNKNOWN, and says what its absence means', () => {
    const r = by(
      preflight('slack', env({ ...GOOD, '/Library/muxpad/connectors.json': null })),
      'policy-root-owned',
    );
    expect(r?.state).toBe('unknown');
    expect(r?.remedy).toMatch(/every chat on every machine may use every connector/);
  });

  it('blocks a policy the agents it binds could edit', () => {
    const r = by(
      preflight(
        'slack',
        env({ ...GOOD, '/Library/muxpad/connectors.json': { uid: AGENT_UID, mode: 0o644 } }),
      ),
      'policy-root-owned',
    );
    expect(r?.state).toBe('blocked');
  });
});

describe('every check is answerable', () => {
  it('asks a question and offers a remedy whenever it is not ok', () => {
    for (const i of INTEGRATIONS) {
      for (const r of preflight(i.id, env({}))) {
        expect(r.question, `${i.id}/${r.id}`).toMatch(/\?$/);
        if (r.state !== 'ok') {
          expect(r.found, `${i.id}/${r.id} found`).toBeTruthy();
          expect(r.remedy, `${i.id}/${r.id} remedy`).toBeTruthy();
        }
      }
    }
  });

  it('says what each integration grants, in one line', () => {
    for (const i of INTEGRATIONS) expect(i.grants.length, i.id).toBeGreaterThan(20);
    // The one promise that must survive every future edit.
    expect(INTEGRATIONS.find((i) => i.id === 'msgvault')?.grants).toMatch(/never send/);
  });
});

describe('a binary is not a secret', () => {
  it('accepts 0755 on the runtime — executables are meant to be readable', () => {
    // The first version of this check used the data mask on the binary and
    // called a correct install broken. A check that cries wolf is how people
    // learn to ignore checks.
    const rs = preflight('msgvault', env(GOOD));
    expect(by(rs, 'binary-root-owned')?.state).toBe('ok');
    expect(by(rs, 'dylib-root-owned')?.state).toBe('ok');
  });

  it('still blocks a runtime anyone can WRITE', () => {
    const r = by(
      preflight(
        'msgvault',
        env({ ...GOOD, '/usr/local/libexec/msgvault/msgvault': { uid: 0, mode: 0o777 } }),
      ),
      'binary-root-owned',
    );
    expect(r?.state).toBe('blocked');
    expect(r?.found).toMatch(/writable by group\/other/);
  });

  it('still requires the archive to be unreadable, not merely unwritable', () => {
    const r = by(
      preflight('msgvault', env({ ...GOOD, '/usr/local/var/msgvault': { uid: 489, mode: 0o755 } })),
      'archive-out-of-reach',
    );
    expect(r?.state).toBe('blocked');
  });
});
