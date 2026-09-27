/**
 * What a browser card says, and what its button does.
 *
 * Kept out of the component for the usual reason — a card that says the wrong
 * thing is the whole bug, and asserting on a string is cheaper than asserting
 * on a rendered tree — but also for a specific one: this card has a state
 * ("the agent is waiting for you") that only ever appears when somebody is
 * blocked, which is exactly the state that is hardest to reproduce by hand.
 */

export interface BrowserWheelLease {
  holder: 'human' | 'agent';
  by: string;
  reason?: string;
  takenAt: number;
  expiresAt: number;
}

export interface BrowserEvent {
  kind: 'opened' | 'needs-you' | 'resolved';
  at: number;
  tabId?: string;
  reason?: string;
}

export interface BrowserCardData {
  profile: string;
  /** Absolute, tailnet when known — the link you can open on a phone. */
  viewerUrl: string;
  state: 'registered' | 'started' | 'running';
  wheel: BrowserWheelLease | null;
  /** Set when an agent has explicitly asked for a person. */
  needsYou?: { reason: string; at: number } | null;
  /** The moments worth a card, oldest first. */
  events?: BrowserEvent[];
}

/**
 * `waiting` rather than `blocked`, and the colour follows the name. Red means
 * something broke; nothing has. The agent reached a step only a person can take,
 * which is the system working exactly as designed — it should read as a
 * hand-off, not an alarm.
 */
export type BrowserCardTone = 'idle' | 'working' | 'waiting' | 'yours';

export interface BrowserCardView {
  tone: BrowserCardTone;
  /** One line, the card's headline. */
  title: string;
  /** Secondary line. Empty string when there is nothing worth saying. */
  detail: string;
  /** Label of the primary action, or null when there is no action. */
  action: string | null;
  /** Whether this card should pull the eye. */
  urgent: boolean;
  /**
   * Whether the lease countdown belongs on this card.
   *
   * Only while YOU hold the wheel — it is your lease running out. On a card
   * about something the agent did, or a browser nobody is driving, it is a
   * number with nothing to refer to.
   */
  countdown: boolean;
}

/**
 * The card, as a person reads it.
 *
 * There is no "start it" state: {@link visibleBrowsers} means a card only
 * exists for a browser that is already running (or asking for you), so a
 * not-running branch here would be unreachable code behind a passing test.
 *
 * ORDER MATTERS AND IS NOT ALPHABETICAL. "The agent needs you" outranks
 * everything, including the agent holding the wheel — because an agent that has
 * asked for help is still nominally driving, and if the holder check came first
 * the card would say "the agent is browsing" at the exact moment it is stuck
 * waiting for you. That is the failure this whole feature exists to end.
 */
export function browserCardView(data: BrowserCardData): BrowserCardView {
  const profile = data.profile;

  if (data.needsYou) {
    return {
      tone: 'waiting',
      title: '',
      detail: data.needsYou.reason,
      action: 'Open',
      urgent: true,
      countdown: false,
    };
  }

  if (data.wheel?.holder === 'human') {
    return {
      tone: 'yours',
      title: 'You have the wheel',
      detail: data.wheel.reason ?? '',
      action: 'Open',
      urgent: false,
      countdown: true,
    };
  }

  if (data.wheel?.holder === 'agent') {
    return {
      tone: 'working',
      title: `Browsing · ${profile}`,
      detail: '',
      action: 'Open',
      urgent: false,
      countdown: false,
    };
  }

  return {
    tone: 'idle',
    title: `Browser · ${profile}`,
    detail: 'idle',
    action: 'Open',
    urgent: false,
    countdown: false,
  };
}

/**
 * Whether to open the stream in a modal or a new tab.
 *
 * A modal on a phone is a postage stamp of a 1280px page inside a 390px
 * viewport with a keyboard covering half of it — unusable for the one thing
 * somebody opened it to do, which is type. A tab gets the whole screen.
 */
export function browserOpenMode(viewportWidth: number): 'modal' | 'tab' {
  return viewportWidth < 700 ? 'tab' : 'modal';
}

/** How long a lease has left, as a short human string. Empty when not held. */
export function wheelCountdown(lease: BrowserWheelLease | null, now: number): string {
  if (!lease) return '';
  const left = lease.expiresAt - now;
  if (left <= 0) return 'expired';
  const mins = Math.floor(left / 60_000);
  if (mins >= 1) return `${mins}m left`;
  return `${Math.max(1, Math.ceil(left / 1000))}s left`;
}

