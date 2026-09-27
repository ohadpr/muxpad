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

export interface BrowserCardData {
  profile: string;
  viewerUrl: string;
  state: 'registered' | 'started' | 'running';
  wheel: BrowserWheelLease | null;
  /** Set when an agent has explicitly asked for a person. */
  needsYou?: { reason: string; at: number } | null;
}

export type BrowserCardTone = 'idle' | 'working' | 'blocked' | 'yours';

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
}

/**
 * The card, as a person reads it.
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
      tone: 'blocked',
      title: 'Needs you in the browser',
      detail: data.needsYou.reason,
      action: 'Take the wheel',
      urgent: true,
    };
  }

  if (data.wheel?.holder === 'human') {
    return {
      tone: 'yours',
      title: 'You have the wheel',
      detail: data.wheel.reason ?? '',
      action: 'Open',
      urgent: false,
    };
  }

  if (data.wheel?.holder === 'agent') {
    return {
      tone: 'working',
      title: `Browsing · ${profile}`,
      detail: '',
      action: 'Watch',
      urgent: false,
    };
  }

  if (data.state === 'registered') {
    return {
      tone: 'idle',
      title: `Browser · ${profile}`,
      detail: 'not running',
      action: 'Start',
      urgent: false,
    };
  }

  return {
    tone: 'idle',
    title: `Browser · ${profile}`,
    detail: 'idle',
    action: 'Open',
    urgent: false,
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
