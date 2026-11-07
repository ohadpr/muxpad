import type Database from 'better-sqlite3';
import { LOCAL_NODE_ID, NodeStore } from '../store/NodeStore.js';
import { type FileIO, loadTrustedText, realIO } from './trusted-file.js';

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
 * server. It does not DECIDE anything on its own — the broker is asked next
 * and keeps its own copy — but it is the rule that stops a personal chat
 * reaching for the work Slack by accident, so it is worth pinning case by
 * case.
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

export function trustedBytes(raw: string, path: string): ConnectorPolicy & { problem?: string } {
  // AN EMPTY TRUSTED FILE SEALS. `parsePolicy('')` is UNSCOPED, which is right
  // for a value from anywhere else and wrong for a file somebody installed:
  // truncating the policy to zero bytes was a way to turn scoping off.
  if (raw.trim() === '') return sealed(`${path} is empty`);
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
export function loadPolicy(
  path: string = POLICY_PATH,
  io: FileIO = realIO,
): ConnectorPolicy & { problem?: string } {
  const file = loadTrustedText(path, io);
  // ONLY "it is not there" is unscoped. Every other failure — a directory
  // chmod 0 above it, a symlink, an unreadable file — is a policy we cannot
  // read, and reading that as "no policy" would let an agent turn scoping off
  // by making the file unreadable.
  if (file.kind === 'absent') return UNSCOPED;
  if (file.kind === 'untrusted') return sealed(file.problem);
  return trustedBytes(file.text, path);
}

/**
 * WHO TOLD THIS CHAT TO DO IT — the laundering path, closed.
 *
 * Scoping by the asking chat's machine has an obvious hole: a personal chat
 * can tell a WORK chat to post to Slack (`muxpad agent send`, or by creating a
 * pane on that machine and briefing it), and the request that arrives is the
 * work chat's, which is allowed. The instruction crossed the boundary even
 * though the request did not.
 *
 * So a request carries both machines and must be allowed for BOTH: privilege
 * is the intersection of the chat doing the work and the chat that directed
 * it. muxpad already records the provenance this needs — `inbound_messages`
 * holds which tab sent a message into which tab, and when.
 *
 * THE WINDOW IS AN APPROXIMATION AND IS LABELLED AS ONE. There are no turn
 * boundaries in that table, so "directed by" means "the most recent inbound
 * message, if it arrived within `DIRECTED_WINDOW_MS`". Too short and a slow
 * turn launders; too long and a chat stays tainted by an instruction it
 * finished with hours ago. Fifteen minutes is the compromise, and a wrong
 * answer here fails toward refusing rather than allowing.
 */
export const DIRECTED_WINDOW_MS = 15 * 60_000;

/** The machine of whoever last directed this pane's chat, or null. */
export function directingOrigin(
  db: Database.Database,
  paneId: string,
  now: number = Date.now(),
): string | null {
  const row = db
    .prepare(`SELECT i.from_tab_id AS fromTab, i.at AS at
                FROM inbound_messages i
                JOIN panes p ON p.tab_id = i.tab_id
               WHERE p.id = ? AND i.from_tab_id IS NOT NULL
               ORDER BY i.at DESC, i.rowid DESC LIMIT 1`)
    .get(paneId) as { fromTab: string; at: number } | undefined;
  if (!row || now - row.at > DIRECTED_WINDOW_MS) return null;
  const sender = db
    .prepare('SELECT node_id AS n FROM panes WHERE tab_id = ? ORDER BY created_at ASC LIMIT 1')
    .get(row.fromTab) as { n: string | null } | undefined;
  if (!sender) return null;
  return sender.n || LOCAL_NODE_ID;
}

export function mayPaneUse(
  db: Database.Database,
  connector: ConnectorId,
  paneId: string,
  // NO DEFAULT. This used to call `loadPolicy()` for a caller that omitted it,
  // which hid a filesystem read inside a security check and let a mutant swap
  // the default for UNSCOPED with nothing noticing. A call site must say which
  // policy it is deciding under.
  policy: ConnectorPolicy & { problem?: string },
  directedBy: string | null = null,
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
  // ── AND IT MUST NAME A MACHINE WE KNOW ────────────────────────────────
  //
  // `''` was being read as `local`, because `nodeForPane` treats a null node
  // as this machine and `|| LOCAL_NODE_ID` extended that to the empty string.
  // But `POST /api/panes` accepts `node_id: ""`, so that was a second spelling
  // of "local" that no policy names — and a row naming a machine since removed
  // is a third. A connector is scoped to a MACHINE; an origin that is not one
  // is refused rather than mapped onto the machine with the most access.
  const raw = row.n;
  const known =
    raw === null || raw === LOCAL_NODE_ID
      ? LOCAL_NODE_ID
      : raw && new NodeStore(db).get(raw)
        ? raw
        : null;
  if (!known)
    return {
      ok: false,
      origin: raw ?? '',
      enforced: policy.enforce,
      reason: `that chat's machine is not one muxpad knows (${raw === '' ? 'blank' : String(raw)})`,
    };
  const origin = known;
  const d = mayUse(connector, origin, policy);
  const withProblem = (x: ScopeDecision) =>
    x.ok || !policy.problem ? x : { ...x, reason: policy.problem };
  if (!d.ok) return withProblem(d);
  // BOTH MACHINES, or neither. The work chat may post; the personal chat that
  // told it to may not; so this request may not.
  if (directedBy && directedBy !== origin) {
    const by = mayUse(connector, directedBy, policy);
    if (!by.ok)
      return withProblem({
        ok: false,
        origin,
        enforced: by.enforced,
        reason: `this chat may use ${connector}, but it was directed to by a chat on ${directedBy}, which may not`,
      });
  }
  return d;
}
