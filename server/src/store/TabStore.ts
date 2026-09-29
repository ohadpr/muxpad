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
  last_user_at: number | null;
  headline: string | null;
  headline_at: number | null;
  name_sticky: number;
  icon_sticky: number;
  icon_at: number | null;
  spawned_by: string | null;
  clock_started_at: number | null;
  retired_at: number | null;
  retired_reason: string | null;
  spawn_task: string | null;
  spawn_artifacts: string | null;
  spawn_report: string | null;
  spawn_report_at: number | null;
  spawn_report_state: string | null;
  created_at: number;
  updated_at: number;
}

/**
 * Why a chat left the live list by an ACT rather than by the clock.
 * `decayed` is never stored — it is what the clock says.
 *
 * `died` — ITS RUNNER WAS GIVEN UP ON, and the work is INCOMPLETE. A third
 * reason rather than a flavour of `delivered`, for the reason 3af1ba2 split
 * `awaiting` off: a worker that finished its job and one that was killed
 * mid-sentence both stop existing, and they mean opposite things to the person
 * who spawned them. Filing the second as `delivered` is how three jobs vanish
 * quietly — which is exactly what happened (new-chat-fix, xws-build,
 * artifact-urls, all hand-archived hours later).
 *
 * Only the dead-runner sweep's GIVE-UP writes it (see tab-retire.ts
 * `onRunnerDead`), never a pane that merely looks dead for a moment.
 */
export type RetireReason = 'delivered' | 'archived' | 'died';

/**
 * What KIND of spawn report a child's row carries.
 *
 * Outcomes that must not read as one shrug (see the v29 migration):
 * `ok` we wrote one, `none` the child produced nothing and says so, `crashed`
 * its last turn was fatal, `awaiting` it stopped to ask.
 *
 * `failed` — WE TRIED AND LOST IT. This used to be the ABSENCE of the column,
 * "deliberately: nothing renders for it", and that was wrong in the one case it
 * mattered. Absence also means NOT ATTEMPTED YET, so the two were one value and
 * the card drew the same line for both: a worker whose summary a length rule
 * threw away looked exactly like one the generator had not reached. The only
 * record of the difference was a `[spawn-report] rejected` line in server.log,
 * which is not a place a user looks.
 *
 * Now absence means only "not attempted", `failed` is attempted-and-lost, and
 * the boot sweep in SpawnReportWriter retries the second one.
 */
export type SpawnReportState = 'ok' | 'none' | 'crashed' | 'awaiting' | 'failed';

/** A generated report, as it is written. `report` is null for a state that
 *  stands on its own (`none`, and a `crashed` child that got nothing done). */
export interface SpawnReportWrite {
  report: string | null;
  state: SpawnReportState;
  /** Urls and files this worker produced, scraped from its transcript. Written
   *  with the report because it is read on the same pass — but it is NOT the
   *  model's output, and it survives a generation the model got wrong. */
  artifacts?: string[] | undefined;
}

/**
 * ONE projection, used by both the list read and the single-row read, so the
 * two paths cannot come to different conclusions about the same tab.
 *
 * `has_agent` is the question "is there anything in here you could send a
 * message TO" — see {@link TabClockRow.has_agent}. `startup_cmd LIKE 'muxpad
 * agent%'` is the same durable ownership marker {@link
 * TabStore.prototype.listAgentPanes}'s sibling in PaneStore uses; it survives
 * a ptyd restart, a reboot, and a dead runner, which a live-registry answer
 * would not.
 */
const CLOCK_COLUMNS = `tabs.id, tabs.spawned_by, tabs.pinned, tabs.clock_started_at,
    tabs.retired_at, tabs.retired_reason,
    EXISTS (SELECT 1 FROM panes p
             WHERE p.tab_id = tabs.id AND p.startup_cmd LIKE 'muxpad agent%') AS has_agent`;

interface RawClockRow {
  id: string;
  spawned_by: string | null;
  pinned: number;
  clock_started_at: number | null;
  retired_at: number | null;
  retired_reason: string | null;
  has_agent: number;
}

