import { statSync } from 'node:fs';
import { type ConnectorInstall, INSTALLS_PATH, type Installs, loadInstalls } from './install.js';

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
 *
 * ── AND IT KNOWS NO PATHS ────────────────────────────────────────────────
 * The first version had `/usr/local/var/msgvault` and four of its neighbours
 * as string literals across five checks — one machine's install decisions
 * compiled into a program whose job is to CHECK installs. Every path now comes
 * from the integration's own declaration (install.ts); a machine that put its
 * archive somewhere else is checked against where it actually put it, and
 * moving it is one edit to one root-owned file.
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
  /** `where` is the integration's own declaration — see install.ts. */
  run(env: PreflightEnv, where: ConnectorInstall): Omit<CheckResult, 'id' | 'question'>;
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
        question: 'Is the archive out of the agent account’s reach?',
        run: (env, where) =>
          ownedAwayFromAgents(
            env,
            where.home,
            'the archive',
            `Move it to a service account and declare it in ${INSTALLS_PATH}. While it is readable, mediating the CLI is theatre — an agent can read the database directly.`,
          ),
      },
      {
        id: 'binary-root-owned',
        question: 'Is the binary one an agent cannot replace?',
        run: (env, where) =>
          ownedAwayFromAgents(
            env,
            where.binary,
            'the binary',
            `Install a copy outside any directory the agent account can write, and declare it in ${INSTALLS_PATH}.`,
            'runtime',
          ),
      },
      {
        id: 'libraries-root-owned',
        question: 'Are its libraries ones an agent cannot replace?',
        run: (env, where) => {
          // Declared, because which libraries a build loads from outside the
          // system is a property of that build, not of this program. Nothing
          // declared is UNKNOWN rather than ok: silence is not a guarantee.
          if (!where.libraries?.length)
            return {
              state: 'unknown',
              found: 'no libraries are declared',
              remedy: `List any non-system libraries the binary loads under "libraries" in ${INSTALLS_PATH} — \`otool -L <binary>\` shows them. Repointing one with install_name_tool invalidates the signature, so re-sign afterwards (\`codesign --force --sign - <binary>\`) or it will not launch on Apple Silicon.`,
            };
          for (const lib of where.libraries) {
            const r = ownedAwayFromAgents(env, lib, `the library ${lib}`, '', 'runtime');
            if (r.state !== 'ok')
              return {
                ...r,
                remedy: `Copy it beside the binary, repoint it with install_name_tool, then RE-SIGN: codesign --force --sign - ${where.binary}. The re-sign is not optional — install_name_tool invalidates the signature and an unsigned binary will not launch on Apple Silicon.`,
              };
          }
          return { state: 'ok' };
        },
      },
      {
        id: 'daemon-logs-writable',
        question: 'Can the daemon’s account create its log files?',
        run: (env, where) => {
          if (!where.logs?.length) return { state: 'ok' };
          for (const p of where.logs) {
            const st = env.stat(p);
            if (!st)
              return {
                state: 'blocked',
                found: `${p} does not exist`,
                // The least obvious failure in the whole install: launchd
                // cannot open the file, so it exits 78 (EX_CONFIG) BEFORE the
                // program runs — and writes no log saying so, because the log
                // is what it could not open.
                remedy: `sudo touch ${p} && sudo chown ${where.account} ${p} && sudo chmod 640 ${p}`,
              };
            if (st.uid === 0)
              return {
                state: 'blocked',
                found: `${p} is root-owned, and the daemon does not run as root`,
                remedy: `sudo chown ${where.account} ${p}`,
              };
          }
          return { state: 'ok' };
        },
      },
      {
        id: 'daemon-running',
        question: 'Is the daemon up, under its own account?',
        run: (env, where) => {
          const up = env.daemonRunning('msgvault');
          if (up === null)
            return {
              state: 'unknown',
              found: `muxpad cannot see ${where.account}’s processes`,
              remedy:
                where.statusCommand ??
                `Check it yourself — whatever supervises it should report one run and no exit code. A climbing run count is a crash loop the supervisor is hiding. Declare the command under "statusCommand" in ${INSTALLS_PATH} and this will print it for you.`,
            };
          return up
            ? { state: 'ok' }
            : { state: 'blocked', found: 'nothing is listening', remedy: 'Start the daemon.' };
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
export function preflight(
  id: string,
  env: PreflightEnv = realEnv,
  installs: Installs = loadInstalls().installs,
): CheckResult[] {
  const integration = INTEGRATIONS.find((i) => i.id === id);
  if (!integration) return [];
  const where = installs[id];
  // AN UNDECLARED INTEGRATION IS NOT A BROKEN ONE. There is nothing to check
  // against, and inventing a path to check would be the hardcoding this file
  // exists to remove.
  if (!where)
    return [
      {
        id: 'declared',
        question: `Where is ${integration.label} installed?`,
        state: 'unknown',
        found: `nothing is declared for "${id}"`,
        remedy: `Add an entry to ${INSTALLS_PATH} (root-owned, 0644) with its home, binary, account and — if its launcher writes them — its log files. Every check below reads from there.`,
      },
    ];
  return integration.checks.map((c) => ({ id: c.id, question: c.question, ...c.run(env, where) }));
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
