import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * THE SLACK CREDENTIAL, AND THE ONE PROCESS ALLOWED TO HOLD IT.
 *
 * It used to live in `~/.claude/secrets/slack.env`, and the CLI SOURCED that
 * file into the pane on every call. So the capability check was decoration
 * twice over: a chat that was refused could read the token out of the file and
 * curl Slack directly, and every chat that was allowed had the token sitting
 * in its environment for anything in that pane to pick up.
 *
 * Now the server holds it and the CLI never sees it. `muxpad slack post` asks
 * the server to post; the server decides, and the token does not leave this
 * process. That is the actual fix — not where the bytes are stored.
 *
 * ── WHY A FILE AND NOT THE DATABASE ─────────────────────────────────────────
 * A `workspaces.slack_token` column would be tidier to look at and one careless
 * change from being served: `decorateWorkspace` feeds both the browser and the
 * CLI and returns the columns it is handed, so the credential would be one
 * `SELECT *` from an API response. It would also be in every backup and every
 * `.dump`. A file the server opens by name cannot leak through a row
 * serializer by accident.
 *
 * ── AND WHY NOT PER WORKSPACE ───────────────────────────────────────────────
 * There is one Slack identity. The workspace row holds the BOOLEAN — who may
 * use it; this file holds the credential — what they use. Splitting one secret
 * across N rows would mean N copies to rotate and N places to leak it from, to
 * express something nobody has asked for.
 *
 * ── THE MIGRATION IS EXPLICIT, AND IT COST A REAL TOKEN TO LEARN THAT ───────
 * `slackToken()` used to fall through to the legacy file and `unlink` it, and
 * the legacy path was a hardcoded `homedir()` constant with no way to point it
 * anywhere else. So the FIRST test that called `slackToken()` against an empty
 * temp dir read the author's real credential and deleted it. Not a flaky test
 * — the only possible outcome, on any machine with that file.
 *
 * Two rules came out of it, and they are both load-bearing:
 *   · a READ never destroys anything. `slackToken` reads, full stop.
 *   · a path outside the data dir is a PARAMETER, never a constant. Anything
 *     a test cannot redirect is something a test will eventually act on for
 *     real.
 *
 * ── THE MODE IS CHECKED, NOT ASSUMED ────────────────────────────────────────
 * Written 0600, and REFUSED on read if it is not 0600 any more. A credential
 * file that something copied with the wrong mode is a credential every process
 * on the machine can read, and the failure is silent unless somebody looks.
 */

const FILE = 'secrets.json';

/** The file the token used to live in, sourced into every pane that asked. */
export const LEGACY_SLACK_ENV = join(homedir(), '.claude', 'secrets', 'slack.env');

export function secretsPath(dataDir: string): string {
  return join(dataDir, FILE);
}

export interface Secrets {
  slack_user_token?: string;
}

export class SecretsModeError extends Error {
  constructor(
    readonly path: string,
    readonly mode: number,
  ) {
    super(
      `${path} is mode ${mode.toString(8).padStart(4, '0')}, not 0600 — refusing to read a credential that other processes on this machine can. Fix it with: chmod 600 ${path}`,
    );
  }
}

function readAll(dataDir: string): Secrets {
  const path = secretsPath(dataDir);
  let raw: string;
  try {
    const st = statSync(path);
    // eslint-disable-next-line no-bitwise
    const mode = st.mode & 0o777;
    if (mode !== 0o600) throw new SecretsModeError(path, mode);
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    if (e instanceof SecretsModeError) throw e;
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Secrets) : {};
  } catch {
    return {};
  }
}

function writeAll(dataDir: string, next: Secrets): void {
  const path = secretsPath(dataDir);
  mkdirSync(dirname(path), { recursive: true });
  // Write-then-rename, with the mode set on the TEMP file before any content
  // reaches it. Writing in place leaves a window where the file exists with
  // the umask's mode and the token already in it; `chmod` after `writeFile`
  // closes that window late, which for a credential is not closing it.
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

/** The Slack user token, or null. Reads. Does not migrate, move or delete. */
export function slackToken(dataDir: string): string | null {
  return readAll(dataDir).slack_user_token ?? null;
}

/**
 * Move a token out of the old shell-sourced env file, ONCE, at server start.
 *
 * Called from exactly one place and given its path explicitly — see the note
 * at the top of this file for what the convenient version cost.
 *
 * It deletes the original, and that is the point rather than tidiness: the old
 * file is the thing any pane could `cat`, so copying the token out and leaving
 * it behind would change where the credential is kept and nothing at all about
 * who can reach it. It refuses to delete anything it did not successfully
 * read a token out of.
 */
export function migrateLegacySlackEnv(
  dataDir: string,
  legacyPath: string = LEGACY_SLACK_ENV,
): 'migrated' | 'nothing-to-do' {
  if (slackToken(dataDir)) return 'nothing-to-do';
  let raw: string;
  try {
    raw = readFileSync(legacyPath, 'utf8');
  } catch {
    return 'nothing-to-do';
  }
  const m = raw.match(/^\s*(?:export\s+)?SLACK_USER_TOKEN\s*=\s*['"]?(xoxp-[^\s'"]+)/m);
  if (!m?.[1]) return 'nothing-to-do';
  writeAll(dataDir, { ...readAll(dataDir), slack_user_token: m[1] });
  try {
    unlinkSync(legacyPath);
  } catch {
    // Best effort; a token in both places is no worse than before this ran.
  }
  return 'migrated';
}

export function setSlackToken(dataDir: string, token: string): void {
  writeAll(dataDir, { ...readAll(dataDir), slack_user_token: token });
}

export function clearSlackToken(dataDir: string): void {
  const { slack_user_token: _gone, ...rest } = readAll(dataDir);
  writeAll(dataDir, rest);
}

/**
 * What the UI is allowed to know: that there is one, and enough of its tail to
 * tell two apart. Never the token. A settings panel needs to answer "is this
 * set, and is it the one I think" and nothing more, and a field that can be
 * read back is a field that ends up in a screenshot.
 */
export function slackTokenHint(dataDir: string): string | null {
  const t = readAll(dataDir).slack_user_token;
  if (!t) return null;
  return `xoxp-…${t.slice(-4)}`;
}
