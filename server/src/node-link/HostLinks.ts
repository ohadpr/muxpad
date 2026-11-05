import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LOCAL_NODE_ID, type NodeStore } from '../store/NodeStore.js';
import { HostLink } from './HostLink.js';
import { readNodeTokenFor } from './NodeLinks.js';
import type { HostApi } from './host-api.js';

/**
 * ONE {@link HostLink} PER REMOTE HOST, plus the fan-out the chat socket needs.
 *
 * Separate from `NodeLinks` on purpose: that one owns the `/control` dial used
 * for pane operations and is already load-bearing. This owns the `/link` dial,
 * which carries the host→server traffic (runner frames, chat history) that
 * nothing else can.
 *
 * ── SUBSCRIBERS ARE PER PANE AND REFERENCE-COUNTED ───────────────────────
 * Two browsers on the same remote chat must not make the host tail it twice,
 * and the last one leaving must stop it — otherwise a machine accumulates a
 * poller per chat ever opened. The host's own subscribe is idempotent as a
 * second line of defence, but the count is what makes the UNSUBSCRIBE correct,
 * and that is the half that leaks.
 */

type Sink = (m: {
  paneId: string;
  kind: 'events' | 'title' | 'unavailable';
  phase?: string;
  events?: unknown[];
  title?: string;
  reason?: string;
}) => void;

export interface HostLinksDeps {
  nodes: NodeStore;
  selfUrl: string;
  apiKey: () => string | null;
  /**
   * The scoped allowlist that answers in-pane CLI calls.
   *
   * Optional, and absent means a host's `api` requests are all refused — the
   * safe default, and the one every test that does not care gets.
   */
  hostApi?: HostApi;
  dataDir?: string;
  log?: (line: string) => void;
}

export class HostLinks {
  private readonly links = new Map<string, HostLink>();
  /** paneId → the chat sockets currently rendering it. */
  private readonly sinks = new Map<string, Set<Sink>>();

  constructor(private readonly deps: HostLinksDeps) {}

  /** Open a link to every configured remote host. */
  start(): void {
    this.sync();
  }

  /**
   * Make the links match the nodes table — see NodeLinks.sync for why this
   * exists rather than a restart.
   *
   * A node whose endpoint changed, or whose token was re-minted, is closed and
   * redialled: a link holds its credential from the dial, so a rotated token
   * only takes effect on a new one.
   */
  sync(): void {
    const rows = this.deps.nodes.list().filter((n) => n.id !== LOCAL_NODE_ID && n.endpoint);
    const wanted = new Map<string, { endpoint: string; token: string }>();
    for (const n of rows) {
      const token = readNodeTokenFor(n.id, this.deps.dataDir);
      if (!token) continue; // NodeLinks already marks this `unauthorized`
      wanted.set(n.id, { endpoint: n.endpoint as string, token });
    }
    for (const [id, link] of [...this.links]) {
      const want = wanted.get(id);
      const dialled = link.dialledAt;
      if (want && want.endpoint === dialled.endpoint && want.token === dialled.token) continue;
      link.close();
      this.links.delete(id);
    }
    for (const [id, want] of wanted) {
      if (this.links.has(id)) continue;
      this.openLink(id, want.endpoint, want.token);
    }
  }

  private openLink(nodeId: string, endpoint: string, token: string): void {
    this.links.set(
      nodeId,
      new HostLink({
        nodeId,
        endpoint,
        token,
        selfUrl: this.deps.selfUrl,
        apiKey: this.deps.apiKey,
        onTranscript: (m) => {
          for (const sink of this.sinks.get(m.paneId) ?? []) sink(m);
        },
        // The principal is bound HERE, to the node this server dialled, and
        // the handler cannot be told otherwise — a host names a path, never
        // whose authority to use.
        ...(this.deps.hostApi
          ? {
              onApiRequest: (m) =>
                (this.deps.hostApi as HostApi).handle(nodeId, m.method, m.path, m.body),
            }
          : {}),
        ...(this.deps.log ? { log: this.deps.log } : {}),
      }),
    );
  }

