import type { EventEmitter } from 'node:events';
import type { PaneRuntimeSpec } from '../runtime/PaneRuntime.js';
import { LOCAL_NODE_ID, type NodeStore } from '../store/NodeStore.js';

/** Matches DEFAULT_NODE_PORT in node-agent; duplicated rather than imported so
 *  the router does not pull the agent's module into the server's graph. */
const DEFAULT_HOST_AGENT_PORT = '7797';

/**
 * WHICH MACHINE A PANE OPERATION GOES TO.
 *
 * ── THE BUG THIS EXISTS TO PREVENT ────────────────────────────────────────
 * Everything that manages a pane's life — the recovery sweep, the reaper, the
 * provisioner, the routes — talks to ONE ptyd client and assumes the answer is
 * about the only machine there is. Route pane CREATION to another node without
 * routing the rest, and the failure is not a missing feature: the sweep asks
 * "does this pane exist?", the local ptyd honestly says no, and the sweep
 * RECREATES THE CONVERSATION ON THE MAC. An adversarial review of the plan put
 * it plainly — that is execution on the wrong machine, not degradation.
 *
 * So this is introduced BEFORE any pane row can name a remote node, and it is
 * the only thing allowed to resolve a pane to a transport.
 *
 * ── UNAVAILABLE IS NOT ABSENT, AND THAT IS THE WHOLE DESIGN ───────────────
 * The single most important rule here. When a node's link is down we do not
 * know what is running on it — the pane is very probably alive and working.
 * Three answers exist and the code must keep them apart:
 *
 *    found      · the node answered, the pane is there
 *    absent     · the node answered, the pane is gone     → safe to recreate
 *    unavailable· nobody answered                          → DO NOTHING
 *
 * Collapsing the third into the second is how a healthy remote chat gets
 * duplicated locally, or killed, or "repaired". So every method here THROWS
 * {@link NodeUnavailableError} rather than returning a falsy answer, and
 * callers that cannot handle a throw must be fixed rather than wrapped in a
 * try/catch that swallows it back into `false`.
 */

/** The node exists and owns this pane, but we have no link to it right now. */
export class NodeUnavailableError extends Error {
  readonly nodeId: string;
  constructor(nodeId: string, what: string) {
    super(`node ${nodeId} is unavailable — cannot ${what}`);
    this.name = 'NodeUnavailableError';
    this.nodeId = nodeId;
  }
}

/** The pane names a node that is not configured at all. */
export class UnknownNodeError extends Error {
  readonly nodeId: string;
  constructor(nodeId: string) {
    super(`pane names node ${nodeId}, which is not configured`);
    this.name = 'UnknownNodeError';
    this.nodeId = nodeId;
  }
}

/** The subset of PtydClient this router dispatches. Structural on purpose: a
 *  remote transport only has to look like this, not inherit from it. */
export interface PaneTransport {
  ensurePane(spec: PaneRuntimeSpec): Promise<void>;
  killPane(id: string): Promise<void>;
  hasPane(id: string): Promise<boolean>;
  listPanes(): Promise<string[]>;
  getCurrentCwd(id: string): Promise<string | null>;
  getForegroundCommand(id: string): Promise<string | null>;
  markSeen(id: string): Promise<void>;
  closePtyClients(id: string): Promise<void>;
}

/**
 * The surface pane-LIFECYCLE callers actually use, which is narrower than
 * PtydClient's.
 *
 * Extracted so a router can stand where the client stands. Structural
 * assignment to `PtydClient` itself is impossible — it has private fields, and
 * TypeScript requires private members to come from the same declaration — so
 * the dependency has to be named by what it DOES. Which is better anyway: a
 * caller that only kills panes should not be typed against a socket client.
 *
 * `PtydCache` deliberately keeps taking the concrete client: it wires the
 * decoration event stream and the `flushCwds`/`flushDecorations` snapshots,
 * which are per-machine concerns and get their own per-node instance later.
 */
export interface PaneOps extends PaneTransport, Pick<EventEmitter, 'on' | 'off'> {
  close(): Promise<void>;
}

export interface PaneRouterDeps {
  /** This machine. Always present; its "link" is a unix socket. */
  local: PaneOps;
  nodes: NodeStore;
  /** A live transport for a remote node, or null when the link is down. */
  remote: (nodeId: string) => PaneTransport | null;
}

/** Where a global sweep could not look, so a caller can say so instead of
 *  quietly reporting a short list as if it were complete. */
