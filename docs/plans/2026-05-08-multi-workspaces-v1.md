# Multi-workspaces Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a parent "workspace" concept above today's "workspace" (which gets renamed to "tab"). Root URL `/` becomes a workspace picker; navigation goes `workspace → tab → pane`. Single user, one-shot migration, no backward compat.

**Architecture:** New `workspaces` SQLite table; existing `workspaces` table renamed to `tabs`; `panes.workspace_id` renamed to `panes.tab_id`. Server gains workspace CRUD. Web routing nests under `/w/:wsSlug/t/:tabSlug`. Chrome adds a workspace dropdown to the left of the tab bar.

**Tech Stack:** Same as muxpad: Node 22 + TypeScript, Hono + ws + node-pty + better-sqlite3 on the server; React + Vite + TanStack Router + xterm.js + react-mosaic-component on the web. Vitest for tests.

**Reference design:** [docs/plans/2026-05-08-multi-workspaces-design.md](./2026-05-08-multi-workspaces-design.md).

---

## Conventions for this plan

- Each task is a single commit. The commit happens at the end of the task.
- Run `pnpm -r test` after every task to make sure nothing else broke. The plan calls this out at the milestone level only to avoid noise.
- Run `pnpm --filter @muxpad/server exec tsc --noEmit && pnpm --filter @muxpad/web exec tsc --noEmit` before each commit.
- File paths are absolute relative to `/Users/ohadpr/Dropbox/Computer/MyDev/2025/webagents`.
- Tests live next to the file they cover (`X.ts` ↔ `X.test.ts`).
- Where this plan says "rename `Foo` → `Bar`", do a global identifier swap across imports, exports, types, and class names. Keep CSS class names intentional choices, called out per task.

---

## Milestone A: Server data model + stores

### Task A.1: Migration v5 — rename `workspaces` → `tabs`, rename `panes.workspace_id` → `panes.tab_id`

**Files:**
- Modify: `server/src/store/migrations.ts`
- Modify: `server/src/store/migrations.test.ts`

**Step 1: Append migration v5 to `MIGRATIONS` in `migrations.ts`.**

```ts
{
  // Multi-workspaces. The existing "workspaces" table actually models
  // tabs (one row per workspace tab). Rename it to `tabs`, rename the
  // pane FK column accordingly, and add a new `workspaces` table for
  // the new parent concept. (See docs/plans/2026-05-08-multi-workspaces-design.md.)
  version: 5,
  apply: (db) => {
    db.exec(`
      ALTER TABLE workspaces RENAME TO tabs;
      ALTER TABLE panes RENAME COLUMN workspace_id TO tab_id;
      CREATE TABLE workspaces (
        id          TEXT PRIMARY KEY,
        slug        TEXT UNIQUE NOT NULL,
        name        TEXT NOT NULL,
        position    INTEGER NOT NULL DEFAULT 0,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );
      ALTER TABLE tabs ADD COLUMN workspace_id TEXT NOT NULL DEFAULT '';
      CREATE INDEX tabs_workspace_id ON tabs(workspace_id);
    `);
    // Bootstrap a single Default workspace and assign every existing
    // tab to it. After this runs, the DB has one workspace and N tabs.
    const id = generateShortId(); // re-use the existing helper; not the ULID
    // We actually want a ULID for the id, and a separate slug. Keep the
    // pattern used by WorkspaceStore.create today.
    const { ulid: createUlid } = require('ulid');
    const wsId = createUlid();
    let slug: string | null = null;
    for (let i = 0; i < 100; i++) {
      const s = generateShortId();
      const collision = db.prepare('SELECT 1 FROM workspaces WHERE slug = ?').get(s);
      if (!collision) { slug = s; break; }
    }
    if (!slug) throw new Error('unable to allocate slug for default workspace');
    const now = Date.now();
    db.prepare(
      'INSERT INTO workspaces (id, slug, name, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(wsId, slug, 'Default', 0, now, now);
    db.prepare('UPDATE tabs SET workspace_id = ?').run(wsId);
  },
},
```

**Step 2: Add an integration test in `migrations.test.ts`.**

Add a test that:
- Creates a fresh DB, runs migrations through v4.
- Inserts a workspace row + a couple of pane rows under it (using the v4 schema).
- Bumps to v5 by re-running `runMigrations`.
- Asserts: `tabs` table has the rows; `panes.tab_id` matches; `workspaces` table has exactly one row named `Default`; the tab's `workspace_id` equals that workspace's id.