  /** The link that owns this pane, or null when it is local or unreachable. */
  private linkForPane(paneId: string): HostLink | null {
    const nodeId = this.deps.nodes.nodeForPane(paneId);
    if (nodeId === LOCAL_NODE_ID) return null;
    return this.links.get(nodeId) ?? null;
  }

  /**
   * Render this remote chat into `sink` until {@link unwatch}.
   *
   * Returns false when there is no link — the caller then says so rather than
   * showing an empty chat, which is the distinction the `unavailable` message
   * exists for.
   */
  watch(paneId: string, sink: Sink, tailBytes?: number): boolean {
    const link = this.linkForPane(paneId);
    if (!link) return false;
    let set = this.sinks.get(paneId);
    if (!set) {
      set = new Set();
      this.sinks.set(paneId, set);
    }
    const first = set.size === 0;
    set.add(sink);
    // Subscribe on the FIRST watcher only. A second browser joins the existing
    // tail; asking again would be harmless (the host is idempotent) but would
    // also re-send the whole history to everyone.
    if (first) link.subscribeTranscript(paneId, tailBytes);
    return true;
  }

  unwatch(paneId: string, sink: Sink): void {
    const set = this.sinks.get(paneId);
    if (!set) return;
    set.delete(sink);
    if (set.size > 0) return;
    this.sinks.delete(paneId);
    // Last watcher gone: stop the host tailing a chat nobody is looking at.
    this.linkForPane(paneId)?.unsubscribeTranscript(paneId);
  }

  loadOlder(paneId: string): void {
    this.linkForPane(paneId)?.loadOlderTranscript(paneId);
  }

  /** Is this pane's host reachable right now? For the "not available" notice. */
  isUp(paneId: string): boolean {
    return this.linkForPane(paneId)?.up === true;
  }

  /**
   * Ask EVERY connected host to search its own archive, in parallel.
   *
   * This is the one deliberately cross-host surface, and it is a SERVER
   * capability: the user looking at a search box gets everything, while the
   * in-pane `muxpad search` on any machine still sees only that machine. The
   * two are different paths with different authorisation, which is the whole
   * content of the host-scoping rule.
   *
   * Every host appears in the result, including the ones that failed — a
   * machine that was asleep must not be indistinguishable from a machine with
   * nothing in it.
   */
  async searchHosts(
    q: string,
    opts: { limit: number; role?: string },
  ): Promise<
    Array<{
      nodeId: string;
      name: string;
      hits: unknown[];
      fallback: boolean;
      error?: string;
    }>
  > {
    const entries = [...this.links.entries()];
    return Promise.all(
      entries.map(async ([nodeId, link]) => {
        const name = this.deps.nodes.get(nodeId)?.name ?? nodeId;
        const r = await link.search(q, opts);
        return 'error' in r
          ? { nodeId, name, hits: [], fallback: false, error: r.error }
          : { nodeId, name, hits: r.hits, fallback: r.fallback };
      }),
    );
  }

  /**
   * Pull a path off a host into a fresh staging dir, for `muxpad publish`.
   *
   * One directory per transfer, named with randomness and created under the
   * data dir: a host that somehow escaped the per-file path check would land
   * somewhere nothing serves, and two publishes at once cannot see each
   * other's files.
   */
  async fetchFromHost(
    nodeId: string,
    path: string,
  ): Promise<{ path: string; dispose: () => void } | { error: string }> {
    const link = this.links.get(nodeId);
    if (!link) return { error: 'that machine is not connected' };
    const root = join(
      this.deps.dataDir ?? tmpdir(),
      'host-staging',
      `${nodeId}-${randomBytes(8).toString('hex')}`,
    );
    return link.fetchPath(path, root);
  }

  stop(): void {
    for (const [, l] of this.links) l.close();
    this.links.clear();
    this.sinks.clear();
  }
}
