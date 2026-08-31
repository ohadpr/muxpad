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

/**
 * A web app muxpad detected a shell pane is serving — surfaced so the pane
 * can offer "switch into a web view of this" without the user adding a
 * separate URL pane. `url` is the address to load (already rewritten to a
 * viewer-reachable host where possible — e.g. a tailnet name instead of
 * localhost). `label` is a human tag (from an explicit `muxpad app-url`
 * marker, else null). `source` distinguishes an explicit marker from a
 * URL muxpad scraped out of the pane's output — the chrome can badge /
 * pre-select markers since they're zero-false-positive.
 */
export const AppUrlSchema = z.object({
  url: z.string(),
  label: z.string().nullable().default(null),
  source: z.enum(['marker', 'text']),
});
export type AppUrl = z.infer<typeof AppUrlSchema>;

/**
 * Result of the SERVER-side reachability probe for a pane's web-face URL
 * (GET /api/panes/:id/url-health). Shared because the web face's liveness
 * decision is made from these exact fields.
 *
 * It lives on the server because the browser cannot produce it: the web face
 * probes with `fetch(mode:'no-cors')`, whose opaque response has `status === 0`
 * and no headers — so a healthy 200 and a `tailscale serve` 502 (proxy up,
 * local backend dead) are indistinguishable from the page. The server shares a
 * machine with the app and can read the real status.
 *
 * `reason` is the decision, not just a label: 'gateway' (502/503/504) is the
 * one verdict the browser can never reach on its own, so the client treats it
 * as authoritative; 'unreachable'/'timeout' mean the SERVER couldn't get there,
 * which for a URL only the viewer's network can reach is not the last word.
 */
export const UrlHealthSchema = z.object({
  /** Should the web face mount the iframe? */
  alive: z.boolean(),
  /** Real HTTP status, or null on transport failure/timeout. */
  status: z.number().nullable(),
  reason: z.enum(['ok', 'client_error', 'server_error', 'gateway', 'unreachable', 'timeout']),
  /** Probe round-trip in ms (our cost, not the app's real latency). */
  elapsedMs: z.number(),
});
export type UrlHealth = z.infer<typeof UrlHealthSchema>;
export type UrlHealthReason = UrlHealth['reason'];

/**
 * How an agent pane is asked to behave. 'deep' is the historical (and
 * default) behavior — no extra system-prompt material at all. 'do' overlays
 * the generated `<dataDir>/do-mode.md` contract on top of the harness's
 * normal prompt: decisive, terse, result-first.
 *
 * Stored per PANE (agent sessions are pane-scoped), never per tab — the
 * sidebar deliberately doesn't surface it.
 */
export const AgentModeSchema = z.enum(['do', 'deep']);
export type AgentMode = z.infer<typeof AgentModeSchema>;
export const DEFAULT_AGENT_MODE: AgentMode = 'deep';

/**
 * The ONE status a pane/tab/workspace is in. Five states, mutually exclusive,
 * evaluated in this precedence — highest first:
 *
 *   blocked  wants you NOW.       agent: a question is awaiting an answer;
 *                                 shell: BEL attention. Exactly those two —
 *                                 a runner that gave up is `dead`, below.
 *   working  a turn or a background subagent is running. For a RUNNER-OWNED
 *            pane this is the runner registry, never pty output. For a pane
 *            with no runner it is the pty-output heuristic.
 *   dead     the runner gave up — automatic restarts exhausted.
 *   ready    finished, waiting for YOU (the persisted `unread` flag).
 *   idle     none of the above.
 *
 * Listed in PRECEDENCE order (STATUS_ORDER below), which is why `dead` sits
 * above `ready`: "it crashed" must not be masked by "it finished".
 *
 * `ready`, not `done`: the state is about the READER, not the machine. "done"
 * describes what the agent did and invites the reading "nothing left here";
 * this row is in fact the one with something waiting on it. Renamed wholesale
 * rather than aliased — `status` is decorated fresh on every row the server
 * emits, never persisted, so there is no stored value to migrate. The one
 * cross-version case is a stale cached client seeing `ready`: `rank()` below
 * clamps an unknown status to the bottom and StatusMark draws nothing, so it
 * degrades to a blank (reserved) column rather than throwing.
 *
 * Replaces three physically different conditions previously ORed into one
 * `busy` boolean. `busy` remains a DEPRECATED ALIAS on the same rows for one
 * release, so the CLI and any older client keep working:
 *   busy ≡ status === 'working'
 *
 * `attention` is NOT an alias and deliberately keeps its ORIGINAL meaning —
 * the raw BEL bit. `blocked` is a superset (BEL ∪ an open agent question),
 * and widening `attention` to match it would double-notify: the
 * push bridge fires on `attention`'s rising edge, and the ws layer already
 * pushes explicitly when a question arrives. Read `status` for the new
 * semantics; `attention` still means exactly what it always did.
 *
 * A tab's status is the highest-precedence status among its panes; a
 * workspace's is the highest among its tabs — computed on the server, ALWAYS,
 * collapsed or not (a collapsed workspace used to have no busy signal at all).
 */