export interface GlobalResult<T> {
  value: T;
  /** Nodes that did not answer. Non-empty means the result is PARTIAL. */
  unreachable: string[];
}

export class PaneRouter implements PaneOps {
  constructor(private readonly deps: PaneRouterDeps) {}

  /**
   * The transport that owns this pane.
   *
   * Throws rather than falling back to local. A fallback here would be the
   * exact bug this class prevents, one layer lower and much harder to see.
   */
  private transportFor(paneId: string, what: string): PaneTransport {
    const nodeId = this.deps.nodes.nodeForPane(paneId);
    if (nodeId === LOCAL_NODE_ID) return this.deps.local;
    if (!this.deps.nodes.get(nodeId)) throw new UnknownNodeError(nodeId);
    const t = this.deps.remote(nodeId);
    if (!t) throw new NodeUnavailableError(nodeId, what);
    return t;
  }

  /** Where a pane WOULD be created, before its row exists. */
  private transportForNode(nodeId: string, what: string): PaneTransport {
    if (nodeId === LOCAL_NODE_ID) return this.deps.local;
    if (!this.deps.nodes.get(nodeId)) throw new UnknownNodeError(nodeId);
    const t = this.deps.remote(nodeId);
    if (!t) throw new NodeUnavailableError(nodeId, what);
    return t;
  }

  /** Create a pane ON A NAMED NODE. The node is explicit because at creation
   *  there is no row yet to read it from — the caller has just decided it. */
  async ensurePaneOn(nodeId: string, spec: PaneRuntimeSpec): Promise<void> {
    return this.transportForNode(nodeId, 'create a pane').ensurePane(this.localize(nodeId, spec));
  }

  async ensurePane(spec: PaneRuntimeSpec): Promise<void> {
    const nodeId = this.deps.nodes.nodeForPane(spec.id);
    return this.transportFor(spec.id, 'create a pane').ensurePane(this.localize(nodeId, spec));
  }

  /**
   * Point a REMOTE pane's in-pane CLI at its own machine's agent.
   *
   * `PaneRuntime` builds `MUXPAD_API_URL` from the ptyd process's own
   * environment, which on another machine resolves to a loopback address with
   * nothing listening. A pane there must dial its local muxpad-node, which
   * relays to this server over the link — and that is what lets a runner
   * report turns at all, since the host cannot reach us directly.
   *
   * Done HERE because every spawn goes through this class. The spec is built
   * in several places and a per-site fix is how one gets missed; today has
   * already produced two bugs of exactly that shape.
   *
   * The port is taken from the node's own endpoint, so a host on a
   * non-default port works without a second place to configure it.
   */
  private localize(nodeId: string, spec: PaneRuntimeSpec): PaneRuntimeSpec {
    if (nodeId === LOCAL_NODE_ID) return spec;
    const endpoint = this.deps.nodes.get(nodeId)?.endpoint ?? '';
    let port = DEFAULT_HOST_AGENT_PORT;
    try {
      const p = new URL(endpoint.replace(/^ws/, 'http')).port;
      if (p) port = p;
    } catch {
      // Malformed endpoint: the default is the right guess, and a link we
      // could not parse would have failed to open long before this.
    }
    // ── AND THE CWD, RESTORED FROM THE ROW ──────────────────────────────
    //
    // `safeCwd()` stats a path on THIS machine and falls back to this
    // machine's home when it is missing. For a remote pane that is always
    // wrong: /home/ohad/work does not exist on a mac, so the spec arrived
    // asking a Linux host to spawn a shell in /Users/ohadpr — which does not
    // exist THERE, so the pty died instantly. That is what
    // "the pty exited immediately after starting" was.
    //
    // There are SIXTEEN safeCwd/agentCwd call sites building specs. Fixing the
    // one I happened to be looking at is the mistake I have now made three
    // times today (two of seven transcript readers, one of three enqueueSid
    // callers). So it is repaired HERE, where every spawn passes, by taking
    // the cwd from the pane ROW — which holds the path the user actually
    // asked for, untouched by any local stat.
    const row = this.deps.nodes.cwdForPane(spec.id);
    return {
      ...spec,
      ...(row ? { cwd: row } : {}),
      env: { ...(spec.env ?? {}), MUXPAD_API_URL: `http://127.0.0.1:${port}` },
    };
  }

