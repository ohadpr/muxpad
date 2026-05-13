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
  shell: z.string(),
  startup_cmd: z.string().nullable().default(null),
  cwd: z.string(),
  env: z.record(z.string()).nullable().default(null),
  created_at: z.number(),
  // Runtime-only fields, folded in by the route layer from PaneManager
  // state (not stored in the DB). Used to label the pane in the UI.
  // title is the latest OSC 0/1/2 set by the program in the pane;
  // foreground_cmd is the basename of the foreground process (e.g.
  // 'claude', 'vim', 'zsh'). Either or both can be missing.
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
});
export type Workspace = z.infer<typeof WorkspaceSchema>;