/**
 * Whether the viewer should keep the lease alive.
 *
 * Renews at the HALFWAY point, not near expiry. A renew that fires at 90% of a
 * ten-minute lease is one dropped request away from the browser being taken
 * back mid-sentence, and the request costs nothing.
 */
export function shouldRenewWheel(lease: BrowserWheelLease | null, now: number): boolean {
  if (!lease || lease.holder !== 'human') return false;
  const total = lease.expiresAt - lease.takenAt;
  if (total <= 0) return false;
  return now - lease.takenAt >= total / 2 && now < lease.expiresAt;
}

/**
 * The browsers worth a card in a conversation.
 *
 * A card for a browser that is not running is pure noise: it says nothing you
 * can act on, it cannot be looked at, and — because a profile is registered at
 * boot and stays registered — it would sit at the top of every conversation
 * forever. The card exists to tell you something is HAPPENING.
 *
 * The two overrides are deliberate. A browser that is asking for you, or that
 * somebody is driving, gets a card whatever its reported state says. Those
 * facts and the app-row state are read from different places and can disagree
 * for a poll or two, and the asymmetry of being wrong is severe: a card that
 * lingers briefly is untidy, a missed "an agent is waiting for you" is the
 * failure this whole feature exists to end.
 *
 * Order is preserved so cards do not reshuffle under a poll.
 */
export function visibleBrowsers(browsers: readonly BrowserCardData[]): BrowserCardData[] {
  return browsers.filter(
    (b) => b.state === 'running' || b.state === 'started' || b.needsYou || b.wheel,
  );
}

/**
 * Where the modal's iframe points.
 *
 * RELATIVE, deliberately, while {@link BrowserCardData.viewerUrl} stays
 * absolute. They are for different jobs: the absolute one is a link you can
 * send to a phone, and the relative one is always same-origin with whatever
 * host you happen to have the cockpit open on — loopback at your desk, the
 * tailnet name from the sofa. Hard-coding either into the iframe makes one of
 * those two cases a cross-origin frame for no reason.
 */
export function browserViewerPath(profile: string): string {
  return `/browser/${profile}/`;
}

/** One card in a conversation: a thing that happened, plus the browser it happened to. */
export interface BrowserMoment {
  kind: 'opened' | 'needs-you';
  at: number;
  reason?: string;
  profile: string;
  /** The browser as it is NOW, so the card can open it and read the wheel. */
  browser: BrowserCardData;
}

/**
 * The moments this conversation should draw, oldest first.
 *
 * WHAT CHANGED AND WHY. The card used to be pinned above the transcript: one
 * per browser, always there, showing whatever was currently true. That made it
 * a status light for a thing that is really a sequence of events — the browser
 * opened, then later it got stuck. Both belong in the log where they happened,
 * with the chat continuing past them, like a spawned worker's launch and its
 * report.
 *
 * SCOPING, and the one judgement in here. A moment is shown in the chat it
 * happened in and NOWHERE ELSE — including moments with no chat at all.
 *
 * That last part was the other way round at first, reasoning that a summons
 * nobody can see is worse than a card in the wrong place. It is worse; the
 * mistake was thinking those were the only options. Showing untagged moments
 * everywhere meant opening a brand-new conversation greeted you with cards
 * about things that happened elsewhere, before that chat existed — which is the
 * noise the pinned card had, wearing a different hat. A browser that no chat
 * started belongs to no chat's log; `muxpad app list` is where it lives.
 *
 * `resolved` is dropped. It is bookkeeping that lets the server know a summons
 * was answered; as a line in a conversation it says nothing a person needs.
 */