function toClockRow(r: RawClockRow): TabClockRow {
  return {
    id: r.id,
    spawned_by: r.spawned_by,
    pinned: !!r.pinned,
    clock_started_at: r.clock_started_at,
    retired_at: r.retired_at,
    // Anything unrecognised reads as a hand archive: it is the conservative
    // one (it claims only that a person did this), and the alternative would
    // be a row that is retired for no stated reason at all.
    //
    // EVERY REASON MUST BE LISTED HERE. The fallback is not a pass-through —
    // it REWRITES — so a reason the database holds and this switch has not
    // learnt is published as `archived`, i.e. "a person did this", about a
    // machine event nobody performed. `died` in particular would be laundered
    // into the very state it exists to be distinguishable from.
    retired_reason:
      r.retired_at === null
        ? null
        : r.retired_reason === 'delivered'
          ? 'delivered'
          : r.retired_reason === 'died'
            ? 'died'
            : 'archived',
    has_agent: !!r.has_agent,
  };
}

/** Everything a chat's lifecycle is resolved from, for every tab at once.
 *  See {@link TabStore.clockRows} and server/src/tab-clock.ts. */
export interface TabClockRow {
  id: string;
  spawned_by: string | null;
  pinned: boolean;
  clock_started_at: number | null;
  retired_at: number | null;
  retired_reason: RetireReason | null;
  /**
   * Is there an AGENT in this tab — something a message could be sent to?
   *
   * The decay clock's only exit is "send it a message", and a terminal or a
   * web view has no inbox: `noteUserMessage` has exactly one production caller
   * (ws.ts `submitSend`), which runs for runner-owned agent panes and nothing
   * else. A tab without one that decays is not resting, it is gone — see
   * tab-clock.ts.
   */
  has_agent: boolean;
}

