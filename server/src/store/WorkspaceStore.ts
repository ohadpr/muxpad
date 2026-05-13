import type Database from 'better-sqlite3';
import { monotonicFactory } from 'ulid';
import { generateShortId } from './TabStore.js';
import type { Workspace } from '@muxpad/shared';

const ulid = monotonicFactory();

interface WorkspaceRow {
  id: string;
  slug: string;
  name: string;
  position: number;
  created_at: number;
  updated_at: number;
}

/**
 * CRUD for the new top-level workspace concept. Tabs belong to a workspace
 * via `tabs.workspace_id`; panes are still scoped to a tab (`panes.tab_id`).
 */
export class WorkspaceStore {
  constructor(private readonly db: Database.Database) {}

  create(input: { name: string }): Workspace {
    const id = ulid();
    const slug = this.uniqueSlug();
    const now = Date.now();
    const maxPos =
      (
        this.db
          .prepare('SELECT COALESCE(MAX(position), -1) AS m FROM workspaces')
          .get() as { m: number } | undefined
      )?.m ?? -1;
    this.db
      .prepare(
        'INSERT INTO workspaces (id, slug, name, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(id, slug, input.name, maxPos + 1, now, now);
    return {
      id,
      slug,
      name: input.name,
      position: maxPos + 1,
      created_at: now,
      updated_at: now,
      tab_count: 0,
    };
  }

  list(): Workspace[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM workspaces ORDER BY position ASC, created_at ASC, id ASC',
      )
      .all() as WorkspaceRow[];
    return rows.map((r) => this.decorate(r));
  }

  getById(id: string): Workspace | null {
    const r = this.db
      .prepare('SELECT * FROM workspaces WHERE id = ?')
      .get(id) as WorkspaceRow | undefined;
    return r ? this.decorate(r) : null;
  }

  getBySlug(slug: string): Workspace | null {
    const r = this.db
      .prepare('SELECT * FROM workspaces WHERE slug = ?')
      .get(slug) as WorkspaceRow | undefined;
    return r ? this.decorate(r) : null;
  }

  update(
    id: string,
    patch: { name?: string | undefined; slug?: string | undefined },
  ): Workspace {
    const existing = this.getById(id);
    if (!existing) throw new Error(`workspace ${id} not found`);
    const name = patch.name ?? existing.name;
    const slug = patch.slug ?? existing.slug;
    const now = Date.now();
    this.db
      .prepare('UPDATE workspaces SET name = ?, slug = ?, updated_at = ? WHERE id = ?')
      .run(name, slug, now, id);
    return { ...existing, name, slug, updated_at: now };
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM workspaces WHERE id = ?').run(id);
  }

  reorder(ids: string[]): void {
    const update = this.db.prepare('UPDATE workspaces SET position = ? WHERE id = ?');
    this.db.transaction(() => {
      ids.forEach((id, idx) => update.run(idx, id));
    })();
  }

  /** Number of tabs that belong to a workspace. Used by the auto-close-empty UX. */
  tabCount(workspaceId: string): number {
    const r = this.db
      .prepare('SELECT COUNT(*) as n FROM tabs WHERE workspace_id = ?')
      .get(workspaceId) as { n: number };
    return r.n;
  }

  private decorate(r: WorkspaceRow): Workspace {
    return {
      id: r.id,
      slug: r.slug,
      name: r.name,
      position: r.position,
      created_at: r.created_at,
      updated_at: r.updated_at,
      tab_count: this.tabCount(r.id),
    };
  }

  private uniqueSlug(): string {
    const exists = this.db.prepare('SELECT 1 FROM workspaces WHERE slug = ?');
    for (let i = 0; i < 100; i++) {
      const candidate = generateShortId();
      if (!exists.get(candidate)) return candidate;
    }
    throw new Error('unable to allocate unique slug');
  }
}