```ts
it('migration v5 creates workspaces table and migrates tabs/panes', () => {
  const db = freshDbAtVersion(4); // helper that runs migrations only up to v4
  const wsId = '01ABCDEFG';
  const paneId = '01PANEID';
  db.prepare(
    'INSERT INTO workspaces (id, slug, name, layout, created_at, updated_at, position) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(wsId, 'aaaa1111', 'Project Alpha', '', 1, 1, 0);
  db.prepare(
    'INSERT INTO panes (id, workspace_id, shell, cwd, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(paneId, wsId, '/bin/sh', '/tmp', 1);

  runMigrations(db); // applies v5

  const tabs = db.prepare('SELECT * FROM tabs').all() as { id: string; workspace_id: string }[];
  expect(tabs).toHaveLength(1);
  expect(tabs[0].id).toBe(wsId);

  const panes = db.prepare('SELECT * FROM panes').all() as { tab_id: string }[];
  expect(panes).toHaveLength(1);
  expect(panes[0].tab_id).toBe(wsId);

  const wsRows = db.prepare('SELECT * FROM workspaces').all() as { id: string; name: string }[];
  expect(wsRows).toHaveLength(1);
  expect(wsRows[0].name).toBe('Default');
  expect(tabs[0].workspace_id).toBe(wsRows[0].id);
});
```

**Step 3: Implement the helper `freshDbAtVersion` if it doesn't exist.**

If not present in the test file, add it at the top:

```ts
function freshDbAtVersion(version: number): Database.Database {
  // Call runMigrations after stubbing schema_version to one less than
  // the target version's predecessor list. Or, simpler: filter MIGRATIONS
  // to <= version and run each manually. Simplest: copy MIGRATIONS into
  // an array slice and inline the loop.
  // NOTE: pick whichever style matches existing helpers — current test
  // file may already have a similar fixture.
}
```

If there's no clean helper, just inline: in the test, run all migrations up through v4 by running `runMigrations` against a real `migrations.ts` snapshot — but since that's awkward, accept that v5 tests work end-to-end (run all migrations, then assert). Pragmatic choice; a pre-test SQL fixture file works too.

**Step 4: Run migrations test.**

```bash
pnpm --filter @muxpad/server test src/store/migrations.test.ts
```

Expected: all migration tests pass, including the new one.

**Step 5: Commit.**

```bash
git add server/src/store/migrations.ts server/src/store/migrations.test.ts
git commit -m "feat(migrations): rename workspaces→tabs, add new workspaces parent table (v5)"
```

---

### Task A.2: Rename `WorkspaceStore` → `TabStore`

**Files:**
- Move: `server/src/store/WorkspaceStore.ts` → `server/src/store/TabStore.ts`
- Move: `server/src/store/WorkspaceStore.test.ts` → `server/src/store/TabStore.test.ts`

**Step 1: Rename files.**

```bash
git mv server/src/store/WorkspaceStore.ts server/src/store/TabStore.ts
git mv server/src/store/WorkspaceStore.test.ts server/src/store/TabStore.test.ts
```

**Step 2: Inside `TabStore.ts`, rename the class and adjust SQL.**

Find/replace within the file:
- `WorkspaceStore` → `TabStore`
- `Workspace` (the type, where it appears) → `Tab` — but the import comes from `@muxpad/shared`, so keep it as `Workspace` until task B.2 renames the shared type.
- Actually, simpler: change all internal references to `Tab` and update the shared types in the same task. But that crosses package boundaries. Cleaner sequencing: do the type rename in shared first (Task B.2 below) and only update the import here when we get to it. For now in this task: leave the shared type name as `Workspace`, just rename the class to `TabStore` and update SQL table name from `workspaces` to `tabs`.
- All SQL queries: `FROM workspaces` → `FROM tabs`, `INSERT INTO workspaces` → `INSERT INTO tabs`, `UPDATE workspaces` → `UPDATE tabs`, etc.
- The new `workspace_id` column on `tabs` must be included in inserts. Use `''` as the default until task B.4 adds workspace handling. Actually no — the migration sets it for existing rows but `create()` calls won't supply it. To keep this task's diff tight, accept that `create()` is broken for now (writes empty `workspace_id`); fix in task B.4 when we add workspace plumbing.

**Step 3: Update imports across the server.**

Files that import `WorkspaceStore`:
- `server/src/routes/workspaces.ts`
- (search the codebase for `WorkspaceStore` or `workspace-store` or `from './WorkspaceStore'`)

In each, update import path to `'./TabStore.js'` (or relative equivalent) and type name to `TabStore`.

**Step 4: Update the test file.**

Inside `TabStore.test.ts`:
- `WorkspaceStore` → `TabStore`
- All SQL setup that references the old table name.
- The test asserts about `workspaces` rows now check `tabs` rows.

**Step 5: Run tests.**

```bash
pnpm --filter @muxpad/server test src/store/TabStore.test.ts
```

Expected: all tests pass.

**Step 6: Commit.**

```bash
git add -A
git commit -m "refactor(server): rename WorkspaceStore → TabStore"
```

---

### Task A.3: New `WorkspaceStore` for the parent concept