export const PaneStatusSchema = z.enum(['blocked', 'working', 'ready', 'dead', 'idle']);
export type PaneStatus = z.infer<typeof PaneStatusSchema>;

/**
 * Precedence order, highest first. Exported so every rollup — pane→tab,
 * tab→workspace, and any future surface — folds through ONE table rather than
 * re-deriving the priority in each renderer (which is how the sidebar and the
 * tab strip came to disagree in the first place).
 *
 * `dead` outranks `ready`: a runner that gave up needs the user's attention
 * more than an unread-but-fine turn does — "it finished" must not mask "it
 * crashed". (The audit's literal order had these two swapped; deliberate
 * deviation.)
 */
export const STATUS_ORDER: readonly PaneStatus[] = ['blocked', 'working', 'dead', 'ready', 'idle'];

/**
 * The higher-precedence of two statuses. The single rollup primitive.
 *
 * An UNKNOWN string (a newer server inventing a status, a hand-built row)
 * clamps to the bottom rather than winning: raw `indexOf` returns -1, which
 * compares as the HIGHEST precedence, so one unrecognised value used to
 * outrank `blocked` and swallow every real signal in a rollup. Degrading an
 * unknown to `idle` loses information; letting it win loses the whole rail.
 */
function rank(s: PaneStatus): number {
  const i = STATUS_ORDER.indexOf(s);
  return i === -1 ? STATUS_ORDER.length : i;
}

export function maxStatus(a: PaneStatus, b: PaneStatus): PaneStatus {
  return rank(a) <= rank(b) ? a : b;
}