/** The stored JSON array, or [] for anything unparseable. */
function parseArtifacts(raw: string): string[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export class TabStore {
  constructor(private readonly db: Database.Database) {}

  create(input: {
    name: string;
    layout: LayoutNode;
    workspace_id: string;
    icon?: string;
    /** The tab this chat was spawned FROM, when something running in another
     *  chat asked for it. Not validated here — the caller resolves it (see
     *  routes/tabs.ts), and a dangling id is a tolerated state by design. */
    spawned_by?: string | null;
  }): Tab {
    const id = ulid();
    const slug = this.uniqueSlug();
    const now = Date.now();
    // A new tab has NO icon, and the rail renders `fallbackTabIcon(tab.id)`
    // until it gets one — derived from the id, so it is stable per row and
    // mostly distinct across rows, and stored nowhere. (NOT `DEFAULT_TAB_ICON`,
    // which is one constant glyph and would turn the icon column into an
    // undifferentiated stripe.)
    //
    // This used to be `randomTabIcon()`, which was worse than
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
    const spawned_by = input.spawned_by ?? null;
    this.db
      .prepare(
        'INSERT INTO tabs (id, slug, name, icon, layout, workspace_id, view_mode, created_at, updated_at, position, last_activity_at, spawned_by, clock_started_at, last_user_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
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
        spawned_by,
        // Every chat is born with a full clock, INCLUDING a sub-chat — whose
        // column is then ignored for as long as its parent exists, because a
        // sub-chat does not decay at all (it retires when it delivers).
        // Stamping it anyway costs nothing and means a sub-chat ORPHANED by
        // its parent's deletion — which does become an ordinary decaying chat
        // — falls back to a real timestamp instead of a null nobody can
        // interpret.
        now,
        // `last_user_at`: making a chat IS a user touch, and it is the one the
        // global recency list ranks a brand-new chat by until the first message
        // lands. A chat spawned by an agent is stamped too — it appeared
        // because of something you set in motion, it appears ONCE (unlike an
        // output bump), and it nests under its parent anyway, so its own key
        // decides nothing on screen.
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
      last_user_at: now,
      // Same rule as `icon`/`headline`: absent, not null, when there is no
      // parent — so the overwhelmingly common case adds nothing to the payload
      // or to the client's change-dedup signature.
      ...(spawned_by ? { spawned_by } : {}),
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

  /**
   * Delete a tab — and START THE CLOCK on every child it orphans.
   *
   * There is no foreign key, deliberately (see migrations v27), so a child
   * survives its parent's deletion. What it survives AS changes, though: while
   * the parent existed it was a sub-chat, which has no clock and cannot decay;
   * the moment the parent is gone it is a root, and the clock it inherits is
   * `clock_started_at` — stamped at its BIRTH, and never once read since,
   * because a sub-chat's clock is not consulted.
   *
   * So a worker born ten days ago is `done: 'decayed'` the instant its parent
   * is deleted, still mid-job, with a full tile. That is not a rare shape.
   * `cron --new-tab` with `close_when_done` cascades the tab away on every
   * clean fire, and every pane carries MUXPAD_PANE_ID, so any agent that runs
   * `muxpad agent new` inside a cron-created tab leaves an orphan behind
   * minutes later. Even a young orphan inherits a PARTIAL clock it never had a
   * chance to reset.
   *
   * Promotion is an event, so it gets a clock the way every other promotion
   * into the live list does: fresh, from now. The chat has never had a clock
   * before this moment; starting it anywhere but now is claiming to know
   * something about a timer that was not running.
   *
   * Here rather than in `deleteTabCascade` because this is not the only door:
   * the workspace delete loops over tabs, and AppRegistry drops a tab whose
   * last pane went away. Three hand-written copies of the same rule is how two
   * of them end up disagreeing.
   */
  delete(id: string, at: number = Date.now()): void {
    this.db.transaction(() => {
      this.db.prepare('UPDATE tabs SET clock_started_at = ? WHERE spawned_by = ?').run(at, id);
      this.db.prepare('DELETE FROM tabs WHERE id = ?').run(id);
    })();
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
   * Restart this tab's decay clock. The raw write; the revival it is half of
   * lives in tab-clock.ts (`reviveChat`, which also clears any retirement —
   * a chat handed back onto an expired clock would be done again on the next
   * read).
   *
   * Harmless on a sub-chat, which has no clock: the column is written and
   * simply not read while the parent exists. It becomes meaningful again if
   * that parent is ever deleted.
   *
   * Deliberately not touching `updated_at`, for the same reason
   * `touchActivity` doesn't: that column tracks structural edits and clients
   * key cache invalidation off it.
   */
  resetClock(id: string, at: number = Date.now()): void {
    // `last_user_at` rides along in the SAME statement, and that is the whole
    // design of the column rather than a convenience. Its promise is "the last
    // act by the USER", and the acts that restart the decay clock are exactly
    // that set — v27 chose them for the same reason ("it measures your
    // attention rather than the machine's"). Writing it here makes the two
    // agree by construction: there is no second call site to forget, and no way
    // for the recency order and the clock to end up disagreeing about when you
    // were last here.
    //
    // Note what this does NOT catch, deliberately: `delete()` starts an
    // orphan's clock with its own UPDATE, because promoting a sub-chat to a
    // root is something the parent's deletion did, not something the user did
    // to the child.
    this.db
      .prepare('UPDATE tabs SET clock_started_at = ?, last_user_at = ? WHERE id = ?')
      .run(at, at, id);
  }

  /**
   * Every tab's lifecycle inputs, in ONE query.
   *
   * Resolving a single row needs another row — whether its `spawned_by`
   * parent still EXISTS is what decides between "a sub-chat, which retires on
   * delivery" and "a root, which decays" — and `decorateTab` runs per row on a
   * 5s sidebar poll, so a per-row lookup would be the hottest thing in the
   * app. The table is tens of rows on a real install, which makes reading all
   * of it once cheaper than the index lookups a smarter query would do.
   *
   * GLOBAL rather than per-workspace on purpose: a chat can be spawned from a
   * chat in ANOTHER workspace (a worker dropped into a project workspace, say),
   * and a workspace-scoped read would not find that parent — silently
   * promoting a live sub-chat to a decaying root.
   */
  clockRows(): TabClockRow[] {
    const rows = this.db.prepare(`SELECT ${CLOCK_COLUMNS} FROM tabs`).all() as RawClockRow[];
    return rows.map(toClockRow);
  }

  /**
   * ONE tab's lifecycle inputs.
   *
   * The counterpart to {@link clockRows}, and the reason both exist: a LIST
   * resolves every row and wants the whole table once, but a single
   * `tab.updated` — which fires on every rename, every turn, every activity
   * bump — wants one row, not thirty.
   *
   * Reading the whole table for a single decoration measurably cost: it more
   * than doubled `decorateTab` (296µs → 706µs on a 30-tab database) and pushed
   * the slower integration tests past their timeout. The list path is
   * unaffected because it pre-reads the index once and passes it down; this is
   * for everything else.
   */
  clockRow(id: string): TabClockRow | null {
    const r = this.db.prepare(`SELECT ${CLOCK_COLUMNS} FROM tabs WHERE tabs.id = ?`).get(id) as
      | RawClockRow
      | undefined;
    return r ? toClockRow(r) : null;
  }

  /**
   * The lifecycle inputs of every chat spawned DIRECTLY under `id`.
   *
   * The third member of the {@link clockRows} / {@link clockRow} family, for the
   * one question a single row cannot answer about itself: how much work it
   * started that is still running (see tab-clock.ts `tabLiveChildCount`). Goes
   * through the `tabs_spawned_by` index, so it stays a lookup rather than a
   * scan on the hot single-row decoration path.
   */
  childClockRows(id: string): TabClockRow[] {
    const rows = this.db
      .prepare(`SELECT ${CLOCK_COLUMNS} FROM tabs WHERE tabs.spawned_by = ?`)
      .all(id) as RawClockRow[];
    return rows.map(toClockRow);
  }

  /**
   * Retire a chat: it leaves the live list and joins the `done` group.
   *
   * NOT a delete, and the distinction is the whole model — the row, its panes,
   * its transcript and its place in the spawn tree all stay exactly where they
   * were, and the next message revives it ({@link unretire}). This is where
   * BOTH manual archive and a sub-chat's delivery land, because they are the
   * same state arrived at two ways.
   *
   * Idempotent on purpose: retiring a retired chat keeps the ORIGINAL stamp
   * and reason. A second turn-done on an already-delivered sub-chat must not
   * silently re-date it (the timestamp is what a `done` group sorts and labels
   * by), and an archive must not be overwritten by a later delivery.
   */
  retire(id: string, reason: RetireReason, at: number = Date.now()): boolean {
    const r = this.db
      .prepare(
        'UPDATE tabs SET retired_at = ?, retired_reason = ? WHERE id = ? AND retired_at IS NULL',
      )
      .run(at, reason, id);
    return r.changes > 0;
  }

  /** Bring a retired chat back. Its clock is restarted by the caller — see
   *  tab-clock.ts `reviveChat`, which does both in one act, because a chat
   *  un-retired onto an expired clock would be done again on the next read. */
  unretire(id: string): boolean {
    const r = this.db
      .prepare(
        'UPDATE tabs SET retired_at = NULL, retired_reason = NULL WHERE id = ? AND retired_at IS NOT NULL',
      )
      .run(id);
    return r.changes > 0;
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

  /**
   * Write a sub-chat's spawn report, stamping the attempt clock in the same
   * statement so the two can never disagree — `setHeadline`'s arrangement, for
   * `setHeadline`'s reason, including staying off `update()` and therefore off
   * `updated_at` (a report is not a structural edit to the tab).
   *
   * The TEXT and the STATE are written together and either may be null-ish:
   * `{report: null, state: 'none'}` is the child that produced nothing, and it
   * is a real answer rather than a failure. The failure is
   * {@link touchSpawnReportAt}, which writes neither.
   */
  setSpawnReport(id: string, write: SpawnReportWrite, at: number = Date.now()): void {
    this.db
      .prepare(
        `UPDATE tabs SET spawn_report = ?, spawn_report_state = ?, spawn_report_at = ?,
           spawn_artifacts = COALESCE(?, spawn_artifacts) WHERE id = ?`,
      )
      .run(
        write.report,
        write.state,
        at,
        // COALESCE, so a later round that finds none does not ERASE the link a
        // previous one published. An artifact does not stop existing.
        write.artifacts?.length ? JSON.stringify(write.artifacts) : null,
        id,
      );
  }

  /**
   * Write ONLY the artifacts — the urls and files a worker produced.
   *
   * Separate from {@link setSpawnReport} because the two have different failure
   * modes and that is the entire point: the report is a model's sentences and
   * can be refused, the artifacts are a regex over the same text and cannot.
   * `cross-ws` published a page, had its summary rejected for length, and showed
   * an empty card — the link has to land on the path where the sentences did
   * not.
   */
  setSpawnArtifacts(id: string, artifacts: readonly string[]): void {
    if (artifacts.length === 0) return;
    this.db
      .prepare('UPDATE tabs SET spawn_artifacts = ? WHERE id = ?')
      .run(JSON.stringify(artifacts), id);
  }

  /**
   * FORGET THE LAST ROUND'S VERDICT, because a new one is under way.
   *
   * `spawn_report` and `spawn_report_state` describe ONE round, and they were
   * outliving it. Measured live on `sidebar-fresh`: retired `delivered` with the
   * row still reading `spawn_report_state = 'awaiting'` from an earlier round,
   * so the card — which reads this column for the worker's state — insisted it
   * was waiting on the user about a job it had already delivered. `awaiting` and
   * `crashed` are the dangerous two, because both are facts we OBSERVED about a
   * moment that has passed, and both outrank an ordinary delivery on the card.
   *
   * Cleared when work RESUMES rather than corrected when it ends, because at the
   * moment a new round begins we know the old verdict is out of date and we do
   * not yet know the new one. Absence is honest for that gap; the card already
   * has a sentence for it.
   *
   * `spawn_report_at` is deliberately LEFT ALONE. It is the rate limiter's
   * clock, not a verdict, and handing a broken install a fresh call budget every
   * time a worker resumes is the failure `touchSpawnReportAt` exists to prevent.
   * The round-aware gate (see chat/spawn-report.ts) is what lets a genuine new
   * round through without clearing it.
   *
   * Artifacts stay too: they are urls and files that exist.
   */
  clearSpawnReport(id: string): void {
    this.db
      .prepare('UPDATE tabs SET spawn_report = NULL, spawn_report_state = NULL WHERE id = ?')
      .run(id);
  }

  /**
   * Advance the spawn-report rate limiter WITHOUT writing a report.
   *
   * `touchHeadlineAt`'s twin, and the same hard-won rule: the clock counts
   * ATTEMPTS, because the expensive thing is the call. A child whose model call
   * keeps failing — no login, an SDK import error, a reply that is not a report
   * — would otherwise spawn a fresh subprocess every time it finished a turn,
   * and a crashed child finishes turns in a loop.
   */
  touchSpawnReportAt(id: string, at: number = Date.now()): void {
    this.db.prepare('UPDATE tabs SET spawn_report_at = ? WHERE id = ?').run(at, id);
  }

  /**
   * Write the one-line label for what this worker was ASKED.
   *
   * Write-once in practice — the generator only ever runs for a child whose
   * column is empty — and off `update()` for the same reason `setHeadline` is:
   * `updated_at` is what clients key cache invalidation off, and a label landing
   * is not a structural edit to the tab.
   */
  setSpawnTask(id: string, task: string): void {
    this.db.prepare('UPDATE tabs SET spawn_task = ? WHERE id = ?').run(task, id);
  }

  /** When a spawn report was last ATTEMPTED for this chat; null if never. */
  spawnReportAt(id: string): number | null {
    const r = this.db.prepare('SELECT spawn_report_at FROM tabs WHERE id = ?').get(id) as
      | { spawn_report_at: number | null }
      | undefined;
    return r?.spawn_report_at ?? null;
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
   * statement so the two can never disagree. Returns whether it wrote.
   *
   * Deliberately not `update()`: that bumps `updated_at`, which clients key
   * cache invalidation off. Same split, and the same reasoning, as
   * `setHeadline`.
   *
   * THE STICKY CHECK IS IN THE SQL, not left to the caller, because the caller
   * physically cannot do it safely. A generation reads the flag, then awaits a
   * model call — a CLI subprocess, up to 30 seconds — and only then writes. A
   * user picking an icon from the rail during that window would have their
   * choice silently destroyed, and since the PATCH sets `icon_sticky = 1` on
   * its way through, the row would afterwards be frozen on the GENERATOR's
   * glyph forever: the sticky flag protecting the very value it was set to
   * prevent. The predicate has to be evaluated at write time, in the same
   * statement, and SQLite is the only place that is true.
   */
  setIcon(id: string, icon: string, at: number = Date.now()): boolean {
    const r = this.db
      .prepare('UPDATE tabs SET icon = ?, icon_at = ? WHERE id = ? AND icon_sticky = 0')
      .run(icon, at, id);
    return r.changes > 0;
  }

  /**
   * Hand the icon back to the machine: no glyph, no clock, no sticky flag.
   *
   * The counterpart to `PATCH {icon: ''}` and the ONLY thing that lowers
   * `icon_sticky`. Stickiness is otherwise one-way by design, but "one-way"
   * has to mean "the generator can never take it back", not "the user can
   * never change their mind" — and clearing your own icon is about as explicit
   * as changing your mind gets.
   *
   * Without this the carve-out was a trap that did the opposite of its
   * docstring. `{icon: ''}` on a row that was ALREADY sticky — which is every
   * row anyone would want to clear, since picking an icon is what makes a row
   * sticky — left `icon = NULL, icon_sticky = 1`: frozen forever, `setIcon`
   * refusing every write, the row pinned to the fallback glyph with no way
   * back from any surface. Exactly the stranding the carve-out was added to
   * prevent.
   *
   * All three columns move together because any two of them without the third
   * is a state with no meaning: a clock for a glyph that is gone, or a sticky
   * flag guarding nothing.
   */
  releaseIcon(id: string): void {
    this.db
      .prepare('UPDATE tabs SET icon = NULL, icon_at = NULL, icon_sticky = 0 WHERE id = ?')
      .run(id);
  }

  /**
   * When this tab's icon was last written by the generator; null if it never
   * was — which means whatever glyph the row wears is a placeholder nobody
   * chose (see the ESTABLISHED note in chat/headline.ts).
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
      // UNCONDITIONAL, like `last_activity_at` and for the sharper version of
      // the same reason: clients coalesce `tab.updated` onto a cached row, so a
      // field omitted when it happens to be null would leave the previous value
      // sitting there. It is also the ONLY key the global list can be ordered
      // by, so a row that arrives without it does not sort low — it sorts by
      // the noisy column this exists to replace (see userTouchAt). v33
      // backfills every row, so the `?? null` is reachable only for a row
      // inserted by something that bypassed `create` above.
      last_user_at: x.last_user_at ?? null,
      // Same rule: null means "never summarised", which is permanent for any
      // tab without an agent session. Only present when non-null, so a chat
      // that has no headline adds nothing to the payload — and nothing to the
      // client's change-dedup signature.
      ...(x.headline ? { headline: x.headline } : {}),
      ...(x.name_sticky ? { name_sticky: true } : {}),
      // Absent, not null, when this chat has no parent — the common case, and
      // one that should not widen every payload. `clock_started_at` is
      // deliberately NOT surfaced next to it: what a client renders is the
      // EFFECTIVE clock (a child's is its parent's), which decorateTab
      // publishes as `clock`. Shipping the raw column too would put two
      // timestamps on one row that disagree for every child chat.
      ...(x.spawned_by ? { spawned_by: x.spawned_by } : {}),
      // THE SPAWN REPORT, present only when there is one — which for every chat
      // nobody spawned is never. Three null fields on every row of every
      // sidebar poll would be payload, and three more inputs to the client's
      // change-dedup signature, for a permanent non-state. `_at` rides on the
      // STATE rather than on its own: an attempt with nothing to show for it
      // (state NULL) is a rate-limiter fact the client has no use for, and
      // publishing the timestamp alone would put a report entry in the log with
      // nothing in it.
      // The ASK, published on its own: it exists from the child's first turn,
      // long before there is anything to report, and that is exactly when the
      // card needs it.
      ...(x.spawn_task ? { spawn_task: x.spawn_task } : {}),
      // Parsed here so no client ever has to. A malformed value reads as none —
      // it is a link list, and the honest degradation is showing no links.
      ...(x.spawn_artifacts ? { spawn_artifacts: parseArtifacts(x.spawn_artifacts) } : {}),
      ...(x.spawn_report_state
        ? {
            spawn_report: x.spawn_report,
            spawn_report_at: x.spawn_report_at,
            spawn_report_state: x.spawn_report_state as SpawnReportState,
          }
        : {}),
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
