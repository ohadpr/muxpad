import { type TargetInfo, targetToAttach } from './PageAttachment.js';
import type { CdpTransport } from './ScreencastSession.js';

/**
 * A CDP connection to a browser muxpad owns.
 *
 * THE ONE DESIGN DECISION: ATTACH AT THE *BROWSER* ENDPOINT
 * ---------------------------------------------------------
 * Chrome exposes two kinds of debugging socket, and picking the wrong one
 * quietly makes this feature mutually exclusive with everything else:
 *
 *   · `/devtools/page/<id>` — the per-page socket. Accepts EXACTLY ONE client.
 *     Hold it and nothing else can attach to that page, including DevTools.
 *   · `/devtools/browser/<id>` — the browser socket. Multiplexes flat sessions
 *     via `Target.attachToTarget`, and is how Playwright's `connectOverCDP`
 *     coexists with other tools.
 *
 * The first version of the spike used the page socket and appeared to work
 * perfectly, because nothing else happened to be attached. It was tested by
 * loading DevTools against the same page, which refused to connect.
 *
 * This matters far beyond tidiness. The whole point of a muxpad-owned browser
 * is that the AGENT drives it over the Playwright MCP (`--cdp-endpoint`) while
 * the HUMAN watches and takes over through the screencast. Those are two
 * clients on one browser by definition. On the page socket, the second one to
 * arrive simply loses.
 *
 * Verified: two screencast relays plus the DevTools frontend plus playwright-mcp
 * attached to one browser simultaneously, with the agent reading back the exact
 * scroll position the human had just scrolled to.
 */

interface Pending {
  resolve: (v: Record<string, unknown>) => void;
  reject: (e: Error) => void;
}

/** The page target we drive, as CDP describes it. */
export interface PageTarget {
  targetId: string;
  url: string;
}

export interface CdpConnectionOptions {
  /** Base HTTP URL of the debugging port, e.g. `http://127.0.0.1:9410`. */
  endpoint: string;
  /** Injected for tests; defaults to the global. */
  fetchImpl?: typeof fetch;
  /** Injected for tests; defaults to the global WebSocket. */
  socketImpl?: typeof WebSocket;
  onError?: (where: string, err: Error) => void;
}

export class CdpConnection implements CdpTransport {
  private socket: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  /**
   * MANY handlers per event, not one.
   *
   * A Map<event, handler> looks fine until a second subscriber for the same
   * event silently REPLACES the first. The concrete near-miss: ScreencastSession
   * listens for Page.frameNavigated to re-arm the stream, and the host wants the
   * same event to track the current URL — with one slot, adding the second
   * listener would have quietly disabled re-arming, and the only symptom is a
   * frozen picture after a navigation, which is the exact bug the re-arm exists
   * to fix.
   */
  private readonly handlers = new Map<string, Array<(params: never) => void>>();
  /** Flat session for the page we attached to. Null until {@link attachToPage}. */
  private sessionId: string | null = null;
  private attachedTargetId: string | null = null;

  constructor(private readonly opts: CdpConnectionOptions) {}

  /** Opens the BROWSER-level socket. See the module comment for why. */
  async connect(): Promise<void> {
    const doFetch = this.opts.fetchImpl ?? fetch;
    const version = (await (await doFetch(`${this.opts.endpoint}/json/version`)).json()) as {
      webSocketDebuggerUrl: string;
    };
    const Socket = this.opts.socketImpl ?? WebSocket;
    const socket = new Socket(version.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error(`cannot reach CDP at ${this.opts.endpoint}`));
    });
    socket.onmessage = (event: MessageEvent) => this.dispatch(String(event.data));
    this.socket = socket;
  }

  /**
   * Attaches a flat session to the first real page target.
   *
   * `devtools://` targets are skipped: an open DevTools window is itself a page
   * target, and attaching to it would stream a picture of the debugger.
   */
  async attachToPage(): Promise<PageTarget> {
    const page = targetToAttach(null, await this.listTargets());
    if (!page) throw new Error(`no page target at ${this.opts.endpoint}`);
    await this.attachTo(page.targetId);
    return { targetId: page.targetId, url: page.url };
  }

  /**
   * Re-attaches if the page we were holding has gone, and says whether it did.
   *
   * Chrome can move a page into a NEW target — navigating away from
   * `chrome://newtab` does it, which is the first navigation of every session.
   * The old session then survives as a handle to nothing: no error is raised,
   * input goes nowhere, the screencast refuses, and the viewer is black for
   * good. So the host asks, rather than assuming.
   *
   * Returns false when nothing changed, which is the common case and must stay
   * cheap — re-attaching needlessly drops every enabled domain for a blink.
   */
  async reattachIfLost(): Promise<PageTarget | null> {
    const page = targetToAttach(this.attachedTargetId, await this.listTargets());
    if (!page) return null;
    await this.attachTo(page.targetId);
    return { targetId: page.targetId, url: page.url };
  }

  private async listTargets(): Promise<TargetInfo[]> {
    const { targetInfos } = (await this.sendOn(null, 'Target.getTargets')) as unknown as {
      targetInfos: TargetInfo[];
    };
    return targetInfos ?? [];
  }

  private async attachTo(targetId: string): Promise<void> {
    const attached = (await this.sendOn(null, 'Target.attachToTarget', {
      targetId,
      flatten: true,
    })) as unknown as { sessionId: string };
    this.sessionId = attached.sessionId;
    this.attachedTargetId = targetId;
  }

  /** Sends to the attached page session. */
  send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return this.sendOn(this.sessionId, method, params);
  }

  on(event: string, handler: (params: never) => void): void {
    const existing = this.handlers.get(event);
    if (existing) existing.push(handler);
    else this.handlers.set(event, [handler]);
  }

  close(): void {
    this.socket?.close();
    this.socket = null;
    for (const { reject } of this.pending.values()) reject(new Error('CDP connection closed'));
    this.pending.clear();
  }

  private sendOn(
    sessionId: string | null,
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const socket = this.socket;
    if (!socket) return Promise.reject(new Error('CDP not connected'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      socket.send(
        JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }),
      );
    });
  }

  private dispatch(raw: string) {
    let message: {
      id?: number;
      method?: string;
      params?: unknown;
      result?: Record<string, unknown>;
      error?: { message: string };
    };
    try {
      message = JSON.parse(raw);
    } catch (err) {
      this.opts.onError?.('parse', err instanceof Error ? err : new Error(String(err)));
      return;
    }

    if (message.id !== undefined) {
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      // The method name is carried in the rejection: a bare "Screencast is
      // already active" in a log is unattributable, and that particular error
      // is load-bearing (see ScreencastSession).
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result ?? {});
      return;
    }

    if (message.method) {
      for (const handler of this.handlers.get(message.method) ?? []) {
        (handler as (p: unknown) => void)(message.params);
      }
    }
  }
}
