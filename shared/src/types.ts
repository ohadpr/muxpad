import { z } from 'zod';

export type LayoutNode =
  | string
  | {
      direction: 'row' | 'column';
      splitPercentage?: number | undefined;
      first: LayoutNode;
      second: LayoutNode;
    };

export const LayoutNodeSchema: z.ZodType<LayoutNode> = z.lazy(() =>
  z.union([
    z.string(),
    z.object({
      direction: z.enum(['row', 'column']),
      splitPercentage: z.number().min(0).max(100).optional(),
      first: LayoutNodeSchema,
      second: LayoutNodeSchema,
    }),
  ]),
);

export const PaneSpecSchema = z.object({
  id: z.string(),
  tab_id: z.string(),
  kind: z.enum(['shell', 'url']).default('shell'),
  url: z.string().nullable().default(null),
  // shell/cwd are required for kind='shell', null for kind='url'.
  shell: z.string().nullable().default(null),
  startup_cmd: z.string().nullable().default(null),
  cwd: z.string().nullable().default(null),
  env: z.record(z.string()).nullable().default(null),
  created_at: z.number(),
  // Runtime-only fields decorated by the route layer.
  title: z.string().nullable().optional(),
  foreground_cmd: z.string().nullable().optional(),
});
export type PaneSpec = z.infer<typeof PaneSpecSchema>;

/**
 * A tab in the bar — what was historically called "workspace". Owns a
 * layout (binary tree of pane ids) and N panes. Belongs to a parent
 * workspace via tab_id (server-side field on tab rows).
 */
export const TabSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  layout: LayoutNodeSchema,
  created_at: z.number(),
  updated_at: z.number(),
  // Runtime-only flag. True iff at least one pane in this tab has
  // received a BEL (\x07) since the user last interacted with it.
  attention: z.boolean().optional(),
});
export type Tab = z.infer<typeof TabSchema>;

/**
 * The new top-level concept. A workspace contains tabs. The picker at `/`
 * lists workspaces; clicking one navigates into its tab bar.
 */
export const WorkspaceSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  position: z.number().int(),
  created_at: z.number(),
  updated_at: z.number(),
  // Derived at read time; not stored in the DB.
  tab_count: z.number().int().nonnegative(),
  // Runtime-only flag. True iff any pane in any tab in this workspace
  // has rung BEL since the user last interacted with it. The list
  // endpoint folds this in from PaneManager state.
  attention: z.boolean().optional(),
});
export type Workspace = z.infer<typeof WorkspaceSchema>;

// ── Event protocol ──────────────────────────────────────────────────────
// Pushed over /ws/events whenever structural state changes (panes/tabs/
// workspaces add/remove/update). PTY data still flows on the per-pane WS.

export const PaneAddedEventSchema = z.object({
  type: z.literal('pane.added'),
  tab_id: z.string(),
  pane: PaneSpecSchema,
});
export const PaneRemovedEventSchema = z.object({
  type: z.literal('pane.removed'),
  tab_id: z.string(),
  pane_id: z.string(),
});
export const PaneUpdatedEventSchema = z.object({
  type: z.literal('pane.updated'),
  tab_id: z.string(),
  pane: PaneSpecSchema,
});
export const TabAddedEventSchema = z.object({
  type: z.literal('tab.added'),
  workspace_id: z.string(),
  tab: TabSchema,
});
export const TabUpdatedEventSchema = z.object({
  type: z.literal('tab.updated'),
  tab: TabSchema,
});
export const TabRemovedEventSchema = z.object({
  type: z.literal('tab.removed'),
  workspace_id: z.string(),
  tab_id: z.string(),
});
export const WorkspaceAddedEventSchema = z.object({
  type: z.literal('workspace.added'),
  workspace: WorkspaceSchema,
});
export const WorkspaceUpdatedEventSchema = z.object({
  type: z.literal('workspace.updated'),
  workspace: WorkspaceSchema,
});
export const WorkspaceRemovedEventSchema = z.object({
  type: z.literal('workspace.removed'),
  workspace_id: z.string(),
});

// Request to open a URL in a new real browser tab (window.open), not as
// an iframe pane. The web client surfaces this as a clickable toast so
// the actual window.open() call lands inside a user-gesture handler and
// bypasses popup blockers. `tab_id` scopes the toast to browser clients
// currently viewing that muxpad tab (so you don't get duplicate prompts
// across other tabs / multiple open browser windows). `pane_id` is
// passed through verbatim; the web client resolves it to a display
// label using the same logic as the pane chrome, so the toast and the
// tile header always agree.
export const ExternalUrlOpenEventSchema = z.object({
  type: z.literal('external_url.open'),
  url: z.string().min(1),
  tab_id: z.string().optional(),
  pane_id: z.string().optional(),
});

export const MuxpadEventSchema = z.discriminatedUnion('type', [
  PaneAddedEventSchema,
  PaneRemovedEventSchema,
  PaneUpdatedEventSchema,
  TabAddedEventSchema,
  TabUpdatedEventSchema,
  TabRemovedEventSchema,
  WorkspaceAddedEventSchema,
  WorkspaceUpdatedEventSchema,
  WorkspaceRemovedEventSchema,
  ExternalUrlOpenEventSchema,
]);
export type MuxpadEvent = z.infer<typeof MuxpadEventSchema>;
