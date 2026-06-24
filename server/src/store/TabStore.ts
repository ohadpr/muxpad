import type Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { monotonicFactory } from 'ulid';
import { type LayoutNode, type Tab, randomTabIcon } from '@muxpad/shared';

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
  icon: string | null;
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
    icon?: string;
  }): Tab {
    const id = ulid();
    const slug = this.uniqueSlug();
    const now = Date.now();
    // New tabs get a random icon by default (the picker can change it).
    const icon = input.icon ?? randomTabIcon();
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
        'INSERT INTO tabs (id, slug, name, icon, layout, workspace_id, created_at, updated_at, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        id,
        slug,
        input.name,
        icon,
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
      icon,
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

  /**
   * Return the parent workspace_id for a tab. The shared `Tab` shape
   * doesn't surface workspace_id (it's a server-internal foreign key),
   * but route handlers + the WS upgrade path need it to inject
   * MUXPAD_WORKSPACE_ID into spawned shells and to scope tab-removed
   * events. Returns undefined for an unknown id.
   */
  getWorkspaceId(id: string): string | undefined {
    const row = this.db
      .prepare('SELECT workspace_id FROM tabs WHERE id = ?')
      .get(id) as { workspace_id: string } | undefined;
    return row?.workspace_id;
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
      icon?: string | undefined;
      layout?: LayoutNode | undefined;
    },
  ): Tab {
    const existing = this.getById(id);
    if (!existing) throw new Error(`tab ${id} not found`);
    const next = {
      name: patch.name ?? existing.name,
      slug: patch.slug ?? existing.slug,
      icon: patch.icon ?? existing.icon,
      layout: patch.layout ?? existing.layout,
    };
    const now = Date.now();
    this.db
      .prepare(
        'UPDATE tabs SET name = ?, slug = ?, icon = ?, layout = ?, updated_at = ? WHERE id = ?',
      )
      .run(next.name, next.slug, next.icon ?? null, JSON.stringify(next.layout), now, id);
    return { ...existing, ...next, updated_at: now };
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM tabs WHERE id = ?').run(id);
  }

  /**
   * Move a tab to a different workspace, dropping it at the end of the
   * target workspace's tab order. The tab's panes follow automatically
   * (they reference the tab, not the workspace). Throws if the tab or the
   * target workspace doesn't exist (the workspace_id FK enforces the latter).
   */
  setWorkspace(id: string, workspaceId: string): Tab {
    const existing = this.getById(id);
    if (!existing) throw new Error(`tab ${id} not found`);
    const maxPos =
      (
        this.db
          .prepare('SELECT COALESCE(MAX(position), -1) AS m FROM tabs WHERE workspace_id = ?')
          .get(workspaceId) as { m: number } | undefined
      )?.m ?? -1;
    const now = Date.now();
    this.db
      .prepare('UPDATE tabs SET workspace_id = ?, position = ?, updated_at = ? WHERE id = ?')
      .run(workspaceId, maxPos + 1, now, id);
    return { ...existing, updated_at: now };
  }

  /**
   * Manual "unread" flag — folded into the tab's attention dot alongside
   * the BEL-driven runtime attention. Set from the tab context menu,
   * cleared when the tab is next viewed (the /seen route). Best-effort:
   * a missing id is a silent no-op.
   */
  setUnread(id: string, unread: boolean): void {
    this.db.prepare('UPDATE tabs SET unread = ? WHERE id = ?').run(unread ? 1 : 0, id);
  }

  /**
   * Ids of the tabs in a workspace currently flagged unread, as one query
   * so the list/rollup routes can fold the flag without an N+1 of reads.
   */
  unreadIdsByWorkspace(workspaceId: string): Set<string> {
    const rows = this.db
      .prepare('SELECT id FROM tabs WHERE workspace_id = ? AND unread = 1')
      .all(workspaceId) as { id: string }[];
    return new Set(rows.map((r) => r.id));
  }

  private row(r: unknown): Tab | null {
    if (!r) return null;
    const x = r as TabRow;
    return {
      id: x.id,
      slug: x.slug,
      name: x.name,
      ...(x.icon ? { icon: x.icon } : {}),
      layout: JSON.parse(x.layout),
      created_at: x.created_at,
      updated_at: x.updated_at,
    };
  }
}
