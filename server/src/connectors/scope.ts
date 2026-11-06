import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { dirname } from 'node:path';
import type Database from 'better-sqlite3';
import { LOCAL_NODE_ID, NodeStore } from '../store/NodeStore.js';

/**
 * WHICH MACHINE'S CHATS MAY USE WHICH CONNECTOR.
 *
 * ── THE REQUIREMENT, IN THE OWNER'S WORDS ────────────────────────────────
 * "All work chats run on that VM and then those chats that can write to slack
 * can't read my personal muxpad stuff… I don't want to approve slack for a day
 * and discover my personal chats on the mini have been using slack."
 *
 * So a connector belongs to a HOST, and a request from any other host is
 * refused. Email will be the mini's, Slack the work VM's, and whatever comes
 * next declares its own.
 *
 * ── WHAT THIS IS, AND IS NOT ─────────────────────────────────────────────
 * This runs in muxpad's server, which shares an OS account with the agents it
 * is policing — so a determined agent on the hosting machine can edit it. That
 * is not a reason to skip it, and it IS a reason not to oversell it:
 *
 *   · It stops the ACCIDENT, which is the thing that actually happens: a
 *     personal chat reaching for Slack because it could, an eager debug, a
 *     prompt injection off a web page.
 *   · It does NOT stop a hostile agent on the hosting machine. The approval
 *     ceremony is what stands there, and it has to live on a surface that
 *     agent cannot draw (see the broker-origin approval page).
 *
 * The ORIGIN is never taken from a request body. It is resolved here from the
 * pane's own row, because a host asserting which host it is would be the whole
 * control answering to the thing it controls. What the caller DOES assert is
 * which pane is asking, so a route must have proven that first (the Slack
 * routes verify a per-pane key); an unknown pane is refused here rather than
 * defaulted, which is where the first version of this had a hole.
 *
 * ── ENFORCEMENT IS A SWITCH, AND OFF IS HONEST ───────────────────────────
 * Scoping only makes sense once the chats have moved to the machines they
 * belong on; flipping it early locks the owner out of Slack from the only
 * machine they have chats on. So enforcement is explicit, and while it is off
 * every decision says so — `enforced: false` travels with the allow, so the
 * approval prompt and the audit record can both state that nothing was scoped
 * rather than implying a check that did not happen.
 *
 * When enforcement is ON the default is DENY: a connector with no entry, or a
 * connector this build has never heard of, is refused. A fail-open default in
 * the one function that answers "may this chat touch my mail" is how a hole
 * ships quietly.
 *
 * ── WHERE THE POLICY LIVES, AND WHY NOT IN `app_prefs` ───────────────────
 * The first version of this read the policy from a pref. That was wrong by
 * construction: `PUT /api/prefs/:key` is reachable by any client holding the
 * api-secret, which every agent on the hosting machine does — so the policed
 * would have been editing the policy. It would also have ridden the prefs push
 * to every browser, which is harmless but tells you what kind of value it was
 * being treated as.
 *
 * So it is a ROOT-OWNED FILE, checked on every read in the spirit of the
 * broker's own `node-policy.json` — though not as strictly: that one also
 * refuses ACLs, via a shell out to `ls -lde`, and this one does not. A macOS
 * ACL granting write is invisible to a mode check, so the honest claim is
 * "root-owned and with root-owned ancestors", not "unforgeable". The broker is
 * the boundary; this is the fast refusal.
 *
 * On this machine `sudo` needs a password, so a root-owned file with
 * root-owned ancestors is out of an agent's ordinary reach. The ancestors
 * matter and are checked: a root-owned file inside a directory the agent can
 * write is a file the agent can replace by replacing its parent.
 *
 * And a TAMPERED file fails CLOSED. If the file exists but is not root-owned,
 * or is group/world-writable, or is a symlink, every connector is refused and
 * the reason says so. The alternative — ignoring an untrusted file and falling
 * back to "unscoped" — would mean an agent could disable scoping by making the
 * policy file look broken, which is the cheapest attack there is.
 *
 * muxpad's copy is ADVISORY. The broker re-checks the origin before it mints
 * anything, because it is the only participant an agent on this machine cannot
 * edit. This check exists to fail fast and to explain itself to the agent.
 */

/** A connector's id — the part before the dot in an action kind. */
export type ConnectorId = string;

export interface ConnectorPolicy {
  /** Is host scoping being enforced at all? */
  enforce: boolean;
  /** connector id → node ids whose panes may use it. */
  allow: Record<ConnectorId, string[]>;
}

/** Root-owned, 0644, no symlinks, like the broker's node policy. */
export const POLICY_PATH = '/Library/muxpad/connectors.json';

