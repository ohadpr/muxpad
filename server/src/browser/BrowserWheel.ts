import type Database from 'better-sqlite3';
import { GlobalsStore } from '../store/GlobalsStore.js';
import { normalizeProfileName } from './BrowserProfile.js';

/**
 * Who is driving a browser profile.
 *
 * THE BUG THIS PREVENTS
 * ---------------------
 * Two things can drive one browser: the agent, over the Playwright MCP, and a
 * person, over the screencast. Nothing otherwise stops them doing it at the same
 * moment. The failure is concrete and unpleasant — you are halfway through
 * typing a card number, the agent fires the click it queued forty seconds ago,
 * and the form is gone.
 *
 * THE ASYMMETRY IS THE WHOLE DESIGN
 * ---------------------------------
 * A person can take the wheel from an agent whenever they want. An agent can
 * NEVER take it from a person. Not after a timeout, not politely, not at all.
 * Anything else makes "you have the wheel" a claim the system does not actually
 * honour, and the one moment it matters is the one moment somebody is typing
 * something they cannot retype.
 *
 * Agent-vs-agent is symmetric and first-come: two chats sharing a profile would
 * otherwise interleave clicks into one page.
 *
 * WHY SQLITE AND NOT THE AGENT'S MEMORY
 * -------------------------------------
 * Agent processes die and restart routinely — muxpad's own notes record that
 * background subagents and wakeups do not survive a respawn. A lease held in one
 * of them is a browser checked out to a process that no longer exists, with
 * nobody able to release it. That is strictly worse than no lease, so the wheel
 * lives in the globals KV, which is the same "logic on the server" rule the rest
 * of muxpad already follows.
 *
 * WHY IT EXPIRES
 * --------------
 * The decisive case is ordinary: somebody taps "take the wheel", deals with the
 * login, puts the phone down, and goes to sleep. Without a TTL the profile is
 * checked out until a human notices — the same no-owner-no-alarm shape that left
 * a dead tunnel hostname pinned for months. Holding it open requires actually
 * being there, via {@link renew}.
 */

/** Who wants to drive. */
export type WheelHolder = 'human' | 'agent';

export interface WheelLease {
  holder: WheelHolder;
  /** Pane id, chat id — whatever identifies the specific claimant. */
  by: string;
  /** Free text shown to whoever is refused. */
  reason?: string;
  /** Epoch ms. */
  takenAt: number;
  expiresAt: number;
}

export interface TakeRequest {
  holder: WheelHolder;
  by: string;
  reason?: string;
  ttlMs?: number;
}

export interface TakeResult {
  granted: boolean;
  /** Why it was refused, phrased for an agent to repeat to a person. */
  reason?: string;
  lease: WheelLease | null;
}

/**
 * Default hold. Long enough that a person dealing with a login is not
 * interrupted, short enough that a forgotten session frees itself within a
 * coffee break.
 */
export const DEFAULT_WHEEL_TTL_MS = 10 * 60 * 1000;

const KEY_PREFIX = 'browser_wheel_';

export class BrowserWheel {
  private readonly globals: GlobalsStore;

  constructor(
    db: Database.Database,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.globals = new GlobalsStore(db);
  }

  /** The live lease, or null if free or lapsed. */
  holder(profile: string): WheelLease | null {
    const raw = this.globals.get(KEY_PREFIX + normalizeProfileName(profile));
    if (!raw) return null;
    let lease: WheelLease;
    try {
      lease = JSON.parse(raw) as WheelLease;
    } catch {
      // A wheel that cannot be READ must not become a wheel that cannot be
      // TAKEN. Corrupt row reads as free.
      return null;
    }
    if (typeof lease?.expiresAt !== 'number' || lease.expiresAt <= this.now()) return null;
    return lease;
  }

  /** Whether `who` may issue actions against this profile right now. */
  canDrive(profile: string, who: WheelHolder): boolean {
    const current = this.holder(profile);
    if (!current) return true;
    if (who === 'human') return true;
    return current.holder === 'agent';
  }

