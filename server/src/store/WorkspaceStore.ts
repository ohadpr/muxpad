import type Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { monotonicFactory } from 'ulid';
import type { LayoutNode, Workspace } from '@muxpad/shared';

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

interface WorkspaceRow {
  id: string;
  slug: string;
  name: string;
  layout: string;
  created_at: number;
  updated_at: number;
}

export class WorkspaceStore {
  constructor(private readonly db: Database.Database) {}

  create(input: { name: string; layout: LayoutNode }): Workspace {
    const id = ulid();
    const slug = this.uniqueSlug();
    const now = Date.now();
    const maxPos =
      (
        this.db.prepare('SELECT COALESCE(MAX(position), -1) AS m FROM workspaces').get() as
          | { m: number }
          | undefined
      )?.m ?? -1;
    this.db
      .prepare(
        'INSERT INTO workspaces (id, slug, name, layout, created_at, updated_at, position) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(id, slug, input.name, JSON.stringify(input.layout), now, now, maxPos + 1);
    return {
      id,
      slug,
      name: input.name,
      layout: input.layout,
      created_at: now,
      updated_at: now,
    };
  }

  /** Replace ordering across the listed ids; missing ids stay where they are. */
  reorder(ids: string[]): void {
    const update = this.db.prepare('UPDATE workspaces SET position = ? WHERE id = ?');
    this.db.transaction(() => {
      ids.forEach((id, idx) => update.run(idx, id));
    })();
  }

  private uniqueSlug(): string {
    const exists = this.db.prepare('SELECT 1 FROM workspaces WHERE slug = ?');
    for (let i = 0; i < 100; i++) {
      const candidate = generateShortId();
      if (!exists.get(candidate)) return candidate;
    }
    throw new Error('unable to allocate unique slug');
  }

  getById(id: string): Workspace | null {
    return this.row(this.db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id));
  }

  getBySlug(slug: string): Workspace | null {
    return this.row(this.db.prepare('SELECT * FROM workspaces WHERE slug = ?').get(slug));
  }

  list(): Workspace[] {
    const rows = this.db
      .prepare('SELECT * FROM workspaces ORDER BY position ASC, created_at ASC, id ASC')
      .all() as WorkspaceRow[];
    return rows.map((r) => this.row(r) as Workspace);
  }

  update(
    id: string,
    patch: {
      name?: string | undefined;
      slug?: string | undefined;
      layout?: LayoutNode | undefined;
    },
  ): Workspace {
    const existing = this.getById(id);
    if (!existing) throw new Error(`workspace ${id} not found`);
    const next = {
      name: patch.name ?? existing.name,
      slug: patch.slug ?? existing.slug,
      layout: patch.layout ?? existing.layout,
    };
    const now = Date.now();
    this.db
      .prepare(
        'UPDATE workspaces SET name = ?, slug = ?, layout = ?, updated_at = ? WHERE id = ?',
      )
      .run(next.name, next.slug, JSON.stringify(next.layout), now, id);
    return { ...existing, ...next, updated_at: now };
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM workspaces WHERE id = ?').run(id);
  }

  private row(r: unknown): Workspace | null {
    if (!r) return null;
    const x = r as WorkspaceRow;
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