/** Nothing configured: no scoping, stated plainly rather than implied. */
export const UNSCOPED: ConnectorPolicy = { enforce: false, allow: {} };

/**
 * Read the policy, or `UNSCOPED`.
 *
 * Every parse failure reads as UNSCOPED rather than as deny-everything: a
 * corrupt pref must not silently turn off a working Slack connector, and it
 * must not silently turn one on either — `enforce` stays false, so the
 * decisions it produces are marked unscoped and visible as such.
 */
export function readPolicy(raw: string | null | undefined): ConnectorPolicy {
  return parsePolicy(raw) ?? UNSCOPED;
}

/**
 * Parse, or `null` for "this is not a policy".
 *
 * Separate from {@link readPolicy} because the two callers need opposite
 * things from a malformed value. A string handed in from anywhere reads as
 * UNSCOPED — lenient. A root-owned FILE that does not parse is SEALED, because
 * it was put there deliberately and failing open on a typo would have turned
 * scoping off silently: a trailing comma in a hand-edited policy is not
 * consent to drop the policy.
 */
export function parsePolicy(raw: string | null | undefined): ConnectorPolicy | null {
  if (raw === null || raw === undefined || raw === '') return UNSCOPED;
  let v: unknown;
  try {
    // A BOM is what several editors write and `readFileSync(…, 'utf8')` does
    // not strip it; JSON.parse then throws on a file that is otherwise fine.
    v = JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
  // An ARRAY parses as an object and would have come back as a policy with an
  // empty allow — i.e. as "no policy" rather than as "not a policy".
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as { enforce?: unknown; allow?: unknown };
  // NULL-PROTOTYPE, so a connector named `constructor` or `hasOwnProperty`
  // cannot reach Object's own properties — `policy.allow[c]` was returning a
  // function for those and throwing on `.length` instead of refusing.
  const allow: Record<string, string[]> = Object.create(null);
  if (o.allow && typeof o.allow === 'object') {
    for (const [k, list] of Object.entries(o.allow as Record<string, unknown>)) {
      if (!/^[a-z][a-z0-9_-]{0,31}$/.test(k)) continue;
      if (!Array.isArray(list)) continue;
      const nodes = list.filter((n): n is string => typeof n === 'string' && n.length > 0);
      if (nodes.length > 0) allow[k] = nodes;
    }
  }
  return { enforce: o.enforce === true, allow };
}

export interface ScopeDecision {
  ok: boolean;
  /** The machine the asking pane lives on — resolved, never asserted. */
  origin: string;
  /** Was the answer produced by an enforced rule, or by scoping being off? */
  enforced: boolean;
  /** Why it was refused, for the caller to pass to the agent verbatim. */
  reason?: string;
}

/**
 * May a pane on `origin` use `connector`?
 *
 * Pure, so the rule can be tested against a table rather than against a live
 * server — this is the function that decides whether a personal chat can touch
 * the work Slack, and it is worth pinning case by case.
 */
export function mayUse(
  connector: ConnectorId,
  origin: string,
  policy: ConnectorPolicy,
): ScopeDecision {
  if (!policy.enforce) return { ok: true, origin, enforced: false };
  const allowed = Object.hasOwn(policy.allow, connector) ? policy.allow[connector] : undefined;
  if (!allowed || allowed.length === 0)
    return {
      ok: false,
      origin,
      enforced: true,
      // Names the FILE, not a Settings page. There is no UI for this and by
      // this module's own argument there must not be one: a web surface that
      // could rewrite the policy would hand it back to the agents it binds.
      reason: `no machine is allowed to use ${connector} — edit ${POLICY_PATH} as root`,
    };
  if (!allowed.includes(origin))
    return {
      ok: false,
      origin,
      enforced: true,
      // Names the machine, because the agent's useful next move is to say so
      // rather than to retry: "this chat is on the wrong machine for that".
      reason: `${connector} is scoped to ${allowed.join(', ')}; this chat runs on ${origin}`,
    };
  return { ok: true, origin, enforced: true };
}

/** Deny everything, because the policy itself cannot be trusted. */
function sealed(problem: string): ConnectorPolicy & { problem: string } {
  return { enforce: true, allow: Object.create(null), problem };
}

/**
 * What is wrong with this file's metadata, or null.
 *
 * Pure and exported so the branches can be table-tested without being root —
 * the mode and file-type refusals were untestable while this was inline, and
 * a sabotage of the mode check survived the whole suite.
 */
export function trustProblem(st: Stats, what: string): string | null {
  if (!st.isFile()) return `${what} is not a regular file`;
  if (st.uid !== 0) return `${what} is not root-owned`;
  if (st.mode & 0o022) return `${what} is writable by its group or by everyone`;
  // A hardlink means the same inode is reachable from a path we did not check,
  // so its ancestors are not the ones we just walked.
  if (st.nlink !== 1) return `${what} has more than one link`;
  return null;
}

/** The directories above it must be root's too: a root-owned file in a
 *  directory the agent can write is a file the agent can replace. */
function ancestorProblem(path: string): string | null {
  let cur = dirname(path);
  for (;;) {
    let st: Stats;
    try {
      st = lstatSync(cur);
    } catch {
      return `${cur} could not be inspected`;
    }
    if (st.isSymbolicLink()) return `${cur} is a symlink`;
    if (!st.isDirectory()) return `${cur} is not a directory`;
    if (st.uid !== 0) return `${cur} is not root-owned`;
    if (st.mode & 0o022) return `${cur} is writable by its group or by everyone`;
    const up = dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
}

/**
 * Bytes from a file that PASSED the metadata checks.
 *
 * Pure and exported so the fail-closed branch can be tested without being
 * root: while this was inline, "a trusted file that does not parse fails open"
 * survived every sabotage because nothing could reach it.
 */
export function trustedBytes(raw: string, path: string): ConnectorPolicy & { problem?: string } {
  // A trusted file that does not parse is NOT "no policy": it was put there
  // deliberately, and a typo is not consent to stop scoping.
  return parsePolicy(raw) ?? sealed(`${path} is not valid JSON`);
}

/**
 * Load the policy from disk.
 *
 * Absent file → UNSCOPED, which is the fresh-install state and the state this
 * ships in. Present but untrusted → everything refused, loudly. Present and
 * trusted → whatever it says.
 */
export function loadPolicy(path: string = POLICY_PATH): ConnectorPolicy & { problem?: string } {
  // OPENED ONCE AND INSPECTED THROUGH THE FD. Stat-then-read is a race: the
  // path can be swapped between the two calls, and `readFileSync` follows a
  // symlink that `lstatSync` only reported. O_NOFOLLOW refuses a symlinked
  // final component outright; everything else is judged on the open file.
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    // ONLY "it is not there" is unscoped. Every other failure — a directory
    // chmod 0 above it, ELOOP, ENOTDIR, a symlink refused by O_NOFOLLOW — is a
    // policy we cannot read, and reading that as "no policy" would let an agent
    // turn scoping off by making the file unreadable.
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return UNSCOPED;
    return sealed(`${path} could not be opened (${(e as NodeJS.ErrnoException).code})`);
  }
  try {
    const bad = trustProblem(fstatSync(fd), path) ?? ancestorProblem(path);
    if (bad) return sealed(bad);
    return trustedBytes(readFileSync(fd, 'utf8'), path);
  } catch {
    return sealed(`${path} could not be read`);
  } finally {
    closeSync(fd);
  }
}

/**
 * The same question, for a live pane.
 *
 * Resolves the origin from the pane's row via `nodeForPane`, which answers
 * `local` for a pane with no node — the correct reading for a pane on this
 * machine and for a pane whose row is gone.
 */
export function mayPaneUse(
  db: Database.Database,
  connector: ConnectorId,
  paneId: string,
  policy: ConnectorPolicy & { problem?: string } = loadPolicy(),
): ScopeDecision {
  // ── AN UNKNOWN PANE IS NOT A LOCAL PANE ───────────────────────────────
  //
  // `nodeForPane` answers `local` for a pane it cannot find, which is right
  // for its own job — a pane with no node row IS local — and wrong here,
  // because it conflates that with a pane that does not exist. The effect was
  // a bypass: any connector scoped to `local` was reachable by naming a pane
  // id that resolves to nothing. Three ways in, all of them real: an invented
  // id from a caller whose pane was never verified; a VM pane whose row was
  // deleted with its node (`routes/nodes.ts` removes the rows); and a pane
  // created with `node_id: ""`, which the panes route accepts.
  //
  // So existence is asked separately, and absence refuses.
  const row = db.prepare('SELECT node_id AS n FROM panes WHERE id = ?').get(paneId) as
    | { n: string | null }
    | undefined;
  if (!row)
    return {
      ok: false,
      origin: '',
      enforced: policy.enforce,
      reason: 'no such chat — a connector is used by a chat, and that one does not exist',
    };
  const origin = row.n || LOCAL_NODE_ID;
  const d = mayUse(connector, origin, policy);
  return d.ok || !policy.problem ? d : { ...d, reason: policy.problem };
}
