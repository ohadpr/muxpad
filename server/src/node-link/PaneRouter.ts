import type { PaneRuntimeSpec } from '../runtime/PaneRuntime.js';
import { LOCAL_NODE_ID, type NodeStore } from '../store/NodeStore.js';

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

export interface PaneRouterDeps {
  /** This machine. Always present; its "link" is a unix socket. */
  local: PaneTransport;
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

export class PaneRouter {
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
    return this.transportForNode(nodeId, 'create a pane').ensurePane(spec);
  }

  async ensurePane(spec: PaneRuntimeSpec): Promise<void> {
    return this.transportFor(spec.id, 'create a pane').ensurePane(spec);
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
   * Every live pane, across every node.
   *
   * Returns the unreachable nodes ALONGSIDE the ids, because the caller is a
   * reconciler: "these ids are alive" plus a silently short list means
   * "everything on the unreachable node is dead", which is the same fatal
   * confusion as `hasPane` returning false. A caller that ignores
   * `unreachable` is a caller with a bug, and it has to opt into that by
   * destructuring past it.
   */
  async listPanes(): Promise<GlobalResult<string[]>> {
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
}