**Files:**
- Create: `server/src/store/WorkspaceStore.ts`
- Create: `server/src/store/WorkspaceStore.test.ts`

**Step 1: Write `WorkspaceStore.ts`.**

```ts
import type Database from 'better-sqlite3';
import { ulid } from 'ulid';
import { generateShortId } from './TabStore.js'; // re-export this helper; see step 1b

interface WorkspaceRow {
  id: string;
  slug: string;
  name: string;
  position: number;
  created_at: number;
  updated_at: number;
}

export interface Workspace {
  id: string;
  slug: string;
  name: string;
  position: number;
  created_at: number;
  updated_at: number;
  /** Number of tabs currently in the workspace. Computed at read time. */
  tab_count: number;
}

export class WorkspaceStore {
  constructor(private readonly db: Database.Database) {}

  create(input: { name: string }): Workspace {
    const id = ulid();
    const slug = this.allocateSlug();
    const now = Date.now();
    const position = (this.maxPosition() ?? -1) + 1;
    this.db
      .prepare(
        'INSERT INTO workspaces (id, slug, name, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(id, slug, input.name, position, now, now);
    return { id, slug, name: input.name, position, created_at: now, updated_at: now, tab_count: 0 };
  }

  list(): Workspace[] {
    const rows = this.db
      .prepare('SELECT * FROM workspaces ORDER BY position, created_at')
      .all() as WorkspaceRow[];
    return rows.map((r) => this.decorate(r));
  }

  getById(id: string): Workspace | null {
    const r = this.db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as WorkspaceRow | undefined;
    return r ? this.decorate(r) : null;
  }

  getBySlug(slug: string): Workspace | null {
    const r = this.db.prepare('SELECT * FROM workspaces WHERE slug = ?').get(slug) as WorkspaceRow | undefined;
    return r ? this.decorate(r) : null;
  }

  update(id: string, patch: { name?: string; slug?: string }): Workspace {
    const existing = this.getById(id);
    if (!existing) throw new Error(`workspace not found: ${id}`);
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

  reorder(orderedIds: string[]): void {
    const update = this.db.prepare('UPDATE workspaces SET position = ? WHERE id = ?');
    const tx = this.db.transaction(() => {
      orderedIds.forEach((id, idx) => update.run(idx, id));
    });
    tx();
  }

  private decorate(r: WorkspaceRow): Workspace {
    const count = this.db
      .prepare('SELECT COUNT(*) as n FROM tabs WHERE workspace_id = ?')
      .get(r.id) as { n: number };
    return {
      id: r.id,
      slug: r.slug,
      name: r.name,
      position: r.position,
      created_at: r.created_at,
      updated_at: r.updated_at,
      tab_count: count.n,
    };
  }

  private maxPosition(): number | null {
    const r = this.db.prepare('SELECT MAX(position) as p FROM workspaces').get() as { p: number | null };
    return r.p;
  }

  private allocateSlug(): string {
    for (let i = 0; i < 100; i++) {
      const s = generateShortId();
      const collision = this.db.prepare('SELECT 1 FROM workspaces WHERE slug = ?').get(s);
      if (!collision) return s;
    }
    throw new Error('unable to allocate slug after 100 attempts');
  }
}
```

**Step 1b:** If `generateShortId` isn't exported from `TabStore.ts`, export it now (`export function generateShortId() { ... }` in TabStore.ts).

**Step 2: Write `WorkspaceStore.test.ts`** mirroring the structure of `TabStore.test.ts`.

Cover at minimum:
- `create()` returns a workspace with `tab_count === 0`.
- `list()` returns workspaces in `position` order.
- `getById` and `getBySlug` round-trip.
- `update()` changes name and slug, updates `updated_at`.
- `reorder()` reassigns positions.
- `tab_count` reflects rows in `tabs` table.

```ts
it('decorates workspaces with tab_count', () => {
  const ws = store.create({ name: 'Test' });
  // No tabs yet
  expect(store.getById(ws.id)!.tab_count).toBe(0);
  // Insert a tab manually
  db.prepare(
    'INSERT INTO tabs (id, slug, name, layout, workspace_id, created_at, updated_at, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run('t1', 'tslug1', 'Tab 1', '', ws.id, 1, 1, 0);
  expect(store.getById(ws.id)!.tab_count).toBe(1);
});
```

**Step 3: Run the tests.**

```bash
pnpm --filter @muxpad/server test src/store/WorkspaceStore.test.ts
```

Expected: all pass.

**Step 4: Commit.**

```bash
git add -A
git commit -m "feat(server): add WorkspaceStore for the new parent concept"
```

---

## Milestone B: Shared types + protocol

### Task B.1: Shared types — rename `Workspace` → `Tab`, add new `Workspace`

**Files:**
- Modify: `shared/src/types.ts`
- Modify: `shared/src/types.test.ts`

**Step 1: In `types.ts`:**