export function browserMoments(
  browsers: readonly BrowserCardData[],
  tabId: string,
): BrowserMoment[] {
  const out: BrowserMoment[] = [];
  for (const browser of browsers) {
    for (const event of browser.events ?? []) {
      if (event.kind === 'resolved') continue;
      // A moment belongs to ONE conversation: the one it happened in. An
      // untagged moment is not shown anywhere.
      if (event.tabId !== tabId) continue;
      out.push({
        kind: event.kind,
        at: event.at,
        ...(event.reason !== undefined ? { reason: event.reason } : {}),
        profile: browser.profile,
        browser,
      });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

/** Session browsers are named after the session, which is not a word for a person. */
function isSessionProfile(profile: string): boolean {
  return profile.startsWith('s-');
}

/** Whether a browser can still be looked at. */
function isLive(browser: BrowserCardData): boolean {
  return browser.state === 'running' || browser.state === 'started';
}

/**
 * A card drawn from a moment in the log.
 *
 * THE RULE THAT MATTERS: a summons stops shouting once it has been answered.
 * The moment stays in the conversation forever — it happened, and the log is a
 * record — but a card still demanding attention for something dealt with an
 * hour ago is how you train somebody to ignore the one that counts. So
 * urgency comes from the browser's CURRENT state, while the words come from
 * what happened.
 *
 * And a moment outlives its browser. When the browser is gone there is no
 * action: offering to open a viewer that is not running is a connection error
 * inside an iframe, which reads as "muxpad is broken".
 */
export function browserMomentView(moment: BrowserMoment): BrowserCardView {
  const { browser } = moment;
  const live = isLive(browser);
  const yours = browser.wheel?.holder === 'human';
  // A summons while YOU are already driving is a card asking for something you
  // have already done. It reads as handled, because it is.
  const stillAsking = moment.kind === 'needs-you' && Boolean(browser.needsYou) && !yours;

  if (stillAsking) {
    return {
      tone: 'waiting',
      // NO TITLE. "Needs you" bought a line and said nothing the card was not
      // already saying — the colour, the mark and the button all mean "your
      // turn", and on a phone the label pushed the reason onto a second row.
      // The reason is the content; let it have the line.
      title: '',
      detail: moment.reason ?? '',
      action: live ? 'Open' : null,
      urgent: true,
      countdown: false,
    };
  }

  // ONE verb. "Take the wheel" and "Watch" describe the same click — opening the
  // stream takes the wheel either way — and both were longer than a phone could
  // afford. The title and the reason carry the why; the button says what happens.
  const action = live ? 'Open' : null;
  const detail = live ? (moment.kind === 'needs-you' ? (moment.reason ?? '') : '') : 'closed';

  if (moment.kind === 'needs-you') {
    return {
      tone: yours ? 'yours' : 'idle',
      title: 'Handled',
      detail: moment.reason ?? detail,
      action,
      urgent: false,
      countdown: yours,
    };
  }

  return {
    tone: yours ? 'yours' : browser.wheel ? 'working' : 'idle',
    // A session profile is `s-01m3hw…` — a database key wearing a label. It
    // says nothing to a person and on a phone it ate the whole line. A profile
    // somebody NAMED is worth showing, because they chose the word.
    title: isSessionProfile(moment.profile) ? 'Browser opened' : `Browser · ${moment.profile}`,
    detail,
    action,
    urgent: false,
    countdown: yours,
  };
}

/**
 * Injects browser moments into a conversation's entries, in time order.
 *
 * Deliberately the same placement rule as spawn cards: a moment is emitted
 * before the first entry that happened AFTER it, moments older than the loaded
 * history come out at the top, and ones newer than the last entry come out at
 * the bottom — which is where a browser that just opened belongs. An entry with
 * NO time is not a boundary, because it cannot say whether the moment came
 * before or after it, and guessing would move the card on the next reload.
 *
 * It returns ENTRIES rather than a tagged union, so the result drops straight
 * into the existing spawn-card interleave without that function — or the file it
 * lives in — needing to know browsers exist.
 *
 * Generic over the node type for the same reason as its sibling: placement is
 * the half that can be wrong, and it is worth testing against ['a','b'] rather
 * than a mounted six-thousand-line component.
 */
export function injectBrowserMoments<T>(
  entries: readonly { at: number | null; node: T }[],
  moments: readonly BrowserMoment[],
  render: (moment: BrowserMoment) => T,
): { at: number | null; node: T }[] {
  const out: { at: number | null; node: T }[] = [];
  let i = 0;
  for (const entry of entries) {
    if (entry.at !== null) {
      while (i < moments.length && (moments[i] as BrowserMoment).at <= entry.at) {
        const moment = moments[i++] as BrowserMoment;
        out.push({ at: moment.at, node: render(moment) });
      }
    }
    out.push(entry);
  }
  for (; i < moments.length; i++) {
    const moment = moments[i] as BrowserMoment;
    out.push({ at: moment.at, node: render(moment) });
  }
  return out;
}
