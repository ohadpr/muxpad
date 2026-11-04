import { LOCAL_NODE_ID, type NodeStore } from '../store/NodeStore.js';
import { HostLink } from './HostLink.js';
import { readNodeTokenFor } from './NodeLinks.js';

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
    for (const node of this.deps.nodes.list()) {
      if (node.id === LOCAL_NODE_ID || !node.endpoint) continue;
      const token = readNodeTokenFor(node.id, this.deps.dataDir);
      if (!token) continue; // NodeLinks already marks this `unauthorized`
      this.links.set(
        node.id,
        new HostLink({
          nodeId: node.id,
          endpoint: node.endpoint,
          token,
          selfUrl: this.deps.selfUrl,
          apiKey: this.deps.apiKey(),
          onTranscript: (m) => {
            for (const sink of this.sinks.get(m.paneId) ?? []) sink(m);
          },
          ...(this.deps.log ? { log: this.deps.log } : {}),
        }),
      );
    }
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

  stop(): void {
    for (const [, l] of this.links) l.close();
    this.links.clear();
    this.sinks.clear();
  }
}