/** Fold a list of statuses to the one that should represent them. */
export function rollupStatus(list: Iterable<PaneStatus>): PaneStatus {
  let out: PaneStatus = 'idle';
  for (const s of list) {
    out = maxStatus(out, s);
    if (out === 'blocked') break; // nothing outranks it
  }
  return out;
}

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
  // User-set pane name. Persistent (stored on the row), overriding the
  // live-derived label (terminal title → foreground_cmd → "Pane N") so a
  // rename sticks and isn't clobbered by whatever claude/the shell writes
  // to the terminal title. Null/absent → fall back to the live label.
  name: z.string().nullable().optional(),
  // Which face a shell pane shows. Server-persisted so the choice survives
  // reloads and follows the user across devices (synced via pane.updated
  // events). `face_url` is the web face's chosen URL.
  face: z.enum(['terminal', 'web', 'chat']).default('terminal'),
  face_url: z.string().nullable().default(null),
  // Agent behavior mode (⚡ Do / 🧠 Deep). Meaningful only for agent panes;
  // every other pane carries the 'deep' default and ignores it. Persisted so
  // the choice survives respawns and follows the user across devices.
  mode: AgentModeSchema.default('deep'),
  // Runtime-only fields decorated by the route layer.
  title: z.string().nullable().optional(),
  foreground_cmd: z.string().nullable().optional(),
  // Runtime-only flag. True iff this pane has received a BEL (\x07) since
  // the user last interacted with it. Decorated at the route layer from
  // the ptyd cache (same source as Tab.attention / Workspace.attention).
  attention: z.boolean().optional(),
  // Runtime-only. DEPRECATED ALIAS for `status === 'working'` — kept for one
  // release so the CLI and older clients don't break. New code reads `status`.
  busy: z.boolean().optional(),
  // The pane's single status (see PaneStatusSchema). Runtime-only, decorated at
  // the route layer. Optional so a client can talk to an older server.
  status: PaneStatusSchema.optional(),
  // How many live BACKGROUND subagents are running in this pane. A NUMBER, not
  // a state: rendered as a count badge beside the `working` glyph. 0/absent
  // when none. Sourced from the durable server-owned roster (never a timer).
  agents: z.number().int().nonnegative().optional(),
  // "Done, unreviewed" — an agent turn finished here while you weren't
  // looking (or you manually marked it). Orthogonal to `attention` ("wants
  // you NOW", a red dot): unread is the calm "there are results to read",
  // rendered as a BOLD name (like unread mail), and cleared when you view the
  // pane. DB-persisted (survives restart), not a runtime cache flag.
  unread: z.boolean().optional(),
  // Runtime-only. Web apps muxpad detected this (shell) pane is serving,
  // confirmed listening. Decorated at the route layer from the ptyd cache.
  // Empty/absent for url panes and shells that aren't serving anything.
  app_urls: z.array(AppUrlSchema).optional(),
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
  // A single emoji shown in the navigator's leading icon column. Assigned
  // a random default at creation; user-changeable via the icon picker.
  icon: z.string().optional(),
  layout: LayoutNodeSchema,
  // How the tab arranges its panes on desktop: the react-mosaic tiling
  // ('split', the default) or one-pane-at-a-time with a header strip
  // ('tabbed'). Server-persisted so the choice survives reloads and follows
  // the user across devices, like the pane-level terminal/chat view_mode.
  // Purely a rendering choice — the split layout tree above is kept either
  // way, so flipping back restores the tiling. Optional for rows/servers
  // that predate the column.
  view_mode: z.enum(['split', 'tabbed']).optional(),
  created_at: z.number(),
  updated_at: z.number(),
  // Runtime-only flag. True iff at least one pane in this tab has
  // received a BEL (\x07) since the user last interacted with it.
  attention: z.boolean().optional(),
  // Runtime-only. DEPRECATED ALIAS for `status === 'working'` (see PaneSpec).
  busy: z.boolean().optional(),
  // Rollup: the highest-precedence status among this tab's panes.
  status: PaneStatusSchema.optional(),
  // Sum of live background subagents across this tab's panes.
  agents: z.number().int().nonnegative().optional(),
  // "Done, unreviewed" rollup (bold name). True iff this tab was manually
  // marked unread OR any of its panes is unread (an agent finished a turn
  // there unobserved). Distinct from `attention` (red dot / wants-you);
  // cleared when the tab is viewed.
  unread: z.boolean().optional(),
  // Pinned to the top of its workspace's sidebar block, in the user's manual
  // drag order. Unpinned tabs below the divider are auto-sorted by the server
  // (attention → busy → recency), so pinning is how you opt a tab OUT of the
  // shuffling. DB-persisted. Optional for rows/servers predating the column.
  pinned: z.boolean().optional(),
  // Epoch ms of the last thing that happened in this tab: an agent turn
  // finishing, a user send, or (throttled to one write per minute) pty
  // output. Drives the recency ordering of the unpinned block. Null on rows
  // migrated in before the column existed — those sort last.
  last_activity_at: z.number().nullable().optional(),
  // How many ENABLED crons target a pane in this tab. A schedule is a
  // PROPERTY of a chat, not a status, so it deliberately does NOT ride the
  // status rail (which is transient and mutually exclusive by construction) —
  // it gets the nav row's own META column instead, between the name and the
  // rail. 0 or absent = no schedule. Folded in by decorateTab off ONE
  // pre-read map per list, never a query per row.
  crons: z.number().int().nonnegative().optional(),
  // The soonest-due of those crons — rendered in the meta column as
  // `◷ 07:00` / `◷ Sun 09:00`, localized client-side from the epoch, with the
  // cron's name and full date in the tooltip. Absent when `crons` is 0.
  next_cron: z.object({ name: z.string(), next_due_at: z.number() }).optional(),
  // ONE LINE saying what this chat is currently about — the nav row's second
  // line, under the name. Machine-written from the transcript by a cheap
  // model, DB-persisted, and deliberately sticky: regenerated only when the
  // topic has materially moved, never on every turn (see
  // server/src/chat/headline.ts). Absent is a normal, permanent state — a
  // chat with no agent session never gets one, and the rail simply renders a
  // one-line row. Never a placeholder and never an error string: the rail is
  // a signal surface, and "couldn't summarise" is not a signal.
  headline: z.string().nullable().optional(),
  // True once the USER has named this tab by hand. Permanent, and the
  // auto-namer's hard stop: it may fill an empty or bootstrap name, but once
  // you have chosen one it never touches the name (or the icon) again. This
  // used to be an in-memory Map in ws.ts, which meant every server restart
  // forgot who had named what — the guard held only by the accident that a
  // manual name matched neither the bootstrap sentinel nor the last
  // auto-title.
  name_sticky: z.boolean().optional(),
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
  // System container flag (the hidden workspace the retired resident-pane
  // primitive used as its container; see server/src/resident-release.ts).
  // Hidden workspaces are excluded from GET /api/workspaces (and thus the
  // sidebar tree) unless ?all=1. Optional for servers predating the column.
  hidden: z.boolean().optional(),
  // Runtime-only flag. True iff any pane in any tab in this workspace
  // has rung BEL since the user last interacted with it. The list
  // endpoint folds this in from PaneManager state.
  attention: z.boolean().optional(),
  // "Done, unreviewed" rollup (bold name). True iff any tab in this
  // workspace is unread. Distinct from `attention` (red dot).
  unread: z.boolean().optional(),
  // Rollup: the highest-precedence status across every pane in every tab.
  // Computed ALWAYS — collapsed or not. A collapsed workspace previously had
  // no working signal of any kind, so on a fresh profile (where only the
  // active workspace auto-expands) every agent working elsewhere was invisible.
  status: PaneStatusSchema.optional(),
  // Sum of live background subagents across the whole workspace.
  agents: z.number().int().nonnegative().optional(),
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

