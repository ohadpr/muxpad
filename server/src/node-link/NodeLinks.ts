import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PtydClient } from '../ptyd-client/PtydClient.js';
import { LOCAL_NODE_ID, type NodeStore } from '../store/NodeStore.js';
import type { PaneTransport } from './PaneRouter.js';

/**
 * THE MAC'S OUTBOUND LINKS, one per remote machine.
 *
 * ── THE MAC DIALS; NOTHING DIALS IN ───────────────────────────────────────
 * Measured on the real pair: mac→VM works, VM→mac is blocked (no tailnet
 * view, ping 100% loss, port unreachable), and changing Tailscale is out of
 * scope. So this opens every connection and a node only ever listens. That is
 * also the better posture: the machine holding the user's whole life needs no
 * inbound exposure at all.
 *
 * ── A LINK IS A PtydClient ────────────────────────────────────────────────
 * Not a new protocol. ptyd's control channel is already HTTP/WS, so a remote
 * node is the same client pointed at `ws://host:7797/control` with the node's
 * token — inheriting reconnect, backoff, the RPC envelope and the event
 * stream from code that is already load-bearing locally.
 *
 * ── `null` MEANS "NO LINK", AND CALLERS MUST FEEL IT ──────────────────────
 * {@link get} returns null while a node is not connected, and PaneRouter
 * turns that into a THROW rather than a falsy answer. That chain is the whole
 * safety property: "I cannot see that machine" must never be answerable as
 * "that pane is gone", which is what authorises recreating a live chat on the
 * wrong host.
 */

/** Where a node's token lives on THIS machine, one file per node. */
export function nodeTokenPath(nodeId: string, dataDir?: string): string {
  const dir = dataDir ?? process.env.MUXPAD_DATA_DIR ?? join(homedir(), '.muxpad');
  return join(dir, 'node-tokens', nodeId);
}

/**
 * Read a node's token.
 *
 * Per call, like every other credential reader here, so rotating one does not
 * need a server restart. A short file is treated as absent rather than as a
 * credential — that is a failed earlier write, and presenting it would get the
 * link refused in a way that looks like a server problem.
 */
export function readNodeTokenFor(nodeId: string, dataDir?: string): string | null {
  try {
    const v = readFileSync(nodeTokenPath(nodeId, dataDir), 'utf8').trim();
    return v.length >= 32 ? v : null;
  } catch {
    return null;
  }
}

export interface NodeLinksDeps {
  nodes: NodeStore;
  dataDir?: string;
  /** Injected for tests; production builds a real PtydClient. */
  makeClient?: (opts: { controlUrl: string; token: string }) => PaneTransport & {
    on(e: string, f: (...a: never[]) => void): unknown;
    close(): Promise<void>;
  };
  log?: (line: string) => void;
}

type Link = {
  client: NonNullable<ReturnType<NonNullable<NodeLinksDeps['makeClient']>>>;
  connected: boolean;
};

export class NodeLinks {
  private readonly links = new Map<string, Link>();
  private readonly log: (line: string) => void;

  constructor(private readonly deps: NodeLinksDeps) {
    this.log = deps.log ?? ((l) => console.log(l));
  }

  /**
   * Open a link to every configured remote node.
   *
   * Called once at startup, AFTER {@link NodeStore.resetLinkStates}, so no row
   * claims to be `up` on the strength of a socket from a previous process.
   */
  start(): void {
    for (const node of this.deps.nodes.list()) {
      if (node.id === LOCAL_NODE_ID || !node.endpoint) continue;
      this.open(node.id, node.endpoint);
    }
  }

  private open(nodeId: string, endpoint: string): void {
    if (this.links.has(nodeId)) return;
    const token = readNodeTokenFor(nodeId, this.deps.dataDir);
    if (!token) {
      // A configured node with no token is `unauthorized`, NOT `down`: it is a
      // setup step the user has to finish, and rendering it as merely offline
      // hides that there is something to do.
      this.deps.nodes.setState(nodeId, 'unauthorized');
      this.log(`[node] ${nodeId}: no token at ${nodeTokenPath(nodeId, this.deps.dataDir)}`);
      return;
    }
    const controlUrl = `${endpoint.replace(/\/$/, '')}/control`;
    const make =
      this.deps.makeClient ??
      ((o: { controlUrl: string; token: string }) =>
        new PtydClient({
          controlUrl: o.controlUrl,
          headers: { 'x-muxpad-node-token': o.token },
        }));
    const client = make({ controlUrl, token });
    const link: Link = { client, connected: false };
    this.links.set(nodeId, link);

    client.on('connected', (() => {
      link.connected = true;
      this.deps.nodes.setState(nodeId, 'up');
      this.log(`[node] ${nodeId}: up (${controlUrl})`);
    }) as (...a: never[]) => void);
    client.on('disconnected', (() => {
      link.connected = false;
      this.deps.nodes.setState(nodeId, 'down');
      this.log(`[node] ${nodeId}: down`);
    }) as (...a: never[]) => void);
  }

  /**
   * A usable transport for this node, or null.
   *
   * NULL WHILE DISCONNECTED, deliberately — not the client-with-a-dead-socket.
   * Handing back a client that will reject every call turns "unreachable" into
   * a pile of per-call errors at the far end of the stack; returning null lets
   * PaneRouter raise the one error that means what it says.
   */
  get(nodeId: string): PaneTransport | null {
    const link = this.links.get(nodeId);
    if (!link || !link.connected) return null;
    return link.client;
  }

  /** Is this node connected right now? For the Machines view. */
  isUp(nodeId: string): boolean {
    return this.links.get(nodeId)?.connected === true;
  }

  async stop(): Promise<void> {
    for (const [, link] of this.links) await link.client.close().catch(() => {});
    this.links.clear();
  }
}
