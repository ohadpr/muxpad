import { type FileIO, loadJsonFile, realIO } from './trusted-file.js';

/**
 * WHERE AN INTEGRATION ACTUALLY LIVES — declared once, read everywhere.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────
 * The first version of the msgvault checks had `/usr/local/var/msgvault`,
 * `/usr/local/libexec/msgvault/msgvault`, `_msgvault` and two log paths spread
 * across five checks as string literals, and the pass-through was about to
 * grow its own copies. That is a map of one machine compiled into a program,
 * and the owner called it: "I don't like how hardcoded all this shit is
 * becoming."
 *
 * It is also wrong on its own terms. These paths are an INSTALL DECISION —
 * where somebody chose to put a service account's data on one computer — and a
 * program that assumes them cannot be checked against a machine that chose
 * differently, which is exactly what the checks are for.
 *
 * So the install declares itself, in a root-owned file beside the connector
 * policy, and every check and every exec path reads from there. Moving the
 * archive becomes one edit to that file.
 *
 * ── AND NO DEFAULTS ──────────────────────────────────────────────────────
 * An absent declaration means NOT CONFIGURED, not "assume the usual place".
 * A default here would be the hardcoding wearing a hat: the checks would pass
 * or fail against a path nobody chose, and a correct install elsewhere would
 * be reported as broken.
 */

/** Root-owned, 0644, beside connectors.json. */
export const INSTALLS_PATH = '/Library/muxpad/integrations.json';

export interface ConnectorInstall {
  /** The data directory — the thing that must be out of the agents' reach. */
  home: string;
  /** The executable muxpad runs, which must be one agents cannot replace. */
  binary: string;
  /** Libraries it loads from outside the system, same requirement. */
  libraries?: string[];
  /** The OS account the daemon runs as. */
  account: string;
  /** Files the daemon's launcher writes to, which that account must own. */
  logs?: string[];
  /** How to ask whether it is up — printed, never run by muxpad. */
  statusCommand?: string;
  /** Where the tool's own daemon answers, when it speaks over a local API. */
  agentUrl?: string;
  /** The delegated grant muxpad presents to it. A PATH, never the secret:
   *  muxpad hands the file to the tool and never reads it itself. */
  tokenFile?: string;
}

export type Installs = Record<string, ConnectorInstall>;

const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const absolute = (v: unknown): v is string => str(v) && v.startsWith('/');

/** Keep only entries that declare the fields a check cannot do without. An
 *  entry missing `home` or `binary` is not a stricter install, it is an
 *  unanswerable one. */
export function parseInstalls(raw: unknown): Installs {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return Object.create(null);
  const out: Installs = Object.create(null);
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(id)) continue;
    if (!value || typeof value !== 'object') continue;
    const v = value as Record<string, unknown>;
    if (!absolute(v.home) || !absolute(v.binary) || !str(v.account)) continue;
    const list = (x: unknown) => (Array.isArray(x) ? x.filter(absolute) : undefined);
    out[id] = {
      home: v.home,
      binary: v.binary,
      account: v.account,
      ...(list(v.libraries)?.length ? { libraries: list(v.libraries) as string[] } : {}),
      ...(list(v.logs)?.length ? { logs: list(v.logs) as string[] } : {}),
      ...(str(v.statusCommand) ? { statusCommand: v.statusCommand } : {}),
      // Loopback only. A declaration that points the grant at another host
      // would send the token off this machine — and the file is root-owned
      // precisely so that nothing an agent can edit decides where it goes.
      ...(str(v.agentUrl) && /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(v.agentUrl)
        ? { agentUrl: v.agentUrl }
        : {}),
      ...(absolute(v.tokenFile) ? { tokenFile: v.tokenFile } : {}),
    };
  }
  return out;
}

export interface LoadedInstalls {
  installs: Installs;
  /** Set when the file exists but cannot be trusted — see trusted-file. */
  problem?: string;
}

/**
 * Read the declarations.
 *
 * Same discipline as the connector policy: root-owned, root-owned ancestors,
 * judged through one file descriptor. A file an agent can edit is a file that
 * can point these checks — and the exec path — at a directory the agent owns.
 */
export function loadInstalls(path: string = INSTALLS_PATH, io: FileIO = realIO): LoadedInstalls {
  const file = loadJsonFile(path, io);
  if (file.kind === 'absent') return { installs: Object.create(null) };
  if (file.kind === 'untrusted') return { installs: Object.create(null), problem: file.problem };
  return { installs: parseInstalls(file.value) };
}
