import { SUMMONS_HOLD_MS } from '@muxpad/shared';
import type Database from 'better-sqlite3';
import { listBrowserApps } from './BrowserApps.js';
import { BrowserEvents } from './BrowserEvents.js';
import { BrowserOwner } from './BrowserOwner.js';
import { agentPaneForTab, outstandingSummons } from './ResumeAfterHandback.js';

/**
 * Which chats are parked on a person at their browser.
 *
 * THE STATE THAT WAS MISSING. An agent that summoned somebody ended its turn —
 * correctly: a turn held open in a polling loop burns tokens on waiting and
 * dies at the tool timeout. But ending the turn left the chat reading `ready`,
 * exactly like a chat with nothing left to do, and nothing anywhere said this
 * one could not move until a person did something. Measured on the evening
 * that prompted this: the summons went up at 15:27, the person came back at
 * 16:08, and in between the rail, the card and the browser's own reaper all
 * treated the errand as over.
 *
 * So the wait is a STATE, derived from the same event log the card retires on
 * (a `needs-you` after the last `resolved`), surfaced as the existing
 * `blocked` status, and ended by the card's buttons — which is what resumes the
 * agent. Parking IS ending the turn; what changed is that the end is now
 * visible and the way back is mechanical.
 */

/**
 * How long an unanswered summons holds its chat — and its browser — waiting.
 *
 * ONE DEFINITION, in shared, because the web had a second copy of the same
 * number deciding whether the card still offers Done — see the note there for
 * what the two disagreeing would cost. Re-exported rather than moved outright
 * so the readers that already import it from here keep working, and so this
 * file still names the policy it enforces.
 */
export { SUMMONS_HOLD_MS } from '@muxpad/shared';

/** When the outstanding summons went up, or null — honouring the hold. */
export function liveSummonsAt(
  events: readonly { kind: string; reason?: string; at?: number }[],
  now: number,
  holdMs = SUMMONS_HOLD_MS,
): number | null {
  const waiting = outstandingSummons(events);
  if (!waiting) return null;
  return now - waiting.at < holdMs ? waiting.at : null;
}

/** Every agent pane currently parked on a person. */
export function awaitingPanes(db: Database.Database, now = Date.now()): Set<string> {
  const out = new Set<string>();
  const events = new BrowserEvents(db);
  const owner = new BrowserOwner(db);
  for (const browser of listBrowserApps(db)) {
    if (liveSummonsAt(events.list(browser.profile), now) === null) continue;
    const tabId = owner.get(browser.profile);
    const paneId = tabId ? agentPaneForTab(db, tabId) : null;
    if (paneId) out.add(paneId);
  }
  return out;
}
