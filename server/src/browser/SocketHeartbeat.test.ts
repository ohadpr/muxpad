import { describe, expect, it } from 'vitest';
import { type HeartbeatSocket, heartbeatRound } from './SocketHeartbeat.js';

/**
 * THE 64 GB TEST. A ghost CDP socket made `/idle` report "someone is attached"
 * forever, so the idle-stop never stopped that browser, so it never restarted —
 * 84 Chrome processes, the oldest four days old, and macOS out of application
 * memory. Everything below is about the two ways this can be wrong: leaving a
 * ghost (the bug) and cutting off somebody real (the overcorrection).
 */
function fake(over: Partial<HeartbeatSocket> = {}) {
  const s = {
    isAlive: undefined as boolean | undefined,
    pings: 0,
    terminated: 0,
    ping() {
      s.pings++;
    },
    terminate() {
      s.terminated++;
    },
    ...over,
  };
  return s;
}

describe('the host socket heartbeat', () => {
  it('pings a live socket and leaves it alone', () => {
    const s = fake({ isAlive: true });
    expect(heartbeatRound([s])).toBe(0);
    expect(s.pings).toBe(1);
    expect(s.terminated).toBe(0);
    // …and it is now awaiting a pong.
    expect(s.isAlive).toBe(false);
  });

  it('TERMINATES one that ignored the previous round — the ghost', () => {
    const s = fake({ isAlive: false });
    expect(heartbeatRound([s])).toBe(1);
    expect(s.terminated).toBe(1);
    expect(s.pings).toBe(0);
  });

  it('never terminates a socket on its FIRST round', () => {
    // `undefined` means "has not been through a round yet", not "dead".
    // Reading it as dead would cut off every client within 30 seconds of
    // connecting — the opposite failure, and a far louder one.
    const s = fake();
    expect(heartbeatRound([s])).toBe(0);
    expect(s.terminated).toBe(0);
    expect(s.pings).toBe(1);
  });

  it('a socket that pongs survives indefinitely', () => {
    const s = fake({ isAlive: true });
    for (let i = 0; i < 100; i++) {
      heartbeatRound([s]);
      s.isAlive = true; // the pong handler, in the host
    }
    expect(s.terminated).toBe(0);
  });

  it('a socket that never pongs dies on the SECOND round, not the first', () => {
    // The actual ghost lifecycle: connect, go away without a FIN, get pinged
    // once, fail to answer, get terminated. ~60s at a 30s interval.
    const s = fake({ isAlive: true });
    expect(heartbeatRound([s])).toBe(0);
    expect(heartbeatRound([s])).toBe(1);
    expect(s.terminated).toBe(1);
  });

  it('one throwing socket does not stop the rest being swept', () => {
    // A throw out of the heartbeat would take the interval down for every
    // other socket — turning a one-socket problem back into the all-sockets
    // problem this fixes.
    const bad = fake({
      isAlive: true,
      ping() {
        throw new Error('already closing');
      },
    });
    const ghost = fake({ isAlive: false });
    const good = fake({ isAlive: true });
    expect(() => heartbeatRound([bad, ghost, good])).not.toThrow();
    expect(ghost.terminated).toBe(1);
    expect(good.pings).toBe(1);
  });

  it('survives a set that mutates while it is being swept', () => {
    // `terminate()` fires 'close' and the host's handler deletes from the very
    // Set being iterated. Without the snapshot this is a skipped element.
    const ghostA = fake({ isAlive: false });
    const ghostB = fake({ isAlive: false });
    const live = new Set<HeartbeatSocket>([ghostA, ghostB]);
    ghostA.terminate = () => {
      ghostA.terminated++;
      live.delete(ghostA);
    };
    ghostB.terminate = () => {
      ghostB.terminated++;
      live.delete(ghostB);
    };
    expect(heartbeatRound(live)).toBe(2);
    expect(ghostA.terminated).toBe(1);
    expect(ghostB.terminated).toBe(1);
  });

  it('an empty set is a no-op', () => {
    expect(heartbeatRound([])).toBe(0);
  });
});
