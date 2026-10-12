import {
  CARD_MAX_BYTES,
  CARD_MAX_PER_TAB,
  type CardFormat,
  type ChatCard,
  isValidCardName,
} from '@muxpad/shared';
import type Database from 'better-sqlite3';
import { monotonicFactory } from 'ulid';

const ulid = monotonicFactory();

export interface CardWrite {
  tabId: string;
  name: string;
  content: string;
  format?: CardFormat;
  /** Expected cadence in ms, or null to clear one. Omit to leave unchanged. */
  everyMs?: number | null | undefined;
  at?: number;
}

export type CardWriteResult =
  | { ok: true; card: ChatCard; created: boolean }
  | { ok: false; reason: string };

interface RawCard {
  id: string;
  tab_id: string;
  name: string;
  content: string;
  format: string;
  every_ms: number | null;
  created_at: number;
  updated_at: number;
}

const FORMATS = new Set<CardFormat>(['text', 'markdown', 'html']);

function toCard(r: RawCard): ChatCard {
  return {
    id: r.id,
    tab_id: r.tab_id,
    name: r.name,
    content: r.content,
    // Anything unrecognised reads as `text`, which is the only format that
    // cannot misbehave: an html card from a newer writer rendering as its own
    // source is ugly and honest, where guessing markup would be neither.
    format: FORMATS.has(r.format as CardFormat) ? (r.format as CardFormat) : 'text',
    every_ms: r.every_ms,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

const COLUMNS = 'id, tab_id, name, content, format, every_ms, created_at, updated_at';

/**
 * Cards belonging to a chat — see shared/src/cards.ts for what they are.
 *
 * `set` is an UPSERT keyed on (tab_id, name), which is the whole point: a
 * writer calls it over and over with the same name and the card is updated in
 * place rather than a list being grown. The limits are enforced here rather
 * than at the route, so the CLI, the HTTP API and any future caller get the
 * same answer — a cap that only one door checks is not a cap.
 */
export class TabCardStore {
  constructor(private readonly db: Database.Database) {}

  set(w: CardWrite): CardWriteResult {
    const name = w.name.trim();
    if (!isValidCardName(name))
      return {
        ok: false,
        reason: 'card name must be 1–40 chars of letters, digits, _ . or -',
      };
    // Bytes, not characters: the cap exists to bound what crosses the wire and
    // sits in a pinned element, and one emoji is four of those.
    const bytes = Buffer.byteLength(w.content, 'utf8');
    if (bytes > CARD_MAX_BYTES)
      return {
        ok: false,
        reason: `card content is ${Math.round(bytes / 1024)}KB — the cap is ${CARD_MAX_BYTES / 1024}KB; publish a page instead`,
      };
    const at = w.at ?? Date.now();
    const existing = this.get(w.tabId, name);
    if (!existing && this.count(w.tabId) >= CARD_MAX_PER_TAB)
      return {
        ok: false,
        reason: `this chat already has ${CARD_MAX_PER_TAB} cards — clear one first`,
      };
    const format: CardFormat = w.format ?? existing?.format ?? 'text';
    if (existing) {
      this.db
        .prepare(
          `UPDATE tab_cards SET content = ?, format = ?, every_ms = ?, updated_at = ?
            WHERE id = ?`,
        )
        .run(
          w.content,
          format,
          // `undefined` means "leave it": a writer updating the content of a
          // card should not have to restate its cadence to keep it.
          w.everyMs === undefined ? existing.every_ms : w.everyMs,
          at,
          existing.id,
        );
    } else {
      this.db
        .prepare(`INSERT INTO tab_cards (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(ulid(), w.tabId, name, w.content, format, w.everyMs ?? null, at, at);
    }
    const card = this.get(w.tabId, name);
    return card
      ? { ok: true, card, created: !existing }
      : { ok: false, reason: 'card vanished immediately after write' };
  }

  get(tabId: string, name: string): ChatCard | null {
    const r = this.db
      .prepare(`SELECT ${COLUMNS} FROM tab_cards WHERE tab_id = ? AND name = ?`)
      .get(tabId, name) as RawCard | undefined;
    return r ? toCard(r) : null;
  }

  /** Every card in this chat, oldest first — the order they are pinned in. */
  list(tabId: string): ChatCard[] {
    const rows = this.db
      .prepare(`SELECT ${COLUMNS} FROM tab_cards WHERE tab_id = ? ORDER BY created_at ASC, id ASC`)
      .all(tabId) as RawCard[];
    return rows.map(toCard);
  }

  count(tabId: string): number {
    return (
      this.db.prepare('SELECT COUNT(*) AS n FROM tab_cards WHERE tab_id = ?').get(tabId) as {
        n: number;
      }
    ).n;
  }

  /** Remove one card. True if it existed. */
  clear(tabId: string, name: string): boolean {
    return (
      this.db.prepare('DELETE FROM tab_cards WHERE tab_id = ? AND name = ?').run(tabId, name)
        .changes > 0
    );
  }
}
