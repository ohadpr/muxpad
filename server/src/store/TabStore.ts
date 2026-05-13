import type Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { monotonicFactory } from 'ulid';
import type { LayoutNode, Tab } from '@muxpad/shared';

const ulid = monotonicFactory();

// Short, opaque, stable URL key. 8 chars from a no-confusables alphabet
// (omits 0/O/1/l/I). 55^8 ≈ 8e13 combos, plenty for a personal install and
// large enough that random retries on collision are vanishingly rare.
const SHORT_ID_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ';

export function generateShortId(): string {
  const bytes = randomBytes(8);
  let id = '';
  for (let i = 0; i < 8; i++) {
    id += SHORT_ID_ALPHABET[bytes[i]! % SHORT_ID_ALPHABET.length];
  }
  return id;
}

interface TabRow {
  id: string;
  slug: string;
  name: string;
  layout: string;
  workspace_id: string;
  created_at: number;
  updated_at: number;
}

export class TabStore {
  constructor(private readonly db: Database.Database) {}

  create(input: {
    name: string;
    layout: LayoutNode;
    workspace_id: string;
  }): Tab {
    const id = ulid();
    const slug = this.uniqueSlug();
    const now = Date.now();
    const maxPos =
      (
        this.db
          .prepare(
            'SELECT COALESCE(MAX(position), -1) AS m FROM tabs WHERE workspace_id = ?',
          )
          .get(input.workspace_id) as { m: number } | undefined
      )?.m ?? -1;
    this.db
      .prepare(
        'INSERT INTO tabs (id, slug, name, layout, workspace_id, created_at, updated_at, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        id,
        slug,
        input.name,
        JSON.stringify(input.layout),
        input.workspace_id,
        now,
        now,
        maxPos + 1,
      );
    return {
      id,
      slug,
      name: input.name,
      layout: input.layout,
      created_at: now,
      updated_at: now,
    };
  }

  /** Replace tab ordering across the listed ids within a workspace. */
  reorder(ids: string[]): void {
    const update = this.db.prepare('UPDATE tabs SET position = ? WHERE id = ?');
    this.db.transaction(() => {
      ids.forEach((id, idx) => update.run(idx, id));
    })();
  }

  private uniqueSlug(): string {
    const exists = this.db.prepare('SELECT 1 FROM tabs WHERE slug = ?');
    for (let i = 0; i < 100; i++) {
      const candidate = generateShortId();
      if (!exists.get(candidate)) return candidate;
    }
    throw new Error('unable to allocate unique slug');
  }

  getById(id: string): Tab | null {
    return this.row(this.db.prepare('SELECT * FROM tabs WHERE id = ?').get(id));
  }

  getBySlug(slug: string): Tab | null {
    return this.row(this.db.prepare('SELECT * FROM tabs WHERE slug = ?').get(slug));
  }

  list(): Tab[] {
    const rows = this.db
      .prepare('SELECT * FROM tabs ORDER BY position ASC, created_at ASC, id ASC')
      .all() as TabRow[];
    return rows.map((r) => this.row(r) as Tab);
  }

  /** Tabs belonging to a specific workspace, in display order. */
  listByWorkspace(workspaceId: string): Tab[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM tabs WHERE workspace_id = ? ORDER BY position ASC, created_at ASC, id ASC',
      )
      .all(workspaceId) as TabRow[];
    return rows.map((r) => this.row(r) as Tab);
  }

  update(
    id: string,
    patch: {
      name?: string | undefined;
      slug?: string | undefined;
      layout?: LayoutNode | undefined;
    },
  ): Tab {
    const existing = this.getById(id);
    if (!existing) throw new Error(`tab ${id} not found`);
    const next = {
      name: patch.name ?? existing.name,
      slug: patch.slug ?? existing.slug,
      layout: patch.layout ?? existing.layout,
    };
    const now = Date.now();
    this.db
      .prepare(
        'UPDATE tabs SET name = ?, slug = ?, layout = ?, updated_at = ? WHERE id = ?',
      )
      .run(next.name, next.slug, JSON.stringify(next.layout), now, id);
    return { ...existing, ...next, updated_at: now };
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM tabs WHERE id = ?').run(id);
  }

  private row(r: unknown): Tab | null {
    if (!r) return null;
    const x = r as TabRow;
    return {
      id: x.id,
      slug: x.slug,
      name: x.name,
      layout: JSON.parse(x.layout),
      created_at: x.created_at,
      updated_at: x.updated_at,
    };
  }
}
