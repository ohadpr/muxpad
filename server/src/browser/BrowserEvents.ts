import type Database from 'better-sqlite3';
import { GlobalsStore } from '../store/GlobalsStore.js';
import { normalizeProfileName } from './BrowserProfile.js';

/**
 * A browser's moments, so they can sit IN a conversation rather than above it.
 *
 * WHY THIS EXISTS. The first card was pinned to the top of the transcript,
 * which made it a status light — always present, reporting whatever happened to
 * be true. That is the wrong shape for what this is. A browser opening is a
 * thing that HAPPENED, at a moment, in a particular conversation. An agent
 * getting stuck at a login wall is a second thing that happened later. Both
 * belong in the log at the point they occurred, with the chat continuing past
 * them — the same shape as a spawned worker's launch and its report.
 *
 * So the server records moments and the client draws them in place. The live
 * state (who holds the wheel, is it running) still comes from the browser view;
 * these are the timeline, not the truth.
 *
 * WHY THE GLOBALS KV AND NOT A TABLE. There is no query here — the client reads
 * every event for a profile on each poll and does the placement itself. A table
 * would buy indexing nobody needs and cost a migration, in a file two other
 * sessions are editing today.
 */

export type BrowserEventKind = 'opened' | 'needs-you' | 'resolved';

export interface BrowserEvent {
  kind: BrowserEventKind;
  /** Epoch ms. Its place in the log. */
  at: number;
  /** The chat it happened in, when there was one. */
  tabId?: string;
  /** What the agent said it was stuck on. */
  reason?: string;
  /**
   * Whether a still of the page was captured for this moment.
   *
   * A flag rather than a path: the file is derivable from (profile, at), and a
   * stored path would be a second source of truth that goes stale the moment
   * the data directory moves. False and absent mean the same thing — draw the
   * card without a picture.
   */
  shot?: boolean;
}

/**
 * How many moments to keep per profile.
 *
 * This rides every poll of /api/browsers, so it is a payload size as much as a
 * history: an unbounded array in a KV row would quietly become the most
 * expensive thing on the page.
 */
export const BROWSER_EVENT_CAP = 40;

const KEY_PREFIX = 'browser_events_';

export class BrowserEvents {
  private readonly globals: GlobalsStore;

  constructor(
    db: Database.Database,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.globals = new GlobalsStore(db);
  }

  /** Every recorded moment for a profile, oldest first. */
  list(profile: string): BrowserEvent[] {
    const raw = this.globals.get(KEY_PREFIX + normalizeProfileName(profile));
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      // These are decoration on a conversation. A malformed row must not be
      // able to take the chat down with it.
      return Array.isArray(parsed) ? (parsed as BrowserEvent[]) : [];
    } catch {
      return [];
    }
  }

  record(profile: string, event: Omit<BrowserEvent, 'at'>): BrowserEvent {
    const name = normalizeProfileName(profile);
    const stamped: BrowserEvent = { ...event, at: this.now() };
    // Oldest dropped, not newest: the recent end is the one somebody is looking
    // at, and a summons that fell off because the log was full would be the
    // exact failure this feature exists to prevent.
    const next = [...this.list(name), stamped].slice(-BROWSER_EVENT_CAP);
    this.globals.set(KEY_PREFIX + name, JSON.stringify(next));
    return stamped;
  }

  /**
   * Marks the newest moment as having a picture.
   *
   * Used when the still arrives AFTER the moment did — the browser photographs
   * itself on the way out, so the card for a closed browser shows the last page
   * it was on rather than the first one it visited, which is what a capture at
   * open time would have left behind.
   */
  attachShot(profile: string, at: number): boolean {
    const name = normalizeProfileName(profile);
    const list = this.list(name);
    const i = list.findIndex((e) => e.at === at);
    if (i === -1) return false;
    const next = list.map((e, n) => (n === i ? { ...e, shot: true } : e));
    this.globals.set(KEY_PREFIX + name, JSON.stringify(next));
    return true;
  }

  /** The newest moment worth illustrating, or null when the log is empty. */
  newestMoment(profile: string): BrowserEvent | null {
    const list = this.list(normalizeProfileName(profile)).filter((e) => e.kind !== 'resolved');
    return list.length ? (list[list.length - 1] as BrowserEvent) : null;
  }

  clear(profile: string): void {
    this.globals.set(KEY_PREFIX + normalizeProfileName(profile), '[]');
  }
}