Rename `WorkspaceSchema` → `TabSchema`, `Workspace` → `Tab`. Update field comment that mentions "workspace" if it now means "tab".

Add a new `WorkspaceSchema` and `Workspace` type:

```ts
export const WorkspaceSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  position: z.number().int(),
  created_at: z.number(),
  updated_at: z.number(),
  tab_count: z.number().int().nonnegative(),
});
export type Workspace = z.infer<typeof WorkspaceSchema>;
```

Keep `LayoutNodeSchema` and `PaneSpecSchema` unchanged. (`PaneSpec.workspace_id` actually refers to the tab now — rename that field to `tab_id` for clarity.)

Inside `PaneSpecSchema`:

```ts
export const PaneSpecSchema = z.object({
  id: z.string(),
  tab_id: z.string(),  // was workspace_id
  shell: z.string(),
  // ...rest unchanged
});
```

**Step 2: Update test file** for any explicit references to the old `Workspace` shape; rename to `Tab`. Add a small test that `WorkspaceSchema.parse({...})` accepts a typical decorated workspace row.

**Step 3: Build shared and run its tests.**

```bash
pnpm --filter @muxpad/shared build
pnpm --filter @muxpad/shared test
```

**Step 4: Server and web will both fail to compile** at this point because the shared package re-exports new names. That's fine — fix in subsequent tasks.

**Step 5: Commit.**

```bash
git add -A
git commit -m "feat(shared): rename Workspace type → Tab, add new Workspace parent type"
```

---

## Milestone C: Server routes

### Task C.1: Rename `routes/workspaces.ts` → `routes/tabs.ts`, update endpoint paths

**Files:**
- Move: `server/src/routes/workspaces.ts` → `server/src/routes/tabs.ts`
- Move: `server/src/routes/workspaces.test.ts` → `server/src/routes/tabs.test.ts`
- Modify: `server/src/server.ts` (if it mounts `workspacesRoutes` — locate it)

**Step 1: Rename files.**

```bash
git mv server/src/routes/workspaces.ts server/src/routes/tabs.ts
git mv server/src/routes/workspaces.test.ts server/src/routes/tabs.test.ts
```

**Step 2: Inside `tabs.ts`:**

- Rename `workspacesRoutes` → `tabsRoutes`.
- Replace `WorkspaceStore` import with `TabStore`.
- Replace `Workspace` (the imported type) with `Tab`.
- Routes' base path becomes `/api/tabs` (mounted in server.ts in step 4).
- All endpoints unchanged in shape; just renamed:
  - `POST /` (create tab in a workspace — body now requires `workspace_id`)
  - `GET /?workspaceId=…` — list tabs in a workspace; if `workspaceId` not provided return 400.
  - `GET /:id` — tab detail (with embedded panes, like today)
  - `PATCH /:id` — rename, slug, layout
  - `DELETE /:id` — delete
  - `POST /reorder` — reorder tabs **within the same workspace**; body shape `{ workspaceId, ids[] }`.

**Step 3: Update tests** for the renames and new query/body shapes.

**Step 4: Update `server/src/server.ts`:**

```ts
import { tabsRoutes } from './routes/tabs.js';
// later, where workspacesRoutes was mounted:
app.route('/api/tabs', tabsRoutes(deps));
```

**Step 5: Run tests.**

```bash
pnpm --filter @muxpad/server test src/routes/tabs.test.ts
```

**Step 6: Commit.**

```bash
git add -A
git commit -m "refactor(server): rename routes/workspaces → routes/tabs; mount at /api/tabs"
```

---

### Task C.2: New `routes/workspaces.ts` for the parent concept

**Files:**
- Create: `server/src/routes/workspaces.ts`
- Create: `server/src/routes/workspaces.test.ts`
- Modify: `server/src/server.ts`

**Step 1: Write `workspaces.ts`** with these endpoints:

