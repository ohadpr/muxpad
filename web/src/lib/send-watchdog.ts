/**
 * "IS THIS SOCKET DEAD, OR IS THE SERVER JUST BUSY?"
 *
 * The composer arms a watchdog on every send. Its job is the zombie socket: a
 * connection that reads OPEN while the link underneath it is gone (a phone
 * backgrounded, a network flip), where a send vanishes with no close event for
 * minutes. When it fires, it puts the text back in the composer so the message
 * is not lost.
 *
 * It fired on a healthy socket. Reported as: "typing and sending a message, it
 * gets sent but then remains in the input box" — with the message visibly in
 * the transcript, so the server had it all along. The watchdog had simply
 * waited 6 seconds for an ack and concluded the socket was dead.
 *
 * ── WHY 6 SECONDS STOPPED BEING ENOUGH ──────────────────────────────────────
 * An ack is produced by the server's websocket handler, so it queues behind
 * whatever else that event loop is doing. On a machine running several agent
 * panes the loop is busy, and "the ack took longer than six seconds" became a
 * normal event rather than evidence of anything. The symptom arrived gradually,
 * which is exactly what a threshold that the world grew past looks like.
 *
 * ── THE QUESTION IT SHOULD HAVE ASKED ───────────────────────────────────────
 * A slow ack and a dead socket are only the same observation if you refuse to
 * look any further. So on expiry the composer PINGS, and the pong answers the
 * question directly: a reply means the link is alive and the server is merely
 * slow (keep waiting), silence means it is not (restore the text). The same
 * test the heartbeat sweep already makes, asked on demand instead of every
 * twenty seconds.
 *
 * This module is the decision alone — no timers, no sockets, no React — so the
 * table below can be stated as a test instead of a guess.
 */

export type WatchdogState = {
  /** Has any delivery evidence landed (send-ack, queued, turn-start)? */
  acked: boolean;
  /** Is the socket still in OPEN, as far as the browser is concerned? */
  socketOpen: boolean;
  /** Did a pong arrive AFTER the probe we are judging was sent? */
  pongSinceProbe: boolean;
  /** How many probes have already been answered for this send. */
  probes: number;
};

/**
 * `wait` — do nothing; something already settled this.
 * `probe` — the link looks alive; ping again and keep the text where it is.
 * `restore` — put the text back in the composer; this send is not coming back.
 */
export type WatchdogVerdict = 'wait' | 'probe' | 'restore';

/**
 * HOW LONG THE BENEFIT OF THE DOUBT LASTS.
 *
 * Each answered probe buys another round. Six of them is about half a minute
 * of a demonstrably live socket — past which the ack is not merely late, and
 * something is wrong that waiting will not fix. The cap matters: without one, a
 * server that answers pings while failing to process sends would hold the
 * user's text hostage forever, which is the failure the watchdog exists to
 * prevent.
 */
export const MAX_PROBES = 6;

export function watchdogVerdict(state: WatchdogState): WatchdogVerdict {
  // Evidence of delivery beats every other signal, including a dead socket:
  // the message is on the server, and putting it back in the composer would
  // invite the user to send it twice.
  if (state.acked) return 'wait';
  // A socket the browser has already given up on needs no probe.
  if (!state.socketOpen) return 'restore';
  if (!state.pongSinceProbe) return 'restore';
  return state.probes + 1 >= MAX_PROBES ? 'restore' : 'probe';
}

/**
 * THE COMPOSER AFTER A RESTORE THAT TURNED OUT TO BE WRONG.
 *
 * Even with the probe, a restore can be wrong: the socket dies, the text comes
 * back, and then the ack arrives over the next connection because the server
 * had the message the whole time. Nothing used to undo that — the watchdog's
 * one-way `acked` latch meant a late ack was ignored — so the text sat in the
 * composer next to its own sent copy, which is what makes the bug read as
 * "it sent AND it stayed".
 *
 * Only clears what the watchdog itself put there, and only while it is
 * untouched: anything the user has typed since is theirs, and a composer that
 * empties itself under someone's hands is a worse bug than the one being
 * fixed.
 */
export function composerAfterLateAck(current: string, restored: string | null): string {
  if (!restored) return current;
  return current === restored ? '' : current;
}
