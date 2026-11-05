import type { ChatAction, ChatActionState } from '@muxpad/shared';
import type Database from 'better-sqlite3';
import { monotonicFactory } from 'ulid';

const ulid = monotonicFactory();

interface Row {
  id: string;
  pane_id: string;
  at: number;
  kind: string;
  title: string;
  body: string | null;
  url: string | null;
  state: string;
  detail: string | null;
  ref: string | null;
}

/**
 * THE AGENT'S ACTS ON OUTSIDE SYSTEMS, per chat.
 *
 * See shared/src/chat-actions.ts for what one is and why it is generic. This
 * is the durable half: a card has to survive a reload, a server restart and
 * being read from a different device, which is the whole difference between
 * this and the approval alert it replaces.
 *
 * ── `ref` IS HOW A LATER POLL FINDS THE ROW ──────────────────────────────
 * The outside system's own id for the act — a broker request id, a message ts.
 * The pane and the timestamp cannot serve: a chat can send two messages in the
 * same second, and the status poll that resolves them arrives out of order.
 */
export class ChatActionStore {
  constructor(private readonly db: Database.Database) {}

  /**
   * Record an act. Returns the row, so a caller can emit it immediately
   * rather than re-reading what it just wrote.
   */
  record(input: {
    pane_id: string;
    kind: string;
    title: string;
    state?: ChatActionState;
    body?: string | null;
    url?: string | null;
    detail?: string | null;
    ref?: string | null;
    at?: number;
  }): ChatAction {
    const id = ulid();
    const at = input.at ?? Date.now();
    this.db
      .prepare(
        `INSERT INTO chat_actions (id, pane_id, at, kind, title, body, url, state, detail, ref)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.pane_id,
        at,
        input.kind,
        input.title,
        input.body ?? null,
        input.url ?? null,
        input.state ?? 'pending',
        input.detail ?? null,
        input.ref ?? null,
      );
    return this.getById(id) as ChatAction;
  }

  /**
   * Resolve an act by the outside system's id.
   *
   * Returns the updated row, or null when nothing matched — which is a normal
   * outcome, not an error: muxpad polls the broker for every request it knows
   * about, including ones recorded before this table existed and ones made by
   * a verb that records nothing.
   *
   * A row already in a FINAL state is left alone. The broker's status endpoint
   * keeps answering after an act completes, and a late poll must not walk a
   * `sent` back to `pending` — the state here is the history of the act, not a
   * mirror of whatever the last poll happened to see.
   */
  resolveByRef(
    ref: string,
    patch: { state: ChatActionState; url?: string | null; detail?: string | null },
  ): ChatAction | null {
    const row = this.db.prepare('SELECT * FROM chat_actions WHERE ref = ?').get(ref) as
      | Row
      | undefined;
    if (!row) return null;
    if (row.state !== 'pending') return this.decorate(row);
    this.db
      .prepare('UPDATE chat_actions SET state = ?, url = COALESCE(?, url), detail = ? WHERE id = ?')
      .run(patch.state, patch.url ?? null, patch.detail ?? null, row.id);
    return this.getById(row.id);
  }

  getById(id: string): ChatAction | null {
    const row = this.db.prepare('SELECT * FROM chat_actions WHERE id = ?').get(id) as
      | Row
      | undefined;
    return row ? this.decorate(row) : null;
  }

  /**
   * This chat's acts, oldest first.
   *
   * Bounded, because the list is injected into a rendered log: a chat that has
   * posted five hundred times gets its most recent `limit` and the rest live
   * in the outside system, which is where a five-hundred-message history
   * belongs anyway.
   */
  listForPane(paneId: string, limit = 200): ChatAction[] {
    const rows = this.db
      .prepare('SELECT * FROM chat_actions WHERE pane_id = ? ORDER BY at DESC, id DESC LIMIT ?')
      .all(paneId, limit) as Row[];
    return rows.reverse().map((r) => this.decorate(r));
  }

  /** Drop a chat's acts. Called when its pane goes, so the table does not
   *  outlive every conversation that ever used it. */
  deleteForPane(paneId: string): void {
    this.db.prepare('DELETE FROM chat_actions WHERE pane_id = ?').run(paneId);
  }

  private decorate(r: Row): ChatAction {
    return {
      id: r.id,
      pane_id: r.pane_id,
      at: r.at,
      kind: r.kind,
      title: r.title,
      body: r.body,
      url: r.url,
      // Validated on the way OUT rather than trusted: a row written by an
      // older build (or by hand) must render as something, and `pending` is
      // the state that invites a look rather than asserting an outcome.
      state: isState(r.state) ? r.state : 'pending',
      detail: r.detail,
    };
  }
}

function isState(s: string): s is ChatActionState {
  return s === 'pending' || s === 'sent' || s === 'failed' || s === 'declined';
}