```ts
import { Hono } from 'hono';
import { z } from 'zod';
import type Database from 'better-sqlite3';
import { WorkspaceStore } from '../store/WorkspaceStore.js';
import type { TabStore } from '../store/TabStore.js';
import type { PaneManager } from '../runtime/PaneManager.js';

export function workspacesRoutes(deps: {
  db: Database.Database;
  paneManager: PaneManager;
}): Hono {
  const app = new Hono();
  const workspaces = new WorkspaceStore(deps.db);

  app.get('/', (c) => c.json(workspaces.list()));

  app.post('/', async (c) => {
    const body = z.object({ name: z.string().optional() }).parse(await c.req.json().catch(() => ({})));
    const name = body.name?.trim() || 'New workspace';
    return c.json(workspaces.create({ name }), 201);
  });

  app.get('/:id', (c) => {
    const w = workspaces.getById(c.req.param('id'));
    if (!w) return c.json({ error: { code: 'not_found', message: 'workspace not found' } }, 404);
    return c.json(w);
  });

  app.patch('/:id', async (c) => {
    const body = z.object({ name: z.string().optional(), slug: z.string().optional() })
      .parse(await c.req.json());
    try {
      return c.json(workspaces.update(c.req.param('id'), body));
    } catch {
      return c.json({ error: { code: 'not_found', message: 'workspace not found' } }, 404);
    }
  });

  app.delete('/:id', (c) => {
    const id = c.req.param('id');
    const w = workspaces.getById(id);
    if (!w) return c.json({ error: { code: 'not_found', message: 'workspace not found' } }, 404);
    if (w.tab_count > 0) {
      return c.json(
        { error: { code: 'workspace_not_empty', message: 'workspace still has tabs' } },
        409,
      );
    }
    workspaces.delete(id);
    return c.body(null, 204);
  });

  app.post('/reorder', async (c) => {
    const body = z.object({ ids: z.array(z.string()) }).parse(await c.req.json());
    workspaces.reorder(body.ids);
    return c.body(null, 204);
  });

  return app;
}
```

**Step 2: Write `workspaces.test.ts`** covering:
- `POST /` creates with default name when none provided.
- `GET /` lists in position order.
- `GET /:id` returns 404 when missing.
- `PATCH /:id` renames.
- `DELETE /:id` returns 409 when tabs exist; 204 when empty.
- `POST /reorder` reorders.

**Step 3: Mount in `server.ts`:**

```ts
import { workspacesRoutes } from './routes/workspaces.js';
app.route('/api/workspaces', workspacesRoutes(deps));
```

**Step 4: Run all server tests.**

```bash
pnpm --filter @muxpad/server test
```

**Step 5: Commit.**

```bash
git add -A
git commit -m "feat(server): add /api/workspaces routes"
```

---

### Task C.3: Update `routes/panes.ts` and `routes/attachments.ts` for the rename

**Files:**
- Modify: `server/src/routes/panes.ts` (and its test)
- Modify: `server/src/routes/attachments.ts` (and its test)
- Modify: `server/src/runtime/PaneRuntime.ts` (if it references `workspace_id` in spec — it does).
- Modify: `server/src/store/PaneStore.ts` (uses `workspace_id` field)

**Step 1: Search for `workspace_id` across server source:**

```bash
grep -rn "workspace_id" server/src
```

**Step 2: In each match, rename to `tab_id`** unless it refers to the new workspace concept. Mostly all the existing `workspace_id` refs are about what's now a tab.

Particularly:
- `PaneStore.create({ workspace_id, ... })` → `{ tab_id, ... }`
- `PaneStore.listByWorkspace(workspaceId)` → `listByTab(tabId)`
- `PaneRuntimeSpec.workspace_id` → `tab_id`
- Routes that mention workspace_id in body/query.

**Step 3: Update tests** for all renames.

**Step 4: Run tests.**

```bash
pnpm --filter @muxpad/server test
```

Expected: all server tests pass.

**Step 5: Commit.**

```bash
git add -A
git commit -m "refactor(server): rename pane.workspace_id → pane.tab_id everywhere"
```

---

## Milestone D: Web — API client + rename

### Task D.1: Update web API client (`web/src/api.ts`)

**Files:**
- Modify: `web/src/api.ts`

**Step 1: Rename existing methods** to operate on tabs:

- `listWorkspaces` → `listTabs(workspaceId: string)` (now requires workspace id)
- `createWorkspace` → `createTab(workspaceId, body)` (now requires workspace id)
- `getWorkspace` → `getTab`
- `patchWorkspace` → `patchTab`
- `deleteWorkspace` → `deleteTab`
- `reorderWorkspaces` → `reorderTabs(workspaceId, ids)`
- `markWorkspaceSeen` → `markTabSeen`

**Step 2: Add new methods** for workspaces:

```ts
listWorkspaces: () => req<Workspace[]>('/api/workspaces'),
createWorkspace: (name?: string) =>
  req<Workspace>('/api/workspaces', {
    method: 'POST',
    body: JSON.stringify(name ? { name } : {}),
  }),
getWorkspace: (id: string) => req<Workspace>(`/api/workspaces/${id}`),
patchWorkspace: (id: string, patch: { name?: string; slug?: string }) =>
  req<Workspace>(`/api/workspaces/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  }),
deleteWorkspace: (id: string) => req<void>(`/api/workspaces/${id}`, { method: 'DELETE' }),
reorderWorkspaces: (ids: string[]) =>
  req<void>('/api/workspaces/reorder', {
    method: 'POST',
    body: JSON.stringify({ ids }),
  }),
