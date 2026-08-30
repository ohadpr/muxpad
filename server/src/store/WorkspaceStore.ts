import type { Workspace } from '@muxpad/shared';
import type Database from 'better-sqlite3';
import { monotonicFactory } from 'ulid';
import { generateShortId } from './TabStore.js';

const ulid = monotonicFactory();

interface WorkspaceRow {
  id: string;
  slug: string;
  name: string;
  position: number;
  hidden: number;
  created_at: number;
  updated_at: number;
}

/**
 * CRUD for the new top-level workspace concept. Tabs belong to a workspace
 * via `tabs.workspace_id`; panes are still scoped to a tab (`panes.tab_id`).
 */
export class WorkspaceStore {
  constructor(private readonly db: Database.Database) {}

  /**
   * A workspace created through `create` is always VISIBLE — `hidden` is not a
   * parameter here, so no ordinary code path can strand a user's workspace
   * where no surface lists it. The one legitimate hidden container has its own
   * explicit door: {@link createHidden}.
   *
   * (History: the first hidden row was the retired resident-pane container,
   * and resident-release.ts exists to get rid of it. The read-side filters
   * stayed because a legacy DB can still hold one. The Hosted apps container
   * is the deliberate second — see createHidden.)
   */
  create(input: { name: string }): Workspace {
    return this.insert(input.name, false);
  }

  /**
   * Create a HIDDEN system container — a workspace excluded from `list()` and
   * therefore from the sidebar tree.
   *
   * The one caller is the app registry (apps/AppRegistry.ts). An app is a
   * supervised pane with no presence in the tab tree, and this is what "no
   * presence" is built from: a real workspace holding real tabs holding real
   * panes, so every existing mechanism (PaneRuntime env injection, the ptyd
   * lifecycle, `/p/:id` terminal attach, the serve supervisor's sweep) applies
   * unchanged — while `visibleWorkspaces()` keeps the whole container out of
   * the navigator.
   *
   * Named separately from `create` rather than added as a flag so that the
   * grep for "who can hide a workspace" stays a one-line answer.
   */
  createHidden(input: { name: string }): Workspace {
    return this.insert(input.name, true);
  }

  private insert(name: string, hidden: boolean): Workspace {
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
        'INSERT INTO workspaces (id, slug, name, position, hidden, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(id, slug, name, maxPos + 1, hidden ? 1 : 0, now, now);
    return {
      id,
      slug,
      name,
      position: maxPos + 1,
      hidden,
      created_at: now,
      updated_at: now,
      tab_count: 0,
    };
  }

  /**
   * All visible workspaces, ordered. Hidden system containers (e.g. the one
   * holding the retired resident pane) are excluded unless `opts.all` — they must never
   * appear in the sidebar tree.
   */
  list(opts?: { all?: boolean }): Workspace[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM workspaces ${opts?.all ? '' : 'WHERE hidden = 0 '}ORDER BY position ASC, created_at ASC, id ASC`,
      )
      .all() as WorkspaceRow[];
    return rows.map((r) => this.decorate(r));
  }

  getById(id: string): Workspace | null {
    const r = this.db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as
      | WorkspaceRow
      | undefined;
    return r ? this.decorate(r) : null;
  }

  getBySlug(slug: string): Workspace | null {
    const r = this.db.prepare('SELECT * FROM workspaces WHERE slug = ?').get(slug) as
      | WorkspaceRow
      | undefined;
    return r ? this.decorate(r) : null;
  }

  update(id: string, patch: { name?: string | undefined; slug?: string | undefined }): Workspace {
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
      hidden: !!r.hidden,
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