  take(profile: string, request: TakeRequest): TakeResult {
    const name = normalizeProfileName(profile);
    const current = this.holder(name);

    // The pane identifies the conversation, not whether its human or agent is
    // driving. Sharing that ID must not let an agent demote a human lease.
    if (current && (current.by !== request.by || current.holder !== request.holder)) {
      // The one rule that cannot bend.
      if (current.holder === 'human' && request.holder === 'agent') {
        return {
          granted: false,
          reason: current.reason
            ? `a human has the wheel (${current.reason}) — wait, do not retry, and say so`
            : 'a human has the wheel — wait, do not retry, and say so',
          lease: current,
        };
      }
      if (current.holder === 'agent' && request.holder === 'agent') {
        return {
          granted: false,
          reason: `another agent (${current.by}) has the wheel`,
          lease: current,
        };
      }
      // human taking over from an agent: always allowed, falls through.
    }

    const takenAt = this.now();
    const lease: WheelLease = {
      holder: request.holder,
      by: request.by,
      ...(request.reason ? { reason: request.reason } : {}),
      takenAt,
      expiresAt: takenAt + (request.ttlMs ?? DEFAULT_WHEEL_TTL_MS),
    };
    this.globals.set(KEY_PREFIX + name, JSON.stringify(lease));
    return { granted: true, lease };
  }

  /** Extends a live lease. Only its holder, and only while it is still live. */
  renew(profile: string, by: string, ttlMs = DEFAULT_WHEEL_TTL_MS): boolean {
    const name = normalizeProfileName(profile);
    const current = this.holder(name);
    if (!current || current.by !== by) return false;
    this.globals.set(
      KEY_PREFIX + name,
      JSON.stringify({ ...current, expiresAt: this.now() + ttlMs }),
    );
    return true;
  }

  /**
   * Hands the wheel back. Only its holder may.
   *
   * An agent quietly releasing a human's wheel and carrying on is the same bug
   * as taking it, wearing a different hat.
   */
  release(profile: string, by: string): boolean {
    const name = normalizeProfileName(profile);
    const current = this.holder(name);
    if (!current || current.by !== by) return false;
    this.globals.set(KEY_PREFIX + name, JSON.stringify({ ...current, expiresAt: 0 }));
    return true;
  }
}

/**
 * "I need a person here."
 *
 * SEPARATE FROM THE WHEEL, and that separation is the point. An agent that hits
 * a login wall still HOLDS the wheel — it has not handed anything over, it is
 * stuck. If asking for help were modelled as releasing the wheel, the browser
 * would sit unclaimed and another agent could wander in and start clicking
 * through the very page a person is being summoned to.
 *
 * So this is a flag beside the lease: the agent keeps the wheel and raises a
 * hand. Taking the wheel is what lowers it — not a separate acknowledgement,
 * because a person who has arrived and is driving has self-evidently seen it,
 * and an "ack" nobody presses is how a card ends up shouting forever.
 */
export interface NeedsYou {
  reason: string;
  at: number;
  /**
   * CSS selector for the thing that needs a person — the password field, the
   * captcha, the card number box.
   *
   * Optional and untrusted: it is evaluated in the page and a wrong one simply
   * finds nothing, which leaves the browser open where it already was. It buys
   * arriving at the field instead of at a page.
   */
  selector?: string;
}

const NEEDS_PREFIX = 'browser_needs_you_';

export class BrowserAttention {
  private readonly globals: GlobalsStore;

  constructor(
    db: Database.Database,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.globals = new GlobalsStore(db);
  }

  get(profile: string): NeedsYou | null {
    const raw = this.globals.get(NEEDS_PREFIX + normalizeProfileName(profile));
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as NeedsYou;
      return parsed?.reason ? parsed : null;
    } catch {
      return null;
    }
  }

  /** An agent asks for a person, and says what for. */
  raise(profile: string, reason: string, selector?: string): NeedsYou {
    const asked: NeedsYou = { reason, at: this.now(), ...(selector ? { selector } : {}) };
    this.globals.set(NEEDS_PREFIX + normalizeProfileName(profile), JSON.stringify(asked));
    return asked;
  }

  clear(profile: string): void {
    this.globals.set(NEEDS_PREFIX + normalizeProfileName(profile), '');
  }
}
