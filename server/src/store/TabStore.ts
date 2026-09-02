import { randomBytes } from 'node:crypto';
import type { LayoutNode, Tab } from '@muxpad/shared';
import type Database from 'better-sqlite3';
import { monotonicFactory } from 'ulid';

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
  view_mode: string;
  workspace_id: string;
  pinned: number;
  last_activity_at: number | null;
  headline: string | null;
  headline_at: number | null;
  name_sticky: number;
  icon_sticky: number;
  icon_at: number | null;
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
    // A new tab has NO icon, and the rail renders DEFAULT_TAB_ICON until it
    // gets one. This used to be `randomTabIcon()`, which was worse than
    // meaningless: an icon nobody chose is what the generator reads as "this
    // tab already has one, hands off", so a random default did not merely fail
    // to describe the tab — it permanently prevented anything from describing
    // it. The icon now arrives from the chat's own subject (chat/headline.ts)
    // or from the picker, and both of those are better than a dice roll.
    const icon = input.icon ?? null;
    const maxPos =
      (
        this.db
          .prepare('SELECT COALESCE(MAX(position), -1) AS m FROM tabs WHERE workspace_id = ?')
          .get(input.workspace_id) as { m: number } | undefined
      )?.m ?? -1;
    // NEW tabs default to the tabbed presentation: a tab is primarily "one
    // full-size pane" (more panes appear as sub-tabs in the header strip),
    // with the bsplit mosaic available via the per-tab split toggle.
    // Existing rows keep whatever they have (their stored value / the
    // column's 'split' default) — this changes the default going forward
    // only.
    const view_mode = 'tabbed' as const;
    this.db
      .prepare(
        'INSERT INTO tabs (id, slug, name, icon, layout, workspace_id, view_mode, created_at, updated_at, position, last_activity_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        id,
        slug,
        input.name,
        icon,
        JSON.stringify(input.layout),
        input.workspace_id,
        view_mode,
        now,
        now,
        maxPos + 1,
        now,
      );
    return {
      id,
      slug,
      name: input.name,
      // Same rule as `row()`: absent, not null. A tab with no icon adds
      // nothing to the payload and nothing to the client's change-dedup
      // signature.
      ...(icon ? { icon } : {}),
      layout: input.layout,
      view_mode,
      pinned: false,
      // A brand-new tab has had nothing happen in it yet — but it IS the most
      // recent thing the user did, and sorting it last (null = never) would
      // bury a just-created tab at the bottom of its workspace. Stamp it.
      last_activity_at: now,
      created_at: now,
      updated_at: now,
    };
  }

  /**
   * Replace tab ordering across the listed ids within a workspace. Only the
   * PINNED block is manually ordered in the sidebar (unpinned tabs are
   * auto-sorted at read time), so in practice `ids` is the pinned set — but
   * `position` is still written for every id passed, and remains the final
   * deterministic tiebreak for unpinned tabs.
   */
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
    const row = this.db.prepare('SELECT workspace_id FROM tabs WHERE id = ?').get(id) as
      | { workspace_id: string }
      | undefined;
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
      view_mode?: 'split' | 'tabbed' | undefined;
    },
  ): Tab {
    const existing = this.getById(id);
    if (!existing) throw new Error(`tab ${id} not found`);
    const next = {
      name: patch.name ?? existing.name,
      slug: patch.slug ?? existing.slug,
      icon: patch.icon ?? existing.icon,
      layout: patch.layout ?? existing.layout,
      view_mode: patch.view_mode ?? existing.view_mode ?? 'split',
    };
    const now = Date.now();
    this.db
      .prepare(
        'UPDATE tabs SET name = ?, slug = ?, icon = ?, layout = ?, view_mode = ?, updated_at = ? WHERE id = ?',
      )
      .run(
        next.name,
        next.slug,
        next.icon ?? null,
        JSON.stringify(next.layout),
        next.view_mode,
        now,
        id,
      );
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
   * Is this ONE tab manually flagged unread? A dedicated read because `row()`
   * deliberately doesn't hydrate the flag onto `Tab` (the list routes compute
   * the rolled-up `unread` themselves, and a half-populated field on getById
   * would be a trap — it silently reads `undefined`, which is exactly how the
   * per-pane /seen route's tab-clearing check failed the first time).
   */
  isUnread(id: string): boolean {
    const row = this.db.prepare('SELECT unread FROM tabs WHERE id = ?').get(id) as
      | { unread: number }
      | undefined;
    return !!row?.unread;
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

  /**
   * Pin (or unpin) a tab. Pinned tabs hold the top of their workspace's
   * sidebar block in the user's manual drag order; unpinned tabs below the
   * divider are auto-sorted by blocked/attention → recency (busy was dropped
   * from the sort: a working tab is not more urgent than a recent one, and
   * churning the order under a spinner made the list unreadable). Pinning is
   * therefore the way to opt a tab OUT of the shuffling. Best-effort: a
   * missing id is a silent no-op (same contract as setUnread).
   */
  setPinned(id: string, pinned: boolean): void {
    this.db.prepare('UPDATE tabs SET pinned = ? WHERE id = ?').run(pinned ? 1 : 0, id);
  }

  /**
   * Stamp the tab's last-activity time. Deliberately NOT touching
   * `updated_at`: that tracks structural edits (name/layout/icon) and clients
   * key cache invalidation off it — an every-minute pty bump would churn it.
   * Callers throttle (see tab-activity.ts); this is the raw write.
   */
  touchActivity(id: string, at: number = Date.now()): void {
    this.db.prepare('UPDATE tabs SET last_activity_at = ? WHERE id = ?').run(at, id);
  }

  /**
   * Write the nav row's second line, stamping the rate limiter's clock in the
   * same statement so the two can never disagree.
   *
   * Its own method rather than a field on `update()` for the reason
   * `touchActivity` is: `update()` bumps `updated_at`, which clients key cache
   * invalidation off, and a headline is not a structural edit to the tab.
   */
  setHeadline(id: string, headline: string, at: number = Date.now()): void {
    this.db
      .prepare('UPDATE tabs SET headline = ?, headline_at = ? WHERE id = ?')
      .run(headline, at, id);
  }

  /**
   * Advance the headline rate limiter WITHOUT writing a line.
   *
   * The clock must move on every ATTEMPT, not every success — otherwise a
   * chat that keeps coming back "unchanged", and more importantly one whose
   * model call keeps FAILING, is retried on every finished turn forever. The
   * expensive thing is the call, so the call is what the limiter counts.
   */
  touchHeadlineAt(id: string, at: number = Date.now()): void {
    this.db.prepare('UPDATE tabs SET headline_at = ? WHERE id = ?').run(at, id);
  }

  /** When this tab's headline was last written; null if never. */
  headlineAt(id: string): number | null {
    const r = this.db.prepare('SELECT headline_at FROM tabs WHERE id = ?').get(id) as
      | { headline_at: number | null }
      | undefined;
    return r?.headline_at ?? null;
  }

  /**
   * "The user named this one." One-way by design: there is no unset. A tab
   * you have deliberately named should never be renamed out from under you,
   * and no plausible flow wants to hand that authority back to the machine.
   */
  setNameSticky(id: string): void {
    this.db.prepare('UPDATE tabs SET name_sticky = 1 WHERE id = ?').run(id);
  }

  isNameSticky(id: string): boolean {
    const r = this.db.prepare('SELECT name_sticky FROM tabs WHERE id = ?').get(id) as
      | { name_sticky: number }
      | undefined;
    return !!r?.name_sticky;
  }

  /**
   * "The user chose this glyph." One-way, like `setNameSticky`, and for a
   * sharper version of the same reason: the icon is how a row is found by
   * shape, so an icon you deliberately picked changing under you is worse than
   * a name doing it. There is no unset.
   *
   * Its own flag rather than a second meaning for `name_sticky`: renaming a
   * tab and choosing its glyph are separate acts, and doing one should not
   * silently freeze the other.
   */
  setIconSticky(id: string): void {
    this.db.prepare('UPDATE tabs SET icon_sticky = 1 WHERE id = ?').run(id);
  }

  isIconSticky(id: string): boolean {
    const r = this.db.prepare('SELECT icon_sticky FROM tabs WHERE id = ?').get(id) as
      | { icon_sticky: number }
      | undefined;
    return !!r?.icon_sticky;
  }

  /**
   * Write a GENERATED icon, stamping the anti-drift clock in the same
   * statement so the two can never disagree.
   *
   * Deliberately not `update()`: that bumps `updated_at`, which clients key
   * cache invalidation off, and it would also have to be told not to set the
   * sticky flag. Same split, and the same reasoning, as `setHeadline`.
   *
   * Callers must have checked `isIconSticky` first — this method does not,
   * because a store method that silently no-ops is a worse contract than one
   * whose single caller is responsible for the policy (see chat/headline.ts,
   * where the whole anti-drift rule lives in one place).
   */
  setIcon(id: string, icon: string, at: number = Date.now()): void {
    this.db.prepare('UPDATE tabs SET icon = ?, icon_at = ? WHERE id = ?').run(icon, at, id);
  }

  /**
   * When this tab's icon was last written by the generator; null if it never
   * was — which also means the icon it currently wears (if any) did not come
   * from us and must be left alone.
   */
  iconAt(id: string): number | null {
    const r = this.db.prepare('SELECT icon_at FROM tabs WHERE id = ?').get(id) as
      | { icon_at: number | null }
      | undefined;
    return r?.icon_at ?? null;
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
      view_mode: x.view_mode === 'tabbed' ? 'tabbed' : 'split',
      pinned: !!x.pinned,
      // Null (never observed) is a real state and stays null — see the
      // migration note; the ordering sinks nulls rather than faking a time.
      last_activity_at: x.last_activity_at ?? null,
      // Same rule: null means "never summarised", which is permanent for any
      // tab without an agent session. Only present when non-null, so a chat
      // that has no headline adds nothing to the payload — and nothing to the
      // client's change-dedup signature.
      ...(x.headline ? { headline: x.headline } : {}),
      ...(x.name_sticky ? { name_sticky: true } : {}),
      // `icon_sticky` is deliberately NOT surfaced. Nothing on the client
      // branches on it — the picker sets it as a side effect of PATCHing an
      // icon, and the rail renders whatever glyph it is handed — so adding it
      // would only widen the payload and the change-dedup signature for a
      // field no renderer reads.
      created_at: x.created_at,
      updated_at: x.updated_at,
    };
  }
}
