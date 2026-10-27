import {
  type WorkingSlot,
  parseWorkingSet,
  pruneWorkingSet,
  removeFromWorkingSet,
  touchWorkingSet,
} from '@muxpad/shared';
import type Database from 'better-sqlite3';
import { GlobalsStore } from './store/GlobalsStore.js';
import { TabStore } from './store/TabStore.js';

/**
 * THE WORKING SET, PERSISTED.
 *
 * The algorithm is in shared/working-set.ts — pure, and the file note there
 * carries the measurements behind the cap and the decay. This is the part that
 * remembers it across a restart, which it must: a working set that empties
 * when the server bounces is not one.
 *
 * In `globals` rather than a table of its own. It is a single list of at most
 * six ids with no relations, no history and no query beyond "give me all of
 * it" — the exact shape that KV is for, and a migration nobody has to write.
 */
const KEY = 'working_set';

export class WorkingSet {
  private readonly globals: GlobalsStore;
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => number = Date.now,
  ) {
    this.globals = new GlobalsStore(db);
  }

  /**
   * The strip, as it should render right now.
   *
   * Pruned for decay AND for rows that no longer exist: a chat can be deleted,
   * or moved to another install, while it holds a slot — and a strip is a list
   * of places to GO, so a slot pointing nowhere is worse than an empty one.
   * Both prunes happen on read, never on a timer; see the shared note.
   */
  list(): WorkingSlot[] {
    const live = pruneWorkingSet(parseWorkingSet(this.globals.get(KEY)), this.now());
    if (live.length === 0) return live;
    const tabs = new TabStore(this.db);
    const real = live.filter((s) => tabs.getById(s.tabId));
    if (real.length !== live.length) this.write(real);
    return real;
  }

  /** You sent this chat a message. Returns true if the strip changed shape —
   *  which is what decides whether anything has to be told about it. */
  touch(tabId: string): boolean {
    const before = this.list();
    const after = touchWorkingSet(before, tabId, this.now());
    if (sameShape(before, after)) {
      // The order is identical; only a timestamp moved. Still written (decay
      // depends on it) and deliberately NOT announced: a strip that re-renders
      // on every message you send is the churn this design exists to remove.
      this.write(after);
      return false;
    }
    this.write(after);
    return true;
  }

  /** "Not now." Frees the slot; touches nothing else about the chat. */
  remove(tabId: string): boolean {
    const before = this.list();
    const after = removeFromWorkingSet(before, tabId);
    if (after.length === before.length) return false;
    this.write(after);
    return true;
  }

  private write(slots: readonly WorkingSlot[]): void {
    this.globals.set(KEY, JSON.stringify(slots));
  }
}

/** Same chats in the same slots — timestamps are not shape. */
function sameShape(a: readonly WorkingSlot[], b: readonly WorkingSlot[]): boolean {
  return a.length === b.length && a.every((s, i) => s.tabId === b[i]?.tabId);
}
