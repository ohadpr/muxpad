// The Hosted surface — muxpad's two kinds of "thing I put somewhere and can
// point a browser at" (docs/plans/2026-08-30-hosted.md):
//
//   APP       a long-running local web server muxpad supervises. Private
//             (tailnet-only), stateful, has logs, can be started and stopped.
//   ARTIFACT  a static tree copied into the public dir and served to the open
//             internet by the separate public listener. Immutable once
//             published; republishing rotates the previous copy to a version.
//
// The two are deliberately NOT merged. They differ in every axis that matters:
// lifetime (process vs bytes), exposure (private vs public), failure mode
// (crashed vs 404) and the verb that creates them (`muxpad app add` vs
// `muxpad publish`). One list, two kinds — never one primitive.
import { z } from 'zod';
import { type PaneStatus, UrlHealthSchema } from './types.js';

/**
 * What an app is doing RIGHT NOW. Derived on the server from two independent
 * observations — never guessed from the registry row alone:
 *
 *   stopped      `enabled = 0`. The user stopped it (or never started it).
 *                No pty is expected and none is respawned.
 *   starting     a pty exists (or was just asked for) but the URL isn't
 *                answering yet — the normal first seconds of any server.
 *   running      pty alive AND the URL probe says the backend answered.
 *   unreachable  pty alive but the URL probe says otherwise. `reason` carries
 *                which flavour ('gateway' = proxy up, backend dead — the case
 *                a browser can never see).
 *   gave_up      the supervisor exhausted its restart budget. Needs a human.
 *
 * There is deliberately no 'crashed': a pane whose pty died is `starting`,
 * because the supervisor is already bringing it back and saying "crashed"
 * about a thing that self-heals in two seconds is noise. Only an exhausted
 * budget (`gave_up`) is worth alarming about.
 */
export const AppStateSchema = z.enum(['stopped', 'starting', 'running', 'unreachable', 'gave_up']);
export type AppState = z.infer<typeof AppStateSchema>;

/**
 * App state → the FIVE-STATE pane vocabulary (PaneStatusSchema), so the Hosted
 * list draws its marks with the same StatusMark component — and the same
 * colour rule — as the sidebar. There is no second status language in muxpad.
 *
 *   starting     → working      genuinely in progress; the spinner is honest.
 *   gave_up      → blocked      it WANTS YOU: nothing will fix this but a human.
 *   unreachable  → dead         "this one is over" — reported, not demanded.
 *   running      → idle         quiet. The rail draws nothing; the row's own
 *                               label says "running". An always-on server that
 *                               spun forever would make the rail meaningless.
 *   stopped      → idle         same: quiet, and the label carries the nuance.
 *
 * The mapping is intentionally many-to-one. The MARK answers "should I look?";
 * the row's text answers "what exactly?". Inventing a sixth mark so `running`
 * and `stopped` could differ in the rail would have cost the one property that
 * makes the rail scannable — that a mark means the same thing everywhere.
 */
export const APP_STATE_STATUS: Record<AppState, PaneStatus> = {
  stopped: 'idle',
  starting: 'working',
  running: 'idle',
  unreachable: 'dead',
  gave_up: 'blocked',
};

/** Human phrasing for each state. One definition, used by CLI and web. */
export const APP_STATE_LABEL: Record<AppState, string> = {
  stopped: 'stopped',
  starting: 'starting',
  running: 'running',
  unreachable: 'unreachable',
  gave_up: 'gave up',
};

/** Slugs address apps in the CLI and in URLs. Same grammar as publish slugs. */
export const APP_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const AppSchema = z.object({
  id: z.string(),
  /** Stable handle used by the CLI (`muxpad app start notes`) and the UI route. */
  slug: z.string(),
  name: z.string(),
  /** Working directory the command runs in. */
  cwd: z.string(),
  /** The command line, run under `muxpad serve` inside the app's pane. */
  command: z.string(),
  /** Where the app serves. Probed for reachability; opened by the web view. */
  url: z.string(),
  /** Bring it up at boot / on ptyd reconnect. */
  autostart: z.boolean(),
  /** The RUN switch. `muxpad app stop` clears it; nothing respawns a
   *  disabled app, and its pty is killed. */
  enabled: z.boolean(),
  /** The supervised pane in the hidden apps container, or null when the app
   *  has never been materialised (added with --no-start, or stopped). This is
   *  also the LOGS handle — the pane's terminal is the app's log. */
  pane_id: z.string().nullable(),
  created_at: z.number(),
  updated_at: z.number(),
});
export type App = z.infer<typeof AppSchema>;

/** An app plus everything only the running server can know. */
export const AppWithStatusSchema = AppSchema.extend({
  state: AppStateSchema,
  /** Does ptyd hold a pty for this app's pane? `null` = ptyd was unreachable,
   *  which is UNKNOWN, not dead — the same distinction the supervisor makes. */
  pty: z.boolean().nullable(),
  /** Last reachability probe, or null when we have not probed yet. */
  health: UrlHealthSchema.nullable(),
});
export type AppWithStatus = z.infer<typeof AppWithStatusSchema>;

// ── Artifacts ────────────────────────────────────────────────────────────

/**
 * One previous copy of a published slug. `n` is RELATIVE AGE, not an absolute
 * revision: `@2` is always "the one before current", `@3` the one before that.
 *
 * Relative was chosen over monotonic (`@v7`) deliberately. The question a
 * person actually asks is "what did this look like before I broke it", and
 * that is a fixed URL under relative numbering (`/slug/../slug@2/`) while
 * being an unguessable one under monotonic. The cost — a link to `@2` means
 * different bytes after the next publish — is acceptable for a personal
 * rollback aid, and the UI lists versions with their publish dates so nobody
 * has to guess.
 */
export const ArtifactVersionSchema = z.object({
  /** 2 = previous, 3 = the one before that, … */
  n: z.number().int().min(2),
  files: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  created: z.number(),
  /** Public URL of this exact version — null until a public base is known,
   *  exactly like ArtifactSchema.url. (It was declared non-nullable while the
   *  route already returned null; nothing parses this schema, so the lie was
   *  inert, but it made the client's `?? '#'` fallback read as dead code.) */
  url: z.string().nullable(),
});
export type ArtifactVersion = z.infer<typeof ArtifactVersionSchema>;

export const ArtifactSchema = z.object({
  slug: z.string(),
  files: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  created: z.number(),
  /** Public URL of the CURRENT version, when a public base is known. */
  url: z.string().nullable(),
  versions: z.array(ArtifactVersionSchema),
});
export type Artifact = z.infer<typeof ArtifactSchema>;

/**
 * Where every published link is being built from, and whether it answers.
 *
 * Surfaced because the failure it describes is silent otherwise: a tunnel whose
 * process died, or a base pointing at a port the recipient's network blocks,
 * makes EVERY link on the page useless while the page itself looks perfectly
 * healthy. `source` names which rung of the precedence chain won, so "why is my
 * link wrong" is answerable from the UI.
 */
export const PublicBaseInfoSchema = z.object({
  /** null = no shareable base; links would be loopback-only. */
  url: z.string().nullable(),
  source: z.enum(['env', 'pinned', 'hint', 'funnel', 'persisted', 'local']),
  /** null = not checked. */
  reachable: z.boolean().nullable(),
  warning: z.string().optional(),
});
export type PublicBaseInfo = z.infer<typeof PublicBaseInfoSchema>;
