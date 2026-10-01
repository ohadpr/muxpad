import { type InboundSender, inboundTextKey } from '@muxpad/shared';
import type Database from 'better-sqlite3';
import { monotonicFactory } from 'ulid';

const ulid = monotonicFactory();

/**
 * How many recorded sends one chat keeps.
 *
 * A standing worker is handed job after job for weeks, and each is a row. The
 * cap is what stops that being unbounded, and it is generous because the rows
 * are tiny (a key, a timestamp, two ids — no message text). What it costs when
 * it bites is the card on a message far enough up the log that nobody is
 * reading it any more, which is the right thing to spend.
 */
export const MAX_INBOUND_PER_TAB = 500;

/**
 * WHO SENT THIS — provenance for messages delivered INTO a chat.
 *
 * See the v35 migration for why this is a muxpad-owned row rather than a marker
 * in the message text: prepending a block would change the prompt every worker
 * receives, and muxpad does not write the agent's transcript in the first place
 * (it tails the harness's file), so a sender label could never be a transcript
 * row. `spawn_rounds` is the precedent and this follows its shape exactly —
 * written server-side, joined into the conversation by the client.
 */
export class InboundMessageStore {
  constructor(private readonly db: Database.Database) {}

  /**
   * A message was delivered into `tabId`, from `fromTabId`.
   *
   * `fromTabId` null is a real and expected outcome — a send muxpad cannot
   * attribute — and is recorded rather than dropped, so the absence of a name is
   * a fact the row states instead of one inferred from a missing row.
   *
   * NOT deduped on the key. The same text sent twice is two deliveries, and the
   * reader of the second one wants a card on it too; `listByTab` orders newest
   * first so a client matching by text resolves to the most recent.
   */
  record(opts: {
    tabId: string;
    text: string;
    fromTabId: string | null;
    at?: number;
  }): string | null {
    const key = inboundTextKey(opts.text);
    // An empty message is not a delivery — `submitSend` rejects it upstream, and
    // a row keyed on the empty string would match nothing anyway.
    if (!key.startsWith('0.')) {
      const id = ulid();
      this.db
        .prepare(
          'INSERT INTO inbound_messages (id, tab_id, at, text_key, from_tab_id) VALUES (?, ?, ?, ?, ?)',
        )
        .run(id, opts.tabId, opts.at ?? Date.now(), key, opts.fromTabId);
      this.trim(opts.tabId);
      return id;
    }
    return null;
  }

  /** Every recorded delivery into this chat, NEWEST FIRST. */
  listByTab(tabId: string): InboundSender[] {
    return (
      this.db
        .prepare(
          `SELECT text_key, at, from_tab_id FROM inbound_messages
            WHERE tab_id = ? ORDER BY at DESC, id DESC LIMIT ?`,
        )
        .all(tabId, MAX_INBOUND_PER_TAB) as Array<{
        text_key: string;
        at: number;
        from_tab_id: string | null;
      }>
    ).map((r) => ({ key: r.text_key, at: r.at, from_tab_id: r.from_tab_id }));
  }

  /** Hold this tab to the cap, oldest dropped first. */
  private trim(tabId: string): void {
    this.db
      .prepare(
        `DELETE FROM inbound_messages
          WHERE tab_id = ?
            AND id NOT IN (
              SELECT id FROM inbound_messages WHERE tab_id = ?
               ORDER BY at DESC, id DESC LIMIT ?
            )`,
      )
      .run(tabId, tabId, MAX_INBOUND_PER_TAB);
  }
}
