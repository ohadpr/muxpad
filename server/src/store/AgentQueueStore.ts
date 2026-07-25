import type Database from 'better-sqlite3';
import { monotonicFactory } from 'ulid';

const ulid = monotonicFactory();

export interface QueuedSend {
  id: string;
  pane_id: string;
  seq: number;
  text: string;
  created_at: number;
}

/**
 * Server-owned queue of user messages waiting for a busy (or reconnecting)
 * agent runner. The server drains it one message per turn, so a queue keeps
 * feeding the agent even with no browser open; the client renders the pending
 * bubbles from this store rather than local state, so they survive reloads and
 * follow the user across devices.
 *
 * Ordering is by `seq` — a per-pane monotonic counter (max+1 at enqueue) so a
 * cancel in the middle never reshuffles the rest. One store, keyed by pane.
 */
export class AgentQueueStore {
  constructor(private readonly db: Database.Database) {}

  /** Append a message to the end of a pane's queue. Returns the stored row. */
  enqueue(paneId: string, text: string): QueuedSend {
    const id = ulid();
    const now = Date.now();
    const seq =
      ((
        this.db.prepare('SELECT MAX(seq) AS m FROM agent_queue WHERE pane_id = ?').get(paneId) as
          | { m: number | null }
          | undefined
      )?.m ?? 0) + 1;
    this.db
      .prepare(
        'INSERT INTO agent_queue (id, pane_id, seq, text, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(id, paneId, seq, text, now);
    return { id, pane_id: paneId, seq, text, created_at: now };
  }

  /** Every queued message for a pane, oldest first. */
  list(paneId: string): QueuedSend[] {
    return this.db
      .prepare('SELECT * FROM agent_queue WHERE pane_id = ? ORDER BY seq ASC')
      .all(paneId) as QueuedSend[];
  }

  /** The oldest queued message for a pane, or undefined if the queue is empty. */
  peek(paneId: string): QueuedSend | undefined {
    return this.db
      .prepare('SELECT * FROM agent_queue WHERE pane_id = ? ORDER BY seq ASC LIMIT 1')
      .get(paneId) as QueuedSend | undefined;
  }

  count(paneId: string): number {
    return (
      this.db.prepare('SELECT COUNT(*) AS n FROM agent_queue WHERE pane_id = ?').get(paneId) as {
        n: number;
      }
    ).n;
  }

  /** Remove one queued message by id, scoped to its pane so a socket for one
   *  pane can't cancel another pane's message. Returns true if a row was
   *  deleted. */
  remove(id: string, paneId: string): boolean {
    return (
      this.db.prepare('DELETE FROM agent_queue WHERE id = ? AND pane_id = ?').run(id, paneId)
        .changes > 0
    );
  }

  /** Clear a pane's entire queue. Returns the number of messages removed. */
  clear(paneId: string): number {
    return this.db.prepare('DELETE FROM agent_queue WHERE pane_id = ?').run(paneId).changes;
  }
}
