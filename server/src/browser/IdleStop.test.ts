import { describe, expect, it } from 'vitest';
import { type IdleStopInput, shouldStopIdleBrowser } from './IdleStop.js';

const base: IdleStopInput = {
  report: { agents: 0, viewers: 0, idleMs: 60 * 60_000 },
  running: true,
  agentMayDrive: true,
  idleThresholdMs: 20 * 60_000,
};
const at = (over: Partial<IdleStopInput>) => shouldStopIdleBrowser({ ...base, ...over });

describe('stopping a browser nobody is using', () => {
  it('stops one idle past the threshold with nobody attached', () => {
    expect(at({})).toBe(true);
  });

  it('leaves one whose socket is quiet but ATTACHED — the case that must not break', () => {
    // Agent traffic rides ONE long-lived CDP socket, so a browser being driven
    // hard sends no new requests for minutes. Any server-side "last request"
    // timestamp would call this idle and pull Chrome out from under a running
    // agent mid-task. The host reports the socket instead.
    expect(at({ report: { agents: 1, viewers: 0, idleMs: 0 } })).toBe(false);
    // …and still not, even if the host's own clock says otherwise.
    expect(at({ report: { agents: 1, viewers: 0, idleMs: 99 * 60_000 } })).toBe(false);
  });

  it('leaves one with a viewer watching it', () => {
    expect(at({ report: { agents: 0, viewers: 1, idleMs: 99 * 60_000 } })).toBe(false);
  });

  it('leaves one a HUMAN holds the wheel on, however idle it looks', () => {
    // Between taps on a login form there is no socket and no request. This is
    // the worst possible moment to stop a browser, and the only signal that
    // covers it is the wheel.
    expect(at({ agentMayDrive: false })).toBe(false);
  });

  it('leaves one it could not reach — a failed read is not evidence', () => {
    expect(at({ report: null })).toBe(false);
  });

  it('leaves one not running', () => {
    expect(at({ running: false })).toBe(false);
  });

  it('waits for the full threshold', () => {
    expect(at({ report: { agents: 0, viewers: 0, idleMs: 20 * 60_000 - 1 } })).toBe(false);
    expect(at({ report: { agents: 0, viewers: 0, idleMs: 20 * 60_000 } })).toBe(true);
  });
});
