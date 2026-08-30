import { APP_SLUG_RE, type App } from '@muxpad/shared';
import type Database from 'better-sqlite3';
import { monotonicFactory } from 'ulid';

const ulid = monotonicFactory();

interface AppRow {
  id: string;
  slug: string;
  name: string;
  cwd: string;
  command: string;
  url: string;
  autostart: number;
  enabled: number;
  pane_id: string | null;
  created_at: number;
  updated_at: number;
}

/**
 * CRUD for the app registry (migration 23).
 *
 * PURE SQLITE, on purpose. Nothing here talks to ptyd, spawns anything, or
 * knows a pane exists beyond storing its id — materialising an app is the
 * registry's caller's job (apps/AppRegistry.ts). Keeping the store inert is
 * what lets the unit tests drive every row transition without a daemon, and
 * what keeps "the row says running" from ever being mistaken for evidence.
 */
export class AppStore {
  constructor(private readonly db: Database.Database) {}

  /**
   * Derive a slug from a name: lowercase, non-alphanumerics to '-', collapsed,
   * trimmed to 64. Returns '' when nothing usable survives (e.g. a name that
   * is entirely emoji), which callers must treat as "ask for one explicitly".
   */
  static slugify(name: string): string {
    const s = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64)
      .replace(/-+$/, '');
    return APP_SLUG_RE.test(s) ? s : '';
  }

  /** `base`, or `base-2`, `base-3`… — the first that isn't taken. */
  uniqueSlug(base: string): string {
    if (!this.getBySlug(base)) return base;
    for (let i = 2; i < 1000; i++) {
      // Keep the suffix inside the 64-char grammar rather than overflowing it.
      const suffix = `-${i}`;
      const candidate = `${base.slice(0, 64 - suffix.length)}${suffix}`;
      if (!this.getBySlug(candidate)) return candidate;
    }
    throw new Error('unable to allocate unique app slug');
  }

  create(input: {
    slug: string;
    name: string;
    cwd: string;
    command: string;
    url: string;
    autostart?: boolean;
    enabled?: boolean;
  }): App {
    const id = ulid();
    const now = Date.now();
    const autostart = input.autostart ?? true;
    const enabled = input.enabled ?? true;
    this.db
      .prepare(
        'INSERT INTO apps (id, slug, name, cwd, command, url, autostart, enabled, pane_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)',
      )
      .run(
        id,
        input.slug,
        input.name,
        input.cwd,
        input.command,
        input.url,
        autostart ? 1 : 0,
        enabled ? 1 : 0,
        now,
        now,
      );
    return {
      id,
      slug: input.slug,
      name: input.name,
      cwd: input.cwd,
      command: input.command,
      url: input.url,
      autostart,
      enabled,
      pane_id: null,
      created_at: now,
      updated_at: now,
    };
  }

  list(): App[] {
    const rows = this.db
      .prepare('SELECT * FROM apps ORDER BY created_at ASC, id ASC')
      .all() as AppRow[];
    return rows.map(row);
  }

  getById(id: string): App | null {
    const r = this.db.prepare('SELECT * FROM apps WHERE id = ?').get(id) as AppRow | undefined;
    return r ? row(r) : null;
  }

  getBySlug(slug: string): App | null {
    const r = this.db.prepare('SELECT * FROM apps WHERE slug = ?').get(slug) as AppRow | undefined;
    return r ? row(r) : null;
  }

  /** The app that owns a pane, if any. Used to keep a pane deletion from
   *  leaving a registry row pointing at nothing. */
  getByPane(paneId: string): App | null {
    const r = this.db.prepare('SELECT * FROM apps WHERE pane_id = ?').get(paneId) as
      | AppRow
      | undefined;
    return r ? row(r) : null;
  }

  /** Resolve a CLI/route reference: exact id, else exact slug. */
  resolve(ref: string): App | null {
    return this.getById(ref) ?? this.getBySlug(ref);
  }

  update(
    id: string,
    patch: {
      name?: string;
      cwd?: string;
      command?: string;
      url?: string;
      autostart?: boolean;
      enabled?: boolean;
    },
  ): App | null {
    const existing = this.getById(id);
    if (!existing) return null;
    const next: App = {
      ...existing,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.cwd !== undefined ? { cwd: patch.cwd } : {}),
      ...(patch.command !== undefined ? { command: patch.command } : {}),
      ...(patch.url !== undefined ? { url: patch.url } : {}),
      ...(patch.autostart !== undefined ? { autostart: patch.autostart } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      updated_at: Date.now(),
    };
    this.db
      .prepare(
        'UPDATE apps SET name = ?, cwd = ?, command = ?, url = ?, autostart = ?, enabled = ?, updated_at = ? WHERE id = ?',
      )
      .run(
        next.name,
        next.cwd,
        next.command,
        next.url,
        next.autostart ? 1 : 0,
        next.enabled ? 1 : 0,
        next.updated_at,
        id,
      );
    return next;
  }

  /**
   * Point the app at its supervised pane (or clear it).
   *
   * Clearing happens on stop and when the pane is found missing; the registry
   * row itself is never touched by a pane deletion, which is exactly why there
   * is no FK on this column — losing the pty must not lose the definition.
   */
  setPane(id: string, paneId: string | null): void {
    this.db
      .prepare('UPDATE apps SET pane_id = ?, updated_at = ? WHERE id = ?')
      .run(paneId, Date.now(), id);
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM apps WHERE id = ?').run(id);
  }

  /**
   * Pane ids currently claimed by a DISABLED app. The serve supervisor
   * subtracts these from its sweep: a user who pressed Stop must not have the
   * supervisor helpfully bring the app back two seconds later.
   */
  disabledPaneIds(): string[] {
    const rows = this.db
      .prepare('SELECT pane_id FROM apps WHERE enabled = 0 AND pane_id IS NOT NULL')
      .all() as Array<{ pane_id: string }>;
    return rows.map((r) => r.pane_id);
  }
}

function row(r: AppRow): App {
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    cwd: r.cwd,
    command: r.command,
    url: r.url,
    autostart: !!r.autostart,
    enabled: !!r.enabled,
    pane_id: r.pane_id ?? null,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}
