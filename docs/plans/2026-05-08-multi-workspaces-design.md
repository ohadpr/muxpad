# Multi-workspaces design

**Goal.** Add a parent concept above today's "workspace". The current concept (a tab in the bar with a tree of panes) gets renamed to **tab**. The new parent is **workspace**. Root URL `/` becomes a workspace picker; you click into a workspace to see its tabs.

Single-user app, one-shot migration, ship fast.

## Naming

- Existing `Workspace` → `Tab` everywhere in code, types, routes, URLs, components.
- New parent concept = `Workspace`.

## Data model

New `workspaces` table:

```sql
CREATE TABLE workspaces (
  id         TEXT PRIMARY KEY,        -- ULID
  slug       TEXT UNIQUE NOT NULL,    -- 8-char randomized, stable across renames
  name       TEXT NOT NULL,
  position   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

Existing `workspaces` table renamed to `tabs`, with a new FK column:

```sql
ALTER TABLE workspaces RENAME TO tabs;
ALTER TABLE tabs ADD COLUMN workspace_id TEXT NOT NULL DEFAULT '';
CREATE INDEX tabs_workspace_id ON tabs(workspace_id);
```

**Migration (one-shot):**
1. Create one workspace row, name = `Default`.
2. `UPDATE tabs SET workspace_id = <that id>` for every existing row.

The `panes` and `attachments` tables don't change (panes still belong to a tab via `workspace_id` → renamed to `tab_id`).

## URL shape

```
/                                          workspace picker
/w/:wsSlug                                 redirects to first tab in workspace
/w/:wsSlug/t/:tabSlug                      tab view (full chrome)
/w/:wsSlug/t/:tabSlug/p/:paneId            pop-out (chromeless, single pane)
/popout/t/:tabSlug                         pop-out (chromeless, full tab)
```

Slugs stay the same: 8-char randomized, stable across renames. URLs that exist today (`/w/:slug`) are not preserved across the rename — single user, one-shot migration, no need for redirects.

## Server changes

- `WorkspaceStore` (today's, owning the existing concept) renamed to `TabStore`.
- New `WorkspaceStore` written for the new parent.
- Routes:
  - `GET /api/workspaces` — list. Each entry includes a `tab_count`.
  - `POST /api/workspaces` — create.
  - `GET /api/workspaces/:id` — detail with embedded tabs (replaces today's `GET /api/workspaces/:id`).
  - `PATCH /api/workspaces/:id` — rename, slug.
  - `DELETE /api/workspaces/:id` — refuses if `tab_count > 0` (matches "delete only when empty" UX).
  - `POST /api/workspaces/reorder`
- `GET /api/tabs?workspaceId=…` (renamed from today's `GET /api/workspaces`) — list tabs in a workspace.
- All other tab/pane endpoints stay the same shape, just with the rename.

Server-side runtime concerns (cwd polling, attention bell, OSC title detection) all remain pane-level. No changes there.

## Web routing

TanStack Router routes:

```
/                                  WorkspacePicker
/w/$wsSlug                         WorkspaceLayout (loads workspace, redirects to first tab)
/w/$wsSlug/t/$tabSlug              TabView (today's WorkspaceView)
/w/$wsSlug/t/$tabSlug/p/$paneId    PaneOpenoutView (today's PopoutView)
/popout/t/$tabSlug                 TabPopoutView (new — chromeless tab)
```

The `WorkspaceLayout` route owns the chrome (workspace switcher + tab bar) and renders the active tab's view via `<Outlet />`.

## UI: chrome

The header bar adopts a workspace switcher next to the brand:

```
[muxpad] [Project Alpha ▾]  | tab1 tab2 tab3 + |  github  settings
```

The `[Project Alpha ▾]` element is a dropdown trigger:

- Click → opens menu listing all workspaces, with the current one indicated. Last item is `+ New workspace`. Selecting another workspace navigates to it.
- Double-click on the trigger → inline rename, same gesture as today's "double-click active tab".

Tab bar remains as today, scoped to the current workspace.

## UI: workspace picker

The `/` page:

- If zero workspaces exist (post-delete-everything): a single "Create your first workspace" CTA. Same shape as today's empty Dashboard.
- Otherwise: a simple list of workspaces (cards or rows). Click to enter. No delete control here — delete only works from inside an empty workspace.

## UI: empty workspace

When a workspace has zero tabs (user closed them all):

- "This workspace has no tabs."
- `+ New tab` (primary CTA).
- "or close this workspace" (subtle text link below).

Mirrors today's empty-tab behavior with the close-workspace link. The "close workspace" link calls `DELETE /api/workspaces/:id`, which only succeeds when the workspace has zero tabs (which it does in this state).

## UI: tab popout

Chromeless route at `/popout/t/:tabSlug` renders the tab's pane mosaic with no workspace chrome and no tab bar. Same shape as today's pane popout (`/p/:paneId`) but for a tab.

Trigger: right-click on a tab in the tab bar → context menu with `Pop out tab`. The right-click context menu is small and added just for this; pane copy/paste right-click items can come later on the same infrastructure.

## What's not in this change

- **No drag tabs between workspaces.** Power-user convenience, deferred.
- **No nested workspaces.** Flat list only.
- **No per-workspace settings.** Theme/font/etc. stay global.
- **No workspace templates** ("create a workspace pre-populated with N tabs").
- **No "open URL in new browser tab" affordance** for tabs. Cmd-click on a tab still works natively (opens `/w/:ws/t/:tab` in a new tab with full chrome) — that's a free side effect, not something we promote.

## Implementation order

1. Schema + migration + new stores + tests.
2. Server routes for workspaces.
3. Rename `Workspace*` → `Tab*` in shared types and server (route paths still old).
4. New routes for tabs (replaces what was workspaces); old routes deleted.
5. Web: rename `Workspace*` modules → `Tab*`; update imports.
6. Web routing: add `/`, `/w/:wsSlug`, nest tab routes.
7. Web chrome: add workspace switcher dropdown next to brand.
8. Web picker page.
9. Web empty-workspace state.
10. Right-click context menu + tab popout route.
11. Polish: tests, TypeScript, build.

Estimated scope: ~1-2 days for one engineer working straight through.
