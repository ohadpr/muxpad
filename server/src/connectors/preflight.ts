import { statSync } from 'node:fs';

/**
 * WHAT AN INTEGRATION NEEDS, CHECKED — not described in a wiki.
 *
 * ── WHERE THIS CAME FROM ─────────────────────────────────────────────────
 * Locking msgvault away from the agent account took an hour of
 * copy-paste-and-see, and every minute of it was a check that a machine could
 * have run: is the archive still readable by the account agents share, is the
 * binary one they can overwrite, did the signature survive `install_name_tool`,
 * can the daemon's user actually create its log file. Two of those failed
 * silently in ways the error message did not name — launchd exits 78 before
 * the program starts, and an unsigned binary on Apple Silicon simply does not
 * launch.
 *
 * "An integrations section with clear instructions, checks, etc. Activating an
 * integration tells u what to do and checks." So the knowledge lives here, as
 * CHECKS THAT RUN, and the instructions are attached to the check that failed
 * rather than to a page you read in order.
 *
 * ── THE SHAPE, AND WHY IT IS NOT A SCRIPT ────────────────────────────────
 * Every check is a question with a remedy, and muxpad runs them; it does not
 * perform them. Installing an integration means creating service accounts,
 * moving data and loading daemons — root work, from the owner's own terminal,
 * on a machine where the thing being restrained is the agent that would
 * otherwise be running the script. An agent that could fix these checks could
 * also fix them the wrong way round.
 *
 * So muxpad's half is: say precisely what is wrong, give the command that
 * fixes it, and re-check. That is the whole contract, and it is the part that
 * was missing.
 */

export type CheckState =
  /** Verified good. */
  | 'ok'
  /** Verified bad, and we know what to do about it. */
  | 'blocked'
  /** Not checkable from here — needs the owner's eyes or another machine. */
  | 'unknown';

export interface CheckResult {
  id: string;
  /** What is being asked, in the owner's terms. */
  question: string;
  state: CheckState;
  /** What was found. Present whenever the state is not `ok`. */
  found?: string;
  /** The command or action that fixes it. Copy-pasteable, never run by us. */
  remedy?: string;
}

export interface Integration {
  id: string;
  label: string;
  /** One line: what turning this on actually gives the agents. */
  grants: string;
  checks: Check[];
}

export interface Check {
  id: string;
  question: string;
  run(env: PreflightEnv): Omit<CheckResult, 'id' | 'question'>;
}

/** Everything the checks are allowed to look at. Injected, so each one is
 *  testable without a service account and a daemon. */
export interface PreflightEnv {
  /** The uid muxpad — and therefore every agent — runs as. */
  selfUid: number;
  /** `statSync`, or a stand-in. Returning null means "not there". */
  stat(path: string): { uid: number; mode: number; isFile: boolean } | null;
  /** Is a process listening for this integration's daemon? */
  daemonRunning(id: string): boolean | null;
}

export const realEnv: PreflightEnv = {
  selfUid: process.getuid?.() ?? -1,
  stat(path) {
    try {
      const st = statSync(path);
      return { uid: st.uid, mode: st.mode, isFile: st.isFile() };
    } catch {
      return null;
    }
  },
  // Deliberately unknown here: muxpad cannot see another account's processes
  // without asking the OS questions it should not be asking, and a wrong YES
  // is worse than an honest "look for yourself".
  daemonRunning: () => null,
};

/**
 * Is this path out of the agent account's reach?
 *
 * TWO DIFFERENT QUESTIONS, and the first version of this asked the wrong one
 * of a binary. For DATA the rule is "nobody else may read it" — a mail archive
 * at 0750 leaks to the group. For a RUNTIME the rule is "nobody else may WRITE
 * it": `/usr/local/libexec/msgvault/msgvault` is 0755 and must be, because
 * anyone may execute it; what matters is that an agent cannot replace it. One
 * mask for both flagged a correct install as broken, which is the failure mode
 * that teaches people to ignore checks.
 */
type Reach = 'secret' | 'runtime';

function ownedAwayFromAgents(
  env: PreflightEnv,
  path: string,
  what: string,
  fix: string,
  kind: Reach = 'secret',
): Omit<CheckResult, 'id' | 'question'> {
  const st = env.stat(path);
  if (!st) return { state: 'blocked', found: `${path} is not there`, remedy: fix };
  if (st.uid === env.selfUid)
    return {
      state: 'blocked',
      found: `${what} is owned by the account agents run as`,
      remedy: fix,
    };
  const forbidden = kind === 'secret' ? 0o066 : 0o022;
  if (st.mode & forbidden)
    return {
      state: 'blocked',
      found:
        kind === 'secret'
          ? `${what} is readable or writable by group/other (mode ${(st.mode & 0o777).toString(8)})`
          : `${what} is writable by group/other (mode ${(st.mode & 0o777).toString(8)})`,
      remedy: kind === 'secret' ? `sudo chmod 700 ${path}` : `sudo chmod 755 ${path}`,
    };
  return { state: 'ok' };
}

