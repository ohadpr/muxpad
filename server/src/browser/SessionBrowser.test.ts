import { describe, expect, it } from 'vitest';
import { sessionBrowserProfile } from './SessionBrowser.js';

/**
 * Which browser belongs to which agent session.
 *
 * THE HOLE THIS CLOSES. Agents were running their own isolated browsers while
 * the viewer showed muxpad's — so an agent stuck at a login wall asked a person
 * to sign in somewhere it could not see. The cookie reached the NEXT agent via
 * the jar and never the one that was waiting. The handoff looked like it worked
 * and did not.
 *
 * So the agent's browser has to be one muxpad owns and can show. One per
 * session, named after the session, seeded from the shared jar.
 */

describe('naming a session browser', () => {
  it('is derived from the tab, so a session always finds its own', () => {
    expect(sessionBrowserProfile({ MUXPAD_TAB_ID: '01M3GBWZYC2TPN6F3YZ3RMNK12' })).toBe(
      's-01m3gbwzyc2tpn6f3yz3rmnk12',
    );
  });

  it('is stable across calls, so a restarted runner reattaches', () => {
    const env = { MUXPAD_TAB_ID: 'abc' };
    expect(sessionBrowserProfile(env)).toBe(sessionBrowserProfile(env));
  });

  it('falls back to the pane when there is no tab', () => {
    expect(sessionBrowserProfile({ MUXPAD_PANE_ID: 'pane1' })).toBe('s-pane1');
  });

  it('is null outside muxpad, rather than inventing a shared name', () => {
    // A process with no session identity must NOT land on some default browser
    // shared with everybody — that is the page-clobbering bug, rebuilt.
    expect(sessionBrowserProfile({})).toBeNull();
  });

  it('REFUSES a session id that is not a legal name, rather than sanitizing it', () => {
    // Null, not a scrubbed lookalike. Everything else in this subsystem rejects
    // separators rather than quietly rewriting them, and a session whose id
    // cannot be a profile name should fail visibly rather than share a browser
    // with whatever `../../etc` happens to normalize to.
    expect(sessionBrowserProfile({ MUXPAD_TAB_ID: '../../etc' })).toBeNull();
    expect(sessionBrowserProfile({ MUXPAD_TAB_ID: '!!!' })).toBeNull();
  });
});
