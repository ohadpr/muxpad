import { normalizeProfileName } from './BrowserProfile.js';

/**
 * Which browser belongs to which agent session.
 *
 * THE HOLE THIS CLOSES. Agents ran their own isolated browsers while the viewer
 * showed muxpad's, so an agent stuck at a login wall asked a person to sign in
 * somewhere it could not see. Observed in real use: "sign in once at
 * ultalabtests.com and hand it back" — on a browser that was not the one it was
 * stuck in. The cookie reached the NEXT agent through the jar and never the one
 * that was waiting, so the handoff looked like it worked and did not.
 *
 * So an agent's browser has to be one muxpad owns and can show: one per session,
 * named after the session, seeded from the shared jar at launch.
 */

/** Prefix that marks a profile as belonging to one session rather than a person. */
export const SESSION_PROFILE_PREFIX = 's-';

/**
 * The profile name for this session's browser, or null outside muxpad.
 *
 * NULL rather than a default is the important part. A process with no session
 * identity landing on a shared browser is precisely the page-clobbering bug
 * that made this necessary, rebuilt with a friendlier name.
 */
export function sessionBrowserProfile(env: NodeJS.ProcessEnv): string | null {
  const id = env.MUXPAD_TAB_ID || env.MUXPAD_PANE_ID;
  if (!id) return null;
  try {
    // Normalize the ID ON ITS OWN, before the prefix. Prefixing first hides a
    // junk id inside a legal-looking name: `s-!!!` normalizes to plain `s`, and
    // every session with an unusable id would quietly share one browser — the
    // page-clobbering bug again, wearing the prefix as a disguise.
    return `${SESSION_PROFILE_PREFIX}${normalizeProfileName(id)}`;
  } catch {
    return null;
  }
}
