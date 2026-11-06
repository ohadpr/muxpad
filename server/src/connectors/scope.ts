import { lstatSync, readFileSync } from 'node:fs';
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
 * control answering to the thing it controls.
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
 * So it is a ROOT-OWNED FILE, checked on every read, exactly like the broker's
 * own `node-policy.json`. On this machine `sudo` needs a password, so a
 * root-owned file is genuinely out of an agent's reach.
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
  if (!raw) return UNSCOPED;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return UNSCOPED;
  }
  if (!v || typeof v !== 'object') return UNSCOPED;
  const o = v as { enforce?: unknown; allow?: unknown };
  const allow: Record<string, string[]> = {};
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
  const allowed = policy.allow[connector];
  if (!allowed || allowed.length === 0)
    return {
      ok: false,
      origin,
      enforced: true,
      reason: `no machine is allowed to use ${connector} — set one in Settings → Connectors`,
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
  return { enforce: true, allow: {}, problem };
}

/**
 * Load the policy from disk.
 *
 * Absent file → UNSCOPED, which is the fresh-install state and the state this
 * ships in. Present but untrusted → everything refused, loudly. Present and
 * trusted → whatever it says.
 */
export function loadPolicy(path: string = POLICY_PATH): ConnectorPolicy & { problem?: string } {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(path);
  } catch {
    return UNSCOPED;
  }
  if (st.isSymbolicLink()) return sealed(`${path} is a symlink`);
  if (st.uid !== 0) return sealed(`${path} is not root-owned`);
  if (st.mode & 0o022) return sealed(`${path} is writable by its group or by everyone`);
  try {
    return readPolicy(readFileSync(path, 'utf8'));
  } catch {
    return sealed(`${path} could not be read`);
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
  const origin = new NodeStore(db).nodeForPane(paneId) || LOCAL_NODE_ID;
  const d = mayUse(connector, origin, policy);
  return d.ok || !policy.problem ? d : { ...d, reason: policy.problem };
}
