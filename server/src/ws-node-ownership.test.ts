import { describe, expect, it } from 'vitest';
import { nodeOwnershipOk } from './ws.js';

/**
 * ── A SOCKET MAY ONLY ACT FOR ITS OWN MACHINE ────────────────────────────
 *
 * `/ws/agent-runner/:paneId` and `/ws/pane/:id` identify a pane by ID alone,
 * and the runner arm lets the NEWEST connection displace the previous one.
 * The plan review found the consequence: once frames can arrive from another
 * machine, a compromised node could name any pane id, terminate a LOCAL
 * runner and impersonate it — reading what the user types and answering in
 * its place.
 *
 * The header carrying the claim is stamped by OUR mac-side relay at upgrade
 * time, never by the remote peer, and a local runner sends none at all — so
 * absent means `local`.
 */
describe('node ownership', () => {
  it('local socket may act on a local pane', () => {
    expect(nodeOwnershipOk('local', 'local')).toBe(true);
  });

  it('a pane row with NO node reads as local — the pre-migration meaning', () => {
    expect(nodeOwnershipOk(null, 'local')).toBe(true);
  });

  it('a node may act on its own panes', () => {
    expect(nodeOwnershipOk('trayo', 'trayo')).toBe(true);
  });

  it('A NODE MAY NOT TOUCH ANOTHER MACHINE’S PANE — the whole point', () => {
    // This is the impersonation the review described.
    expect(nodeOwnershipOk('local', 'trayo')).toBe(false);
    expect(nodeOwnershipOk('trayo', 'other-node')).toBe(false);
  });

  it('…and a LOCAL socket may not touch a remote pane either', () => {
    // The symmetric case, which is just as wrong: serving a remote pane's
    // bytes out of this machine's ptyd would attach to the wrong pty.
    expect(nodeOwnershipOk('trayo', 'local')).toBe(false);
    expect(nodeOwnershipOk('trayo', null as unknown as string)).toBe(false);
  });

  it('is an exact match, not a prefix or a substring', () => {
    expect(nodeOwnershipOk('trayo', 'tray')).toBe(false);
    expect(nodeOwnershipOk('trayo', 'trayo-2')).toBe(false);
    expect(nodeOwnershipOk('trayo', 'TRAYO')).toBe(false);
  });
});