```

**Step 3: Update imports** in api.ts to import both `Workspace` and `Tab` from `@muxpad/shared`.

**Step 4: Step doesn't compile yet** — that's fine; downstream modules update in subsequent tasks.

**Step 5: Commit.**

```bash
git add web/src/api.ts
git commit -m "refactor(web): split api client into workspace + tab namespaces"
```

---

### Task D.2: Rename web modules — `WorkspaceTabBar` → `TabBar`, `WorkspaceView` → `TabView`, `workspaces.ts` → `tabs.ts`

**Files:** mechanical rename across:
- `web/src/components/WorkspaceTabBar.tsx` → `web/src/components/TabBar.tsx`
- `web/src/components/WorkspaceTabBar.css` → `web/src/components/TabBar.css`
- `web/src/components/WorkspaceDropdown.tsx` (used inside TabBar today) → `web/src/components/TabBarDropdown.tsx`
- `web/src/pages/WorkspaceView.tsx` → `web/src/pages/TabView.tsx`
- `web/src/pages/workspace.css` → `web/src/pages/tab.css`
- `web/src/workspaces.ts` → `web/src/tabs.ts`
- `web/src/use-window-attention.ts` (no rename, but inside it uses `Workspace[]` — update to `Tab[]`)

**Step 1: Move files via `git mv`.**

```bash
git mv web/src/components/WorkspaceTabBar.tsx web/src/components/TabBar.tsx
git mv web/src/components/WorkspaceTabBar.css web/src/components/TabBar.css
git mv web/src/components/WorkspaceDropdown.tsx web/src/components/TabBarDropdown.tsx
git mv web/src/pages/WorkspaceView.tsx web/src/pages/TabView.tsx
git mv web/src/pages/workspace.css web/src/pages/tab.css
git mv web/src/workspaces.ts web/src/tabs.ts
```

**Step 2: Update identifiers globally:**

Mechanical find/replace (case-sensitive) across the moved files and any imports:
- `WorkspaceTabBar` → `TabBar`
- `WorkspaceView` → `TabView`
- `WorkspaceDropdown` → `TabBarDropdown`
- `useWorkspaces` → `useTabs`
- `refreshWorkspaces` → `refreshTabs`
- `workspaces` (variable name) → `tabs`
- CSS class names: `.ws-tab` → `.tab`, `.ws-tabbar` → `.tab-bar`, `.ws-tab-add` → `.tab-add`, etc. Sweep `web/src/**/*.css` and `web/src/**/*.tsx` for `ws-tab` and replace.
- Custom event names: `muxpad:layout-changed` keep; `muxpad:focus-pane` keep. (Not workspace-named.)
- localStorage / DOM events: keep DRAG_MIME but rename `application/x-muxpad-workspace-id` → `application/x-muxpad-tab-id`.

**Step 3: Update imports in:**

- `web/src/router.tsx` (will be rewritten in Task E.1; for now leave imports referencing old paths broken — they'll be replaced).
- `web/src/components/AppLayout.tsx` — change `import { WorkspaceTabBar }` → `import { TabBar }`.
- Any other import sites.

**Step 4: Type-check (this will still fail because router.tsx isn't updated yet; that's OK).**

**Step 5: Commit.**

```bash
git add -A
git commit -m "refactor(web): rename WorkspaceTabBar/WorkspaceView/workspaces → TabBar/TabView/tabs"
```

---

## Milestone E: Web routing + new pages

### Task E.1: Rewrite router with nested workspace + tab routes

**Files:**
- Modify: `web/src/router.tsx`
- Create: `web/src/components/WorkspaceLayout.tsx` — the parent route component for `/w/:wsSlug`. Renders the chrome (TabBar) and an `<Outlet />` for the active tab. Loads the workspace by slug and provides it to children via context or just by reading the route params.
- Create: `web/src/pages/WorkspacePicker.tsx` — the new `/` page.
- Create: `web/src/pages/TabPopout.tsx` — chromeless tab popout at `/popout/t/:tabSlug`.
- Modify: `web/src/pages/Dashboard.tsx` — DELETE this file. Picker replaces it.
- Modify: `web/src/components/AppLayout.tsx` — already a layout for the `/w/:wsSlug` chain; verify still correct or fold into `WorkspaceLayout`.

**Step 1: Write `WorkspacePicker.tsx`.**

A simple list of workspaces from `api.listWorkspaces()`. Click an entry to navigate to `/w/:slug`. Show "+ New workspace" CTA at the bottom that creates one and navigates into it.

Empty state: "No workspaces yet" + "Create your first workspace" CTA.

**Step 2: Write `WorkspaceLayout.tsx`.**

Reads the `wsSlug` route param. Loads the workspace, renders the TabBar (which itself loads tabs for that workspace), and renders `<Outlet />` for the active tab.

If the URL is exactly `/w/:wsSlug` (no tab segment), and the workspace has tabs, redirect to `/w/:wsSlug/t/:firstTabSlug`. If no tabs, render the empty-workspace state (Task F.2 covers).

**Step 3: Write `TabPopout.tsx`.**

Reads `tabSlug` param. Loads the tab via `api.getTab(...)` (or by slug — add a helper `getTabBySlug` if needed). Renders the tab's pane mosaic chromeless. Look at `TabView.tsx` for the mosaic-rendering JSX and replicate the bit that renders panes — without the surrounding chrome.

**Step 4: Rewrite `router.tsx`:**

```tsx
import { createRootRoute, createRoute, createRouter, Outlet } from '@tanstack/react-router';
import { AppLayout } from './components/AppLayout';
import { WorkspaceLayout } from './components/WorkspaceLayout';
import { WorkspacePicker } from './pages/WorkspacePicker';
import { TabView } from './pages/TabView';
import { PopoutView } from './pages/PopoutView';
import { TabPopout } from './pages/TabPopout';

