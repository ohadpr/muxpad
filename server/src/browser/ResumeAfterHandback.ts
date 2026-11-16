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
  events: readonly { kind: string; reason?: string; at?: number }[],
): { reason: string; at: number } | null {
  let waiting: { reason: string; at: number } | null = null;
  for (const e of events) {
    if (e.kind === 'needs-you') waiting = { reason: e.reason ?? '', at: e.at ?? 0 };
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

/** What the person pressed. `skip` means "carry on without it". */
export type HandbackOutcome = 'done' | 'skip';

/**
 * The page as it is at the moment of the handback, read by the host.
 *
 * `outline` is a short list of what is on screen — headings, buttons, links,
 * and every field with its LABEL and whether it is filled. Never a field's
 * value: a person has just been typing on this page, and what they typed is
 * very often a card number or a password.
 */
export interface HandbackPage {
  url: string;
  title: string;
  outline: string[];
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
 * THE PAGE RIDES ALONG. "Look at it before you act" used to be the whole of
 * the re-check, and a sentence is a request: the agent that acted on its old
 * snapshot anyway is the documented failure of this exchange. So the message
 * carries the page as it is NOW — url, title, what is on it — and the agent's
 * browser connection was cut at the same moment (see the host's /handback), so
 * any element reference from before the handoff is refused rather than obeyed.
 */
export function handbackMessage(
  reason: string | null,
  outcome: HandbackOutcome = 'done',
  page: HandbackPage | null = null,
  shotPath: string | null = null,
): string {
  const what = reason?.trim() ? ` (you asked: ${reason.trim()})` : '';
  const head =
    outcome === 'skip'
      ? `They pressed Skip${what} — they will not do it. The browser is yours again; carry on without it, or stop and say what you need instead.`
      : `They pressed Done${what} — the browser is yours again.`;
  const lines = [head, 'The page may have changed while they had it.'];
  if (page) {
    lines.push('', `The page now: ${page.url}${page.title ? ` — "${page.title}"` : ''}`);
    if (page.outline.length) lines.push(...page.outline.map((l) => `  ${l}`));
  } else {
    lines.push('', 'The page could not be read just now.');
  }
  if (shotPath) lines.push(`Screenshot: ${shotPath}`);
  lines.push(
    '',
    'Your browser connection was reset, so element refs from before the handoff no longer resolve: take a fresh snapshot before you click or type anything.',
  );
  return lines.join('\n');
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
  outcome?: HandbackOutcome;
  page?: HandbackPage | null;
  shotPath?: string | null;
}): HandbackNudge | null {
  // Not the holder: the release failed, so nothing was handed anywhere.
  if (!input.held || input.held.by !== input.by) return null;
  // An agent tidying up after itself. Telling it would be talking to itself.
  if (input.held.holder !== 'human') return null;
  // Nobody was waiting — this person was looking, not helping.
  if (!input.needsYou) return null;
  if (!input.paneId) return null;
  return {
    paneId: input.paneId,
    text: handbackMessage(
      input.needsYou.reason,
      input.outcome ?? 'done',
      input.page ?? null,
      input.shotPath ?? null,
    ),
  };
}