  /**
   * Kill a pane ON A NAMED NODE, for a pane whose ROW IS ALREADY GONE.
   *
   * The tombstone sweep needs this: by the time a kill is queued the row is
   * usually deleted, so `nodeForPane` would answer `local` for a pane that
   * lives elsewhere and the kill would be sent to the wrong machine — where
   * ptyd would answer "unknown id" as an idempotent success and the tombstone
   * would be cleared with the real process still running.
   */
  async killPaneOn(nodeId: string, id: string): Promise<void> {
    return this.transportForNode(nodeId, 'kill a pane').killPane(id);
  }

  async killPane(id: string): Promise<void> {
    return this.transportFor(id, 'kill a pane').killPane(id);
  }

  /**
   * Is this pane running?
   *
   * THROWS when the node is unreachable — it does NOT return false. Every
   * caller of this drives a decision about whether to recreate or reap, and
   * `false` is the answer that authorises destruction.
   */
  async hasPane(id: string): Promise<boolean> {
    return this.transportFor(id, 'check a pane').hasPane(id);
  }

  async getCurrentCwd(id: string): Promise<string | null> {
    return this.transportFor(id, 'read a cwd').getCurrentCwd(id);
  }

  async getForegroundCommand(id: string): Promise<string | null> {
    return this.transportFor(id, 'read a foreground command').getForegroundCommand(id);
  }

  async markSeen(id: string): Promise<void> {
    return this.transportFor(id, 'mark a pane seen').markSeen(id);
  }

  async closePtyClients(id: string): Promise<void> {
    return this.transportFor(id, 'close pty clients').closePtyClients(id);
  }

  /**
   * Every live pane, across every node — ALL OR NOTHING.
   *
   * Throws if any node could not be reached, and that is the point: both
   * production callers are RECONCILERS, and a reconciler handed a silently
   * short list concludes that everything it cannot see is gone. The reaper
   * already bails on a throw ("ptyd unreachable — keep the row; next sweep
   * retries"), so throwing lands it in behaviour it was already written for.
   *
   * Signature-compatible with PtydClient on purpose, so the ~50 existing call
   * sites move over without edits.
   */
  async listPanes(): Promise<string[]> {
    const { value, unreachable } = await this.listPanesBestEffort();
    if (unreachable.length)
      throw new NodeUnavailableError(unreachable[0] as string, 'enumerate panes');
    return value;
  }

  /**
   * The same, but partial is acceptable.
   *
   * For DISPLAY only — the panes list renders `isRunning` off this, and one
   * sleeping node must not make every local pane read as stopped. A caller
   * choosing this is asserting that a partial answer is honest for its
   * purpose; the name is long so that assertion is visible at the call site.
   */
  async listPanesBestEffort(): Promise<GlobalResult<string[]>> {
    const ids: string[] = [];
    const unreachable: string[] = [];
    for (const node of this.deps.nodes.list()) {
      const t = node.id === LOCAL_NODE_ID ? this.deps.local : this.deps.remote(node.id);
      if (!t) {
        unreachable.push(node.id);
        continue;
      }
      try {
        ids.push(...(await t.listPanes()));
      } catch {
        // An answer that arrived as an error is not an empty answer.
        unreachable.push(node.id);
      }
    }
    return { value: ids, unreachable };
  }

  // ── PASSTHROUGH TO THIS MACHINE, FOR NOW ───────────────────────────────
  //
  // Events and shutdown are the LOCAL client's: a remote node's decoration
  // stream arrives over its own link and gets its own cache instance, which
  // is later work. Forwarding rather than reimplementing keeps today's
  // behaviour byte-identical while only `local` exists — which is precisely
  // what makes introducing this router safe to land unattended.
  //
  // Signatures borrowed from node's own EventEmitter via `Parameters<>` rather
  // than hand-written: a hand-written `(...args: never[]) => void` is TOO
  // STRICT under strictFunctionTypes — EventEmitter's listener takes `any[]`,
  // and `any` is not assignable to `never`, so PtydClient failed to satisfy
  // the very interface extracted from it. Reusing the declaration cannot
  // drift from it.
  on(...a: Parameters<EventEmitter['on']>): ReturnType<EventEmitter['on']> {
    return this.deps.local.on(...a);
  }

  off(...a: Parameters<EventEmitter['off']>): ReturnType<EventEmitter['off']> {
    return this.deps.local.off(...a);
  }

  /** Closes the LOCAL transport. Remote links are owned by whatever opened
   *  them, so this must not reach across and tear down somebody else's. */
  async close(): Promise<void> {
    return this.deps.local.close();
  }
}