const rootRoute = createRootRoute({ component: () => <Outlet /> });

const appLayoutRoute = createRoute({ getParentRoute: () => rootRoute, id: '_app', component: AppLayout });

const pickerRoute = createRoute({ getParentRoute: () => appLayoutRoute, path: '/', component: WorkspacePicker });

const workspaceLayoutRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: '/w/$wsSlug',
  component: WorkspaceLayout,
});

const tabRoute = createRoute({
  getParentRoute: () => workspaceLayoutRoute,
  path: 't/$tabSlug',
  component: TabView,
});

const popoutPaneRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/p/$paneId',
  component: PopoutView,
});
const popoutTabRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/popout/t/$tabSlug',
  component: TabPopout,
});

const routeTree = rootRoute.addChildren([
  appLayoutRoute.addChildren([
    pickerRoute,
    workspaceLayoutRoute.addChildren([tabRoute]),
  ]),
  popoutPaneRoute,
  popoutTabRoute,
]);

export const router = createRouter({ routeTree });
```

**Step 5: Delete `Dashboard.tsx`** (and its CSS file `dashboard.css` if no longer referenced).

```bash
git rm web/src/pages/Dashboard.tsx
git rm web/src/pages/dashboard.css   # if unreferenced
```

**Step 6: TabView's `useParams` call** — update from `from: '/_app/w/$slug'` to `from: '/_app/w/$wsSlug/t/$tabSlug'` and read `tabSlug`. Look up tab via `api.listTabs(workspaceId)` — but TabView needs the workspace context. Easiest: TabView reads both params and re-fetches by tabSlug + workspace from cache. Cleanest: WorkspaceLayout puts workspace into a context, TabView consumes it.

**Step 7: Build + start dev:**

```bash
pnpm --filter @muxpad/web exec tsc --noEmit
pnpm dev
```

Manually verify:
- `/` shows the workspace picker.
- Clicking a workspace navigates to `/w/:slug`.
- That route shows the TabBar and the first tab's content.
- `/p/:paneId` still works.
- `/popout/t/:tabSlug` shows a chromeless tab.

**Step 8: Commit.**

```bash
git add -A
git commit -m "feat(web): nested routing — picker / workspace / tab / popouts"
```

---

## Milestone F: Chrome + UI polish

### Task F.1: Workspace switcher dropdown in TabBar

**Files:**
- Modify: `web/src/components/TabBar.tsx`
- Modify: `web/src/components/TabBar.css`
- Create: `web/src/components/WorkspaceSwitcher.tsx`
- Create: `web/src/components/WorkspaceSwitcher.css`

**Step 1: Write `WorkspaceSwitcher.tsx`.**

Trigger button shows the current workspace name + chevron. Click → menu with all workspaces (active marked); click any to navigate. Last item: "+ New workspace" — creates one and navigates into it.

Double-click on the trigger → inline rename (mirror the pattern in `TabBar.tsx` for tab rename: state `editingId`, an input replacing the trigger label, blur or Enter commits, Escape cancels).

```tsx
export function WorkspaceSwitcher({ activeWsSlug }: { activeWsSlug: string | null }) {
  // similar in shape to PaneSelector / WorkspaceDropdown that we already have
  // but for workspaces.
}
```

**Step 2: Render `<WorkspaceSwitcher />`** inside `TabBar.tsx`, positioned between the brand and the tab divider:

```tsx
<header className="tab-bar">
  <Brand asLink={true} responsive={true} />
  <WorkspaceSwitcher activeWsSlug={...} />
  <span className="tab-bar-divider" aria-hidden />
  ...tabs...
