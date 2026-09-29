import type Database from 'better-sqlite3';

/**
 * Giving the browser back should be the last thing a person has to do.
 *
 * The handoff was built one way round. The agent hits a login, raises a card,
 * and stops — which is right, because a turn that sits in a polling loop while
 * somebody walks to their phone is a turn burning tokens on waiting. But the
 * return journey was never built: the person signed in, pressed Done, and then
 * had to go and TELL the agent, in words, that they were finished. Two taps and
 * a sentence to communicate a fact muxpad already knew the instant the wheel
 * came back.
 *
 * So the release IS the message. Pressing Done hands the browser over and says
 * so, in the conversation that asked, and the agent picks up where it stopped.
 *
 * ONLY WHEN SOMEBODY WAS ASKED FOR. An agent releasing its own wheel is routine
 * bookkeeping and must not send itself anything — that is a loop. And a person
 * who took the wheel out of curiosity, with no card outstanding, has interrupted
 * nothing and has nothing to hand back to.
 */

/**
 * Whether an agent is still waiting on somebody, and what it asked.
 *
 * Read from the EVENT LOG rather than from the live "needs you" flag, because
 * that flag is already gone by the time anybody hands the browser back: taking
 * the wheel clears it, deliberately — arriving is the acknowledgement, and a
 * card that keeps shouting at the person who has already arrived is noise.
 *
 * The log keeps the fact anyway. A summons is outstanding when there is a
 * `needs-you` after the last `resolved`, which is precisely the rule the card
 * itself retires on, so the two cannot drift apart.
 */
export function outstandingSummons(
  events: readonly { kind: string; reason?: string }[],
): { reason: string } | null {
  let waiting: { reason: string } | null = null;
  for (const e of events) {
    if (e.kind === 'needs-you') waiting = { reason: e.reason ?? '' };
    else if (e.kind === 'resolved') waiting = null;
  }
  return waiting;
}

export interface HandbackNudge {
  /** The pane to deliver into. */
  paneId: string;
  /** What that conversation will see. */
  text: string;
}

/**
 * What the agent is told.
 *
 * Written as a REPORT OF FACT, not an instruction. The agent knows what it was
 * doing and why it stopped; what it cannot know is that the wait is over and the
 * page has probably changed underneath it. Telling it to "continue" would be
 * muxpad guessing at a task it was never told, and the guess reads as a new
 * request — so this says what happened and leaves the next move where it
 * belongs.
 *
 * The RE-CHECK is the load-bearing sentence. A resumed agent acting on the
 * snapshot it had before the handoff is the documented failure mode of this
 * whole exchange: the url has usually changed and the DOM certainly has.
 */
export function handbackMessage(reason: string | null): string {
  const what = reason?.trim() ? ` (you asked: ${reason.trim()})` : '';
  return (
    `The browser is yours again${what} — I have finished with it and handed it back. ` +
    'The page has almost certainly changed, so look at it before you act on anything ' +
    'you saw before the handoff.'
  );
}

/**
 * The pane a browser's conversation is currently running in.
 *
 * Resolved at the moment of the handback rather than remembered from the
 * summons, because a pane is not durable: a conversation survives its pane being
 * respawned, and a pane id captured when the card went up can easily be dead by
 * the time somebody gets to their phone. The TAB is the conversation, and the
 * pane is only ever the current address of it.
 */
export function agentPaneForTab(db: Database.Database, tabId: string): string | null {
  try {
    const row = db
      .prepare(
        `SELECT id FROM panes WHERE tab_id = ? AND kind = 'agent'
          ORDER BY created_at DESC LIMIT 1`,
      )
      .get(tabId) as { id: string } | undefined;
    return row?.id ?? null;
  } catch {
    // A schema that predates agent panes. Nobody to tell.
    return null;
  }
}

/**
 * Whether this particular release should wake anybody, and with what.
 *
 * Pure, and separated from the sending on purpose — every rule about when NOT
 * to send is here, where it can be read in one place and tested without a
 * database, a runner or a browser.
 */
export function nudgeForHandback(input: {
  /** Who held the wheel before the release, or null if nobody did. */
  held: { holder: 'human' | 'agent'; by: string } | null;
  /** Who is releasing. */
  by: string;
  /** Set while an agent is still waiting on a person — see outstandingSummons. */
  needsYou: { reason: string } | null;
  /** The pane the owning conversation is running in, if it has one. */
  paneId: string | null;
}): HandbackNudge | null {
  // Not the holder: the release failed, so nothing was handed anywhere.
  if (!input.held || input.held.by !== input.by) return null;
  // An agent tidying up after itself. Telling it would be talking to itself.
  if (input.held.holder !== 'human') return null;
  // Nobody was waiting — this person was looking, not helping.
  if (!input.needsYou) return null;
  if (!input.paneId) return null;
  return { paneId: input.paneId, text: handbackMessage(input.needsYou.reason) };
}