// A pane's agent session changed (runner attached/detached, view-mode
// switched, turn started/ended, session id recorded). Deliberately thin —
// pane_id only — the client re-fetches /api/agent-sessions/by-pane/:id, so
// the event can't go stale and the payload can't drift from the store.
export const AgentSessionUpdatedEventSchema = z.object({
  type: z.literal('agent_session.updated'),
  pane_id: z.string(),
});

// An agent turn's lifecycle on the global bus, so a supervisor watching N
// worker panes holds ONE /ws/events (or /api/events SSE) subscription
// instead of N chat sockets. Ids only — no content payload; a subscriber
// that wants the words pulls the transcript. `fatal` means the pane's
// runner reported it is dying (dead workers matter as much as finished
// ones). `sid` is null only for a runner that reached a turn before its
// hello was accepted (defensive — hello always comes first).
export const AgentTurnEventSchema = z.object({
  type: z.literal('agent_turn'),
  pane_id: z.string(),
  phase: z.enum(['start', 'done', 'fatal']),
  sid: z.string().nullable(),
  backend: z.string(),
});

export const MuxpadEventSchema = z.discriminatedUnion('type', [
  PaneAddedEventSchema,
  PaneRemovedEventSchema,
  PaneUpdatedEventSchema,
  AgentSessionUpdatedEventSchema,
  AgentTurnEventSchema,
  TabAddedEventSchema,
  TabUpdatedEventSchema,
  TabRemovedEventSchema,
  WorkspaceAddedEventSchema,
  WorkspaceUpdatedEventSchema,
  WorkspaceRemovedEventSchema,
  ExternalUrlOpenEventSchema,
]);
export type MuxpadEvent = z.infer<typeof MuxpadEventSchema>;