export const INTEGRATIONS: Integration[] = [
  {
    id: 'msgvault',
    label: 'msgvault — mail, calendar, contacts',
    grants: 'search and read your archive, and create drafts. It can never send.',
    checks: [
      {
        id: 'archive-out-of-reach',
        question: 'Is the mail archive out of the agent account’s reach?',
        run: (env) =>
          ownedAwayFromAgents(
            env,
            '/usr/local/var/msgvault',
            'the archive',
            'Move it to a service account: see the integration’s setup steps. While it is readable, mediating the CLI is theatre — an agent can read the database directly.',
          ),
      },
      {
        id: 'binary-root-owned',
        question: 'Is the binary one an agent cannot replace?',
        run: (env) => {
          const r = ownedAwayFromAgents(
            env,
            '/usr/local/libexec/msgvault/msgvault',
            'the binary',
            'sudo cp "$(brew --prefix)/bin/msgvault" /usr/local/libexec/msgvault/ && sudo chown root:wheel /usr/local/libexec/msgvault/msgvault',
            'runtime',
          );
          if (r.state !== 'ok') return r;
          // Homebrew's own copy stays where it is and is writable by an admin
          // account; what matters is that the DAEMON runs this one.
          return { state: 'ok' };
        },
      },
      {
        id: 'dylib-root-owned',
        question: 'Are its libraries ones an agent cannot replace?',
        run: (env) =>
          ownedAwayFromAgents(
            env,
            '/usr/local/libexec/msgvault/libduckdb.dylib',
            'libduckdb',
            'Copy it beside the binary and repoint it:\n  sudo cp "$(brew --prefix duckdb)/lib/libduckdb.dylib" /usr/local/libexec/msgvault/\n  sudo install_name_tool -change "$(brew --prefix duckdb)/lib/libduckdb.dylib" /usr/local/libexec/msgvault/libduckdb.dylib /usr/local/libexec/msgvault/msgvault\n  sudo codesign --force --sign - /usr/local/libexec/msgvault/msgvault\nThe re-sign is NOT optional: install_name_tool invalidates the signature and an unsigned binary will not launch on Apple Silicon.',
            'runtime',
          ),
      },
      {
        id: 'daemon-logs-writable',
        question: 'Can the daemon’s account create its log files?',
        run: (env) => {
          for (const p of ['/var/log/msgvault.out.log', '/var/log/msgvault.err.log']) {
            const st = env.stat(p);
            if (!st)
              return {
                state: 'blocked',
                found: `${p} does not exist`,
                // The failure this prevents is the least obvious one in the
                // whole install: launchd cannot open the file, so it exits 78
                // (EX_CONFIG) BEFORE the program runs — and writes no log
                // saying so, because the log is what it could not open.
                remedy: `sudo touch ${p} && sudo chown _msgvault:wheel ${p} && sudo chmod 640 ${p}`,
              };
            if (st.uid === 0)
              return {
                state: 'blocked',
                found: `${p} is root-owned, and the daemon does not run as root`,
                remedy: `sudo chown _msgvault:wheel ${p}`,
              };
          }
          return { state: 'ok' };
        },
      },
      {
        id: 'daemon-running',
        question: 'Is the daemon up, under its own account?',
        run: (env) => {
          const up = env.daemonRunning('msgvault');
          if (up === null)
            return {
              state: 'unknown',
              found: 'muxpad cannot see another account’s processes',
              remedy:
                "sudo launchctl print system/org.muxpad.msgvault | grep -E 'runs|last exit'\nWant runs = 1 and no exit code. A climbing `runs` is a crash loop that KeepAlive is hiding.",
            };
          return up
            ? { state: 'ok' }
            : {
                state: 'blocked',
                found: 'nothing is listening',
                remedy: 'sudo launchctl kickstart -k system/org.muxpad.msgvault',
              };
        },
      },
    ],
  },
  {
    id: 'slack',
    label: 'Slack',
    grants: 'read channels, and post as you — every send needs your approval.',
    checks: [
      {
        id: 'policy-root-owned',
        question: 'Is the connector policy out of the agent account’s reach?',
        run: (env) => {
          const st = env.stat('/Library/muxpad/connectors.json');
          if (!st)
            return {
              state: 'unknown',
              found: 'no policy file — nothing is scoped to a machine yet',
              remedy:
                'Write /Library/muxpad/connectors.json as root with {"enforce": true, "allow": {...}}. Until it exists every chat on every machine may use every connector.',
            };
          if (st.uid !== 0)
            return {
              state: 'blocked',
              found: 'the policy file is not root-owned, so the agents it binds can edit it',
              remedy: 'sudo chown root:wheel /Library/muxpad/connectors.json',
            };
          return { state: 'ok' };
        },
      },
    ],
  },
];

/** Run one integration's checks. Pure given its env. */
export function preflight(id: string, env: PreflightEnv = realEnv): CheckResult[] {
  const integration = INTEGRATIONS.find((i) => i.id === id);
  if (!integration) return [];
  return integration.checks.map((c) => ({ id: c.id, question: c.question, ...c.run(env) }));
}

/**
 * Is this integration usable?
 *
 * `unknown` does NOT count as ready. A check muxpad could not run is a check
 * nobody ran, and the whole point of this file is to stop saying "probably
 * fine" about the thing standing between an agent and somebody's mail.
 */
export function ready(results: readonly CheckResult[]): boolean {
  return results.length > 0 && results.every((r) => r.state === 'ok');
}

/** The first thing to do about it, or null when there is nothing to do. */
export function nextStep(results: readonly CheckResult[]): CheckResult | null {
  return results.find((r) => r.state !== 'ok') ?? null;
}
