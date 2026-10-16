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
  /**
   * How long to wait for a reply before giving up on it. See {@link sendOn}.
   * Injected mainly so tests do not have to wait it out.
   */
  callTimeoutMs?: number;
  /** Injected for tests; defaults to the global timers. */
  timers?: CdpTimers;
}

/**
 * A REPLY THAT NEVER COMES MUST NOT BE WAITED FOR FOREVER.
 *
 * Generous, because a real CDP call on a busy page can genuinely take seconds —
 * this is the "something is wrong" threshold, not a performance budget.
 */
export const CDP_CALL_TIMEOUT_MS = 30_000;

/** Just enough of the timer API to be swapped out in a test. */
interface CdpTimers {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: never) => void;
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
    // A DEAD SOCKET USED TO BE INVISIBLE. The handlers above are the handshake's;
    // once it resolved, nothing watched the socket again. So a browser that went
    // away left `this.socket` non-null and every later call parked on a reply
    // that could never arrive: no error, no log, no recovery. The host then hung
    // in its own shutdown before it reached `chrome.kill()`, which is how
    // nineteen orphaned Chromes came to be squatting one debugging port.
    socket.onclose = () => this.fail('closed', new Error('CDP connection closed'));
    socket.onerror = () => this.fail('socket', new Error('CDP socket error'));
    this.socket = socket;
  }

  /** Gives up on every call in flight, and on the socket. */
  private fail(where: string, err: Error): void {
    if (!this.socket && this.pending.size === 0) return;
    this.socket = null;
    const waiting = [...this.pending.values()];
    this.pending.clear();
    for (const { reject } of waiting) reject(err);
    this.opts.onError?.(where, err);
  }

  /**
   * Attaches a flat session to an explicit handoff target, or the first real page.
   *
   * `devtools://` targets are skipped: an open DevTools window is itself a page
   * target, and attaching to it would stream a picture of the debugger.
   */
  async attachToPage(targetId?: string): Promise<PageTarget> {
    const targets = await this.listTargets();
    const page = targetId
      ? targets.find(
          (t) => t.targetId === targetId && t.type === 'page' && !t.url.startsWith('devtools://'),
        )
      : targetToAttach(null, targets);
    if (!page) throw new Error(`no page target at ${this.opts.endpoint}`);
    if (page.targetId !== this.attachedTargetId) await this.attachTo(page.targetId);
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

  async listTargets(): Promise<TargetInfo[]> {
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
    const previous = this.sessionId;
    this.sessionId = attached.sessionId;
    this.attachedTargetId = targetId;
    if (previous)
      void this.sendOn(null, 'Target.detachFromTarget', { sessionId: previous }).catch(() => {});
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
    const socket = this.socket;
    this.socket = null;
    const waiting = [...this.pending.values()];
    this.pending.clear();
    for (const { reject } of waiting) reject(new Error('CDP connection closed'));
    socket?.close();
  }

  private sendOn(
    sessionId: string | null,
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const socket = this.socket;
    if (!socket) return Promise.reject(new Error('CDP not connected'));
    const id = this.nextId++;
    const timers: CdpTimers = this.opts.timers ?? {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (handle) => clearTimeout(handle as unknown as ReturnType<typeof setTimeout>),
    };
    const limit = this.opts.callTimeoutMs ?? CDP_CALL_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      // THE METHOD NAME IS IN THE MESSAGE on purpose: a bare timeout in a log is
      // unattributable, and which call hung is the whole diagnosis.
      const timer = timers.setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new Error(`CDP ${method} did not answer within ${limit}ms`));
      }, limit);
      const settle = (fn: (v: never) => void) => (v: never) => {
        timers.clearTimeout(timer as never);
        fn(v);
      };
      this.pending.set(id, {
        resolve: settle(resolve as (v: never) => void) as Pending['resolve'],
        reject: settle(reject as (v: never) => void) as Pending['reject'],
      });
      socket.send(
        JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }),
      );
    });
  }

  private dispatch(raw: string) {
    let message: {
      id?: number;
      method?: string;
      sessionId?: string;
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

    if (message.sessionId && message.sessionId !== this.sessionId) return;
    if (message.method) {
      for (const handler of this.handlers.get(message.method) ?? []) {
        (handler as (p: unknown) => void)(message.params);
      }
    }
  }
}
