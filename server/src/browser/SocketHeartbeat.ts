/**
 * One round of "is anyone still actually there?" over a set of sockets.
 *
 * Pulled out of the host for the reason `IdleStop` was pulled out of the sweep:
 * the timer and the ws server around it are plumbing, and this is the part that
 * can be wrong. Testable without a Chrome, a port or a real socket.
 *
 * ─── THE BUG IT EXISTS FOR ──────────────────────────────────────────────────
 * The host tracks its clients in two Sets that shrink on exactly one event: the
 * socket's `'close'`. A WebSocket severed ABRUPTLY — the agent's runner killed,
 * a pane respawned under it, a viewer tab crashed, a tailnet blip — does not
 * fire `'close'` until the OS gives up on the connection. That is minutes at
 * best and, observed here, never.
 *
 * Untidy anywhere; load-bearing in this one place, because `agentSockets.size`
 * is what the host reports at `/idle`, and the server's idle-stop refuses to
 * stop a browser that has any client attached. So ONE ghost socket pins a
 * Chrome for good: it reads as busy at every sweep, is never stopped, and
 * therefore never restarts into a state where it could be. Measured on this
 * install: 84 processes across 6 profiles, the oldest four days old, macOS
 * refusing further allocations — while the server log showed the idle sweep
 * working perfectly on every session whose socket had closed cleanly.
 *
 * ─── WHY TERMINATE AND NOT DELETE ───────────────────────────────────────────
 * This never touches the host's Sets. `terminate()` fires `'close'`, and the
 * host's existing close handlers do the removal and the bookkeeping they
 * already did — so there is no second opinion about who is attached, which is
 * the defect that would replace the one being fixed.
 */

/** The slice of a ws socket this needs. Both real sockets and fakes satisfy it. */
export interface HeartbeatSocket {
  /** Set false before each ping; a `pong` sets it back. Absent on a brand-new
   *  socket, which must never be terminated on its first round — see below. */
  isAlive?: boolean | undefined;
  ping(): void;
  terminate(): void;
}

/**
 * Ping everyone; terminate anyone who ignored the previous round.
 *
 * Returns the number terminated, for the caller's log and for the tests.
 *
 * A socket with `isAlive === undefined` is one that has never been through a
 * round — it is pinged and left alone. Only an explicit `false`, written by the
 * previous round and not cleared by a pong, is evidence of death. Treating
 * "unknown" as dead would cut off every client in its first 30 seconds, which
 * is the opposite failure and a much louder one.
 */
export function heartbeatRound(sockets: Iterable<HeartbeatSocket>): number {
  let terminated = 0;
  // Snapshot first: `terminate()` can fire 'close' synchronously, and the
  // caller's live Set is usually the thing being iterated.
  for (const socket of [...sockets]) {
    if (socket.isAlive === false) {
      socket.terminate();
      terminated++;
      continue;
    }
    socket.isAlive = false;
    try {
      socket.ping();
    } catch {
      // Already closing. Its 'close' handler cleans up either way, and throwing
      // out of a heartbeat would take down the interval for every other socket.
    }
  }
  return terminated;
}