</header>
```

**Step 3: Style** with the same pattern as `WorkspaceDropdown` (now `TabBarDropdown`). New CSS file or add rules at the top of `TabBar.css`.

**Step 4: Test by hand** — switching workspaces, renaming via double-click, creating new.

**Step 5: Commit.**

```bash
git add -A
git commit -m "feat(web): workspace switcher dropdown next to brand"
```

---

### Task F.2: Auto-close empty workspaces

**Decision:** We do NOT render an "empty workspace" state with CTAs. Instead, when the last tab in a workspace is closed, the workspace is auto-deleted and the user is navigated to `/` (the picker). Rationale: an empty workspace is a transient state with no useful affordances of its own; cascade-deleting it keeps the user's mental model simple (a workspace is the set of its tabs).

The existing "empty tab" state (when the last pane in a tab closes) stays — users still get the "+ New pane" / "or close this tab" CTAs at the tab level.

**Files:**
- Modify: `web/src/components/WorkspaceLayout.tsx`
- Modify: `web/src/pages/TabView.tsx` (the close-tab flow)

**Step 1: In `WorkspaceLayout.tsx`,** after loading the workspace + tabs, if `tabs.length === 0`, fire-and-forget `api.deleteWorkspace(workspaceId)` and `navigate({ to: '/' })`. Guard with a ref so it only fires once.

**Step 2: In the tab-close flow** (wherever today's `closeWorkspace`-equivalent lives, which becomes `closeTab`): after deletion, if the workspace's `tab_count` drops to 0, the WorkspaceLayout's auto-close effect handles it on the next render — no special-casing needed in the close handler.

**Step 3: Defensive: `api.deleteWorkspace` returns 409 if `tab_count > 0`.** Since the auto-close only fires when `tabs.length === 0`, this should never happen, but log and ignore the 409 just in case.

**Step 4: Manually verify** by closing the last tab in a workspace — the user should land at `/` and the workspace should be gone from the picker.

**Step 5: Commit.**

```bash
git add -A
git commit -m "feat(web): auto-close workspace when its last tab is closed"
```

---

### Task F.3: Right-click context menu on tabs + tab popout

**Files:**
- Create: `web/src/components/ContextMenu.tsx` and `ContextMenu.css` — a small generic context-menu component.
- Modify: `web/src/components/TabBar.tsx` — wire `onContextMenu` on each tab.

**Step 1: Write `ContextMenu.tsx`.**

A controlled context menu: open at (x, y), close on outside click or Escape. Items passed in as `{ label, onClick }[]`.

**Step 2: In `TabBar.tsx`,** track a context-menu-state and on right-click of a tab, set `{ x, y, tabSlug }`.

**Step 3: Render `<ContextMenu>`** with one item: "Pop out tab" — opens `/popout/t/${tabSlug}` in a new browser tab via `window.open`.

**Step 4: Polish:** close menu on click, on Escape, on outside click, on scroll.

**Step 5: Verify** by right-clicking a tab → "Pop out tab" → new browser tab opens with the chromeless tab view.

**Step 6: Commit.**

```bash
git add -A
git commit -m "feat(web): right-click context menu on tabs with 'Pop out tab' action"
```

---

## Milestone G: Polish + tests

### Task G.1: Type-check + run all tests + manual smoke

**Step 1: Type-check both packages:**

```bash
pnpm --filter @muxpad/server exec tsc --noEmit
pnpm --filter @muxpad/web exec tsc --noEmit
```

Both should be clean.

**Step 2: Run the full test suite:**

```bash
pnpm -r test
```

All 70+ tests should pass.

**Step 3: Manual smoke test in dev:**

1. Stop daemon. Take a backup of `~/.muxpad/db.sqlite` first (just in case).
2. `pnpm install && pnpm --parallel dev`.
3. Open `http://localhost:5173`. You should see the workspace picker, with one entry: `Default` (containing all your existing tabs).
4. Click into Default. The familiar tab bar appears.
5. Verify your existing tabs are there with their panes still tied to their original cwds.
6. Click the workspace switcher → "+ New workspace" → enter "Test". Land in an empty Test workspace. See the "Create your first tab" CTA. Click it; a tab is created.
7. Right-click the tab → "Pop out tab". A new browser tab opens with just that tab's pane(s).
8. Close all tabs in Test. See the empty state with "or close this workspace". Click it. Land back at `/` picker. Test workspace is gone.
9. Navigate back into Default. Everything still works.

**Step 4: Commit any small fixes from the smoke test as a single follow-up commit.**

---

## After implementation

- Update [docs/punch-list.md](../punch-list.md) — strike "right-click context menu" since we shipped the tab-popout case (the broader copy/paste case can stay).
- Update [README.md](../../README.md): mention multi-workspaces in the features list.
- Optional: write a small migration note in CHANGELOG-style for future-self.

---

## Rough effort

- Milestone A (server data + stores): ~3 hours.
- Milestone B (shared types): ~30 min.
- Milestone C (server routes): ~2 hours.
- Milestone D (web rename): ~1 hour.
- Milestone E (web routing + new pages): ~3 hours.
- Milestone F (chrome + UI polish): ~3 hours.
- Milestone G (smoke + fixes): ~1 hour.

**Total: ~13-14 hours.** Realistic for one engineer over 1.5-2 working days.
