import type { TranscriptTail } from '../chat/TranscriptReader.js';

/**
 * A HOST TAILING ITS OWN CHATS, FOR THE SERVER.
 *
 * ── WHY THE HOST DOES THE READING ─────────────────────────────────────────
 * The server renders a chat from a transcript file. For a pane on another
 * machine that file is HERE. The alternative — the server reading these bytes
 * remotely — founders on `TranscriptTail` resting on two SYNCHRONOUS
 * primitives (`statSync().size` and a byte-range read) with the delicate parts
 * layered above: line-boundary maths on raw bytes, the tail window,
 * `minHistoryLines` growth, paging, and fixes for files rotating under
 * `/compact` or a resume. Making those async infects the poll loop and every
 * failure path.
 *
 * A host runs the same codebase, so it already has that reader and all of
 * those fixes. It tails locally and pushes rendered events; the server relays
 * them into the chat socket it already holds, whose sink is already
 * event-shaped (`onEvents → send({t:'events'})`).
 *
 * ── THE HOST OWNS THE pane→sid MAPPING ───────────────────────────────────
 * The server sends a pane id and nothing else, because it has no session id
 * to send: `agent_sessions.current_sid` is written only by `register`,
 * `/hook` and runner `hello`, all of which travel host→server. For a chat
 * that has only ever run here, the server has never seen the sid. The host
 * resolving its own also means a server-supplied sid is never an input this
 * host has to trust.
 *
 * ── AND IT ANSWERS ONLY FOR CHATS IT IS RUNNING ──────────────────────────
 * `resolveSid` is expected to return null for a pane this host has no runner
 * for. That is the host-side half of the boundary: the server checks the pane
 * belongs to this node, and the host independently refuses a pane it is not
 * running, so neither side alone is load-bearing.
 */

export interface TranscriptSubscriptionDeps {
  /** This host's pane→sid answer, or null when it is not running that pane. */
  resolveSid: (paneId: string) => { sid: string; assistant: string } | null;
  /** Build a tail. Injected so this module needs no filesystem in tests. */
  makeTail: (
    sid: string,
    assistant: string,
    sink: {
      onEvents: (events: unknown[], phase: string) => void;
      onTitle: (title: string) => void;
    },
    tailBytes?: number,
  ) => Pick<TranscriptTail, 'start' | 'close' | 'loadOlder'>;
  /** Push a frame to the server over the control socket. */
  push: (e: Record<string, unknown>) => void;
}

export class TranscriptSubscriptions {
  private readonly tails = new Map<string, Pick<TranscriptTail, 'start' | 'close' | 'loadOlder'>>();

  constructor(private readonly deps: TranscriptSubscriptionDeps) {}

  /**
   * Begin tailing `paneId`. Returns the sid so the server can record what it
   * is watching, or null when this host will not answer for the pane.
   *
   * IDEMPOTENT. A browser reopening a chat, or the control socket reconnecting
   * and the server re-subscribing, must not stack two tails on one file — that
   * would double every event into the chat.
   */
  subscribe(paneId: string, tailBytes?: number): string | null {
    const found = this.deps.resolveSid(paneId);
    if (!found) {
      // Said explicitly rather than pushed as "no events": the server renders
      // a reason instead of an empty chat that looks broken.
      this.deps.push({
        event: 'transcriptUnavailable',
        id: paneId,
        reason: 'this machine is not running that chat',
      });
      return null;
    }
    this.unsubscribe(paneId);
    const tail = this.deps.makeTail(
      found.sid,
      found.assistant,
      {
        onEvents: (events, phase) =>
          this.deps.push({ event: 'transcriptEvents', id: paneId, phase, events }),
        onTitle: (title) => this.deps.push({ event: 'transcriptTitle', id: paneId, title }),
      },
      tailBytes,
    );
    this.tails.set(paneId, tail);
    tail.start();
    return found.sid;
  }

  /**
   * Stop tailing.
   *
   * Called when the last browser viewing the chat goes away. Without it a
   * closed tab leaves this host polling a file forever, and a machine running
   * many chats would accumulate one timer per chat ever opened.
   */
  unsubscribe(paneId: string): void {
    const tail = this.tails.get(paneId);
    if (!tail) return;
    tail.close();
    this.tails.delete(paneId);
  }

  /** One page of older history. The host owns the cursor — the tail does. */
  loadOlder(paneId: string): void {
    this.tails.get(paneId)?.loadOlder();
  }

  /**
   * Drop everything.
   *
   * On control-socket close: the subscriptions belonged to a server that is no
   * longer listening, and their pushes would go nowhere. The server
   * re-subscribes for whatever is still being viewed when it reconnects, which
   * is also why `subscribe` has to be idempotent.
   */
  closeAll(): void {
    for (const [, tail] of this.tails) tail.close();
    this.tails.clear();
  }

  /** For assertions and for a health line. */
  count(): number {
    return this.tails.size;
  }
}
