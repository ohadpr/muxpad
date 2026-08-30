import { EventEmitter } from 'node:events';
import type { AppUrl, PaneSpec, PaneStatus, Tab, Workspace } from '@muxpad/shared';
import { rollupStatus } from '@muxpad/shared';
import type Database from 'better-sqlite3';
import type { PtydClient } from './ptyd-client/PtydClient.js';
import { AppUrlDetector } from './runtime/app-url-detector.js';
import type { AppUrlMarker } from './runtime/pty-scanner.js';
import { PaneStore } from './store/PaneStore.js';
import { TabStore } from './store/TabStore.js';

/**
 * Per-pane decoration state cached on the main server from ptyd push events.
 *
 * Fields:
 *  - `cwd` / `fg` are read synchronously by HTTP handlers (workspace lists,
 *    cwd-inherit-from-sibling) — round-tripping to ptyd for every list call
 *    would add latency to a hot path.
 *  - `title` / `attention` are read synchronously by the tab GET handler
 *    (which decorates each pane row with title/foreground_cmd) and by the
 *    workspace list (which folds attention across every pane in every tab).
 *
 * The shape mirrors the legacy in-process `PaneManager.emitDecorations`
 * snapshot: cache the same fields the main server used to read directly
 * off the runtime, but now sourced from ptyd's `paneCwd` / `paneFg` /
 * `paneTitle` / `paneAttention` events plus the initial `flushCwds()` seed
 * on (re)connect.
 *
 * Cold start: `cwd` is seeded synchronously from `PaneStore.listCwds()`
 * (see `seedCwds` and the main entry's startup wiring). `title`,
 * `foreground_cmd`, and `attention` are NOT seeded — they live only in
 * ptyd's memory. During the window between HTTP start and the first
 * ptyd-event for a given pane those fields read as null. Acceptable
 * trade — the web side renders nulls gracefully. Future-me should not
 * "fix" this by seeding from SQLite, because those values aren't
 * persisted there.
 */
export interface PaneState {
  cwd?: string;
  fg?: string | null;
  title?: string | null;
  attention?: boolean;
  // True while the pane is actively producing output (foreground app
  // working). Computed HERE from ptyd's raw `paneActivity` ticks + a decay
  // timer (see markBusy / busyQuietMs) — ptyd ships only the raw ticks so this
  // policy is a server-only restart away. Read synchronously by the
  // tab/workspace list handlers to roll a "busy" flag up to each tab.
  busy?: boolean;
  appUrls?: AppUrl[];
}

/**
 * Listens to PtydClient events and maintains a per-pane snapshot. Emits a
 * single 'paneChange' event after any field mutates so consumers (the main
 * server's `emitPaneUpdated` helper) can rebuild the decorated pane row in
 * one place.
 *
 * Lifecycle:
 *  - `paneCwd` / `paneFg` / `paneTitle` / `paneAttention` → upsert field,
 *    fire 'paneChange'.
 *  - `paneExit` → drop the entry entirely (no event — consumer will get a
 *    matching `pane.removed` from the route layer or react to `paneExit`
 *    on the client directly).
 *  - `connected` → seed `cwd` for every live runtime via `flushCwds()`.
 *    Other fields will populate as their respective events arrive.
 */
export class PtydCache extends EventEmitter {
  private state = new Map<string, PaneState>();
  // Non-null only while a `connected`-driven `flushCwds()` is inflight.
  // The paneCwd handler appends to it during that window; the connected
  // handler reads it after the snapshot resolves to skip ids that got a
  // fresher event mid-flight. Outside the window the field is null and
  // the paneCwd handler's `?.add` is a no-op — so the set never grows
  // beyond a single inflight flushCwds.
  private cwdEventRacers: Set<string> | null = null;
  // Server-side app-url detection. ptyd ships raw URL sightings
  // (`paneUrlsSeen`); the detector classifies hosts + probes for a listener
  // and writes the confirmed list back into the cache. It lives here so this
  // logic is a server-only restart away — never a ptyd bounce.
  private readonly detector = new AppUrlDetector((paneId, urls) => {
    this.setAppUrls(paneId, urls);
  });
  // Per-pane decay timers for busy state. Armed/reset on each `paneActivity`
  // tick; on fire the pane goes idle. Cleared on pane removal so a pending
  // timer can't resurrect a deleted entry via update({busy:false}).
  private readonly busyTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // First activity tick of the current spell, per pane, while still "warming
  // up" (not yet declared busy). Cleared once busy flips true, or when the
  // decay timer fires. See markBusy / busyWarmupMs.
  private readonly busyPending = new Map<string, number>();
  // Timestamp of the last user keystroke per pane (from proxyAttach's onInput).
  // Activity within busyInputGraceMs of this is treated as echo, not work.
  private readonly lastInputAt = new Map<string, number>();
  // Timestamp of the last activity tick that was NOT echo, per pane. Bounds how
  // long the user's own typing may keep an already-busy spell alive — see
  // markBusy's echo block.
  private readonly lastRealActivityAt = new Map<string, number>();
  // Panes with a headless (web-chat-driven) agent turn in flight. A chat turn
  // is a separate `claude -p` process writing the transcript FILE — it produces
  // zero PTY output, so the activity detector above never sees it. The ws chat
  // layer flips this on turn start/finish; getBusy() ORs it in, which is what
  // makes the tab/workspace spinners cover chat work like terminal work. Kept
  // OUTSIDE PaneState so PTY lifecycle (paneExit dropping the entry) can't
  // clear a turn that's still running.
  private readonly agentBusy = new Set<string>();
  // How many live BACKGROUND subagents each pane has, mirrored from the ws
  // layer's DURABLE server-owned roster (conn.subagents). A run_in_background
  // Task routinely outlives the turn that launched it, so a pane with an empty
  // turn and a non-empty roster is still working.
  //
  // This replaced a 15s decay timer poked by each out-of-turn subagent frame.
  // The timer over-reported by a designed 15s (the sidebar and the in-pane
  // roster disagreed by contract) and under-reported far worse: measured (P1,
  // 2026-08) a live background subagent parked in one tool call emits nothing
  // for 44s+, so the window expired under a running agent. The roster has real
  // launch and finish edges — no window can be right, so there is no window.
  private readonly subagentCounts = new Map<string, number>();
  // Panes whose agent is BLOCKED on the user: a `question` frame is awaiting an
  // answer. Previously the question frame reached chat sockets and a push
  // notification and touched NOTHING else — so a chat parked on ask_user read
  // as plain idle in the nav, the single highest-value missing state. Kept here
  // (not in PaneState) for the same reason as agentBusy: pty lifecycle must not
  // be able to clear it.
  private readonly blocked = new Set<string>();
  // Panes whose runner exhausted its automatic restarts (respawns.gaveUp) or
  // reported a fatal it can't come back from. Mirrored from the ws layer.
  private readonly dead = new Set<string>();
  // Panes owned by a connected agent runner. THE gate for the pty heuristic:
  // for these panes "working" is the runner registry and pty output is not a
  // status source at all (a `tail -f` in an agent pane's terminal face used to
  // spin forever, and a quietly-thinking agent read idle).
  private readonly runnerOwned = new Set<string>();
  private readonly busyQuietMs: number;
  private readonly busyWarmupMs: number;
  private readonly busyInputGraceMs: number;
  private readonly busyEchoSustainMs: number;

  /**
   * @param opts.busyQuietMs How long a pane may go without an activity tick
   *   before it's marked idle ("done / waiting"). This is the busy POLICY, and
   *   it lives here (not in ptyd) precisely so it can be tuned with a
   *   server-only restart. Must exceed ptyd's activity throttle AND the slowest
   *   steady output heartbeat we still want to read as busy — e.g. Claude's 1s
   *   elapsed-timer tick — so it doesn't flicker to idle mid-work. Default
   *   1500ms: clears the 1s tick with margin, ~1.5s lag before "done" shows.
   * @param opts.busyWarmupMs How long output must be SUSTAINED before a pane is
   *   declared busy. Filters one-off bursts that aren't real work — chiefly the
   *   single redraw a foreground app emits when a tab is opened (the attach
   *   resizes the PTY → SIGWINCH → one repaint), but also quick commands that
   *   finish instantly. Genuine work (Claude thinking, a running build) streams
   *   well past this. Default 600ms.
   * @param opts.busyInputGraceMs After a user keystroke (noteInput), output
   *   within this window is treated as the echo of their typing — not the app
   *   working — and doesn't count toward busy. So typing into a pane (incl. a
   *   TUI that repaints its input on each key, like Claude's composer) doesn't
   *   light the spinner. A command's own output keeps streaming past the grace
   *   and still trips busy. Default 500ms.
   * @param opts.busyEchoSustainMs How long the user's TYPING alone may keep an
   *   already-busy pane busy, measured from the last non-echo tick. Activity
   *   ticks can't be attributed at this layer, so a pane that is streaming
   *   while you type looks identical to one that went quiet while you type.
   *   This bounds the ambiguity in the safe direction: the real case (typing a
   *   message at a working prompt) is seconds; beyond this the pane is allowed
   *   to decay. Default 10s.
   */
  constructor(
    opts: {
      busyQuietMs?: number;
      busyWarmupMs?: number;
      busyInputGraceMs?: number;
      busyEchoSustainMs?: number;
    } = {},
  ) {
    super();
    this.busyQuietMs = opts.busyQuietMs ?? 1500;
    this.busyWarmupMs = opts.busyWarmupMs ?? 600;
    this.busyInputGraceMs = opts.busyInputGraceMs ?? 500;
    this.busyEchoSustainMs = opts.busyEchoSustainMs ?? 10_000;
  }

  /**
   * Record that the user just typed into a pane. Activity ticks arriving within
   * busyInputGraceMs are then discounted as echo (see markBusy). Called by the
   * WS proxy on each OP_INPUT frame — server-side, so no ptyd involvement.
   */
  noteInput(id: string): void {
    this.lastInputAt.set(id, Date.now());
  }

  attach(client: PtydClient): void {
    client.on('paneCwd', (e: { id: string; cwd: string }) => {
      this.cwdEventRacers?.add(e.id);
      this.update(e.id, { cwd: e.cwd });
    });
    client.on('paneFg', (e: { id: string; cmd: string | null }) => {
      this.update(e.id, { fg: e.cmd });
    });
    client.on('paneTitle', (e: { id: string; title: string | null }) => {
      this.update(e.id, { title: e.title });
    });
    client.on('paneAttention', (e: { id: string; attention: boolean }) => {
      this.update(e.id, { attention: e.attention });
    });
    client.on('paneActivity', (e: { id: string }) => {
      this.markBusy(e.id);
    });
    client.on('paneUrlsSeen', (e: { id: string; urls: string[]; markers: AppUrlMarker[] }) => {
      // Raw sightings from ptyd's scanner. Hand them to the detector, which
      // probes/classifies and calls back (its onAppUrls) into update() with
      // the confirmed list once it changes.
      this.detector.ingest(e.id, e.urls, e.markers);
    });
    client.on('paneExit', (e: { id: string }) => {
      // Drop the entry on exit so a respawned pane (same id) starts with a
      // clean slate. If the row still exists (delete is a separate
      // operation) the next ensurePane will surface fresh events to
      // repopulate the cache.
      this.clearBusyTimer(e.id);
      this.detector.forget(e.id);
      if (this.state.delete(e.id)) {
        this.emit('paneRemoved', e.id);
      }
    });
    client.on('connected', async () => {
      // Refresh cwds from the live ptyd snapshot. The cache is NOT cleared
      // on `disconnected` (other consumers still want the last-known cwd
      // while reconnect is in flight), and ptyd's `paneCwd` events only
      // fire on *change*. So on a clean reconnect we can't rely on events
      // alone to wash out stale values — we need to take a full snapshot.
      //
      // Race: between ptyd taking the snapshot and the response arriving
      // here, a `paneCwd` event may have already been broadcast with a
      // fresher value. We track ids that received paneCwd events during
      // the inflight window; for those ids the snapshot is stale and we
      // must NOT clobber the cache. For everyone else we overwrite (this
      // is the path that washes out pre-disconnect stale values).
      //
      // The racer set is scoped to this invocation — assigned to the
      // field for the paneCwd handler to populate, cleared in `finally`
      // so steady-state events don't accumulate ids forever.
      const racers = new Set<string>();
      this.cwdEventRacers = racers;
      try {
        const entries = await client.flushCwds();
        for (const { id, cwd } of entries) {
          if (racers.has(id)) continue;
          this.update(id, { cwd });
        }
      } catch {
        // ignore — cache will fill in via paneCwd events
      } finally {
        if (this.cwdEventRacers === racers) this.cwdEventRacers = null;
      }
    });
  }

  /**
   * Fold a raw activity tick into busy state. Two gates:
   *  - WARMUP: don't declare busy on the first tick — wait until output has
   *    been sustained for busyWarmupMs. A one-off burst (the redraw a tab emits
   *    when opened, a quick command) never crosses it, so it doesn't blip the
   *    spinner; real work streams well past it.
   *  - DECAY: once busy, stay busy until busyQuietMs of silence.
   * update() only emits paneChange on the actual false→true / true→false edge,
   * so sustained output doesn't spam consumers.
   */
  private markBusy(id: string): void {
    const now = Date.now();
    // Echo of the user's own typing isn't "busy work": activity within
    // busyInputGraceMs of their last keystroke must not accumulate warmup, so a
    // TUI repainting its composer on every key doesn't light the spinner.
    //
    // But echo must not SHORT-CIRCUIT. This used to `return` before the decay
    // block below, so typing into an ALREADY-BUSY pane at sub-grace intervals
    // starved the re-arm: busy expired busyQuietMs later while the app was
    // plainly still streaming, and the spinner went dark mid-work purely
    // because the user was typing. Echo suppresses the RISE; it may also SUSTAIN
    // a spell that is already running.
    //
    // "Sustain" is bounded, though, and the bound matters. Ticks are
    // indistinguishable at this layer — we only know one landed near a
    // keystroke — so if echo could extend indefinitely, typing steadily into a
    // pane that had gone quiet would hold it `working` forever. The extension
    // is therefore capped at busyEchoSustainMs past the last NON-echo tick:
    // long enough to cover the real case (composing a message while the app
    // streams, seconds), far short of "typing keeps it lit all afternoon".
    const alreadyBusy = this.state.get(id)?.busy === true;
    const isEcho = now - (this.lastInputAt.get(id) ?? 0) < this.busyInputGraceMs;
    if (isEcho && !alreadyBusy) return;
    if (isEcho) {
      const lastReal = this.lastRealActivityAt.get(id) ?? 0;
      if (now - lastReal > this.busyEchoSustainMs) return;
    } else {
      this.lastRealActivityAt.set(id, now);
    }
    if (!alreadyBusy) {
      const firstAt = this.busyPending.get(id);
      if (firstAt === undefined) {
        // First tick of a new spell — start warming up, don't show busy yet.
        this.busyPending.set(id, now);
      } else if (now - firstAt >= this.busyWarmupMs) {
        // Output has persisted past the warmup window → it's real work.
        this.busyPending.delete(id);
        this.update(id, { busy: true });
      }
      // else: still within the warmup window — keep waiting for more ticks.
    }
    // (re)arm the decay timer: on fire, drop busy AND abandon any warmup in
    // progress (the spell ended before it qualified).
    const existing = this.busyTimers.get(id);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      this.busyTimers.delete(id);
      this.busyPending.delete(id);
      // Only emit the idle transition if we actually went busy — a warmup that
      // never qualified (a transient burst) must leave no trace, not flip an
      // undefined busy to false (which would fan a needless pane.updated).
      if (this.state.get(id)?.busy === true) this.update(id, { busy: false });
    }, this.busyQuietMs);
    // Don't let a pending decay timer keep the process alive.
    t.unref?.();
    this.busyTimers.set(id, t);
  }

  /** Cancel a pane's decay/warmup state (on removal) so nothing fires post-delete. */
  private clearBusyTimer(id: string): void {
    const t = this.busyTimers.get(id);
    if (t) {
      clearTimeout(t);
      this.busyTimers.delete(id);
    }
    this.busyPending.delete(id);
    this.lastInputAt.delete(id);
    this.lastRealActivityAt.delete(id);
  }

  private update(id: string, patch: PaneState): void {
    const prev = this.state.get(id) ?? {};
    const next: PaneState = { ...prev };
    let changed = false;
    for (const k of Object.keys(patch) as (keyof PaneState)[]) {
      const v = patch[k];
      if (prev[k] !== v) {
        // The cast is necessary because each field has its own type; the
        // Object.keys loop loses that fidelity for the compiler.
        (next as Record<string, unknown>)[k] = v;
        changed = true;
      }
    }
    if (!changed) return;
    this.state.set(id, next);
    this.emit('paneChange', id);
  }

  /**
   * Pre-populate cwd for known panes before ptyd's `connected` → `flushCwds()`
   * has had a chance to fire. The main server calls this on startup with
   * the last-known cwd persisted in SQLite so cwd-dependent handlers don't
   * see null during the (small but real) window between HTTP-start and the
   * first ptyd reply. Entries for ids already in the cache are skipped —
   * a real event from ptyd is always more trustworthy than the stale seed.
   */
  seedCwds(entries: Array<{ id: string; cwd: string }>): void {
    for (const { id, cwd } of entries) {
      if (this.state.has(id)) continue;
      this.state.set(id, { cwd });
    }
  }

  /** Synchronous read — returns null when ptyd hasn't reported a cwd yet. */
  getCwd(id: string): string | null {
    return this.state.get(id)?.cwd ?? null;
  }

  /** Synchronous read — null when fg hasn't resolved or pane has no fg. */
  getFg(id: string): string | null {
    const s = this.state.get(id);
    if (!s || s.fg === undefined) return null;
    return s.fg;
  }

  /** Synchronous read — null when ptyd hasn't reported a title yet. */
  getTitle(id: string): string | null {
    const s = this.state.get(id);
    if (!s || s.title === undefined) return null;
    return s.title;
  }

  /** Synchronous read — false when ptyd hasn't reported attention. */
  getAttention(id: string): boolean {
    return this.state.get(id)?.attention ?? false;
  }

  /**
   * Synchronous read — false when ptyd hasn't reported busy state yet.
   * Busy = PTY output activity OR a headless chat turn in flight (see
   * setAgentBusy) — both mean "this pane's agent is working".
   */
  getBusy(id: string): boolean {
    return this.getStatus(id, false) === 'working';
  }

  /**
   * The pane's ONE status (see PaneStatus). Precedence, highest first:
   *
   *   blocked  a question awaits the user, or a BEL rang. Those two only — a
   *            runner that gave up is `dead`, two lines down.
   *   working  a turn is in flight, OR the durable subagent roster is non-empty,
   *            OR — only for a pane with NO runner — the pty output heuristic
   *   dead     the runner gave up (outranks done: a crash must not be masked
   *            by an unread turn)
   *   done     `unread` (passed in; it lives on the DB row, not here)
   *   idle     otherwise
   *
   * The pty heuristic is gated to RUNNER-LESS panes on purpose. For a
   * runner-owned pane the registry is authoritative and pty output is noise:
   * the runner's own terminal log makes it "busy" while it idles, and a
   * silently-thinking agent produces no output at all. Every other consumer in
   * the codebase already says not to trust `busy` for turn state — this makes
   * the sidebar agree with them.
   */
  getStatus(id: string, unread: boolean): PaneStatus {
    if (this.blocked.has(id) || (this.state.get(id)?.attention ?? false)) return 'blocked';
    const runnerWorking = this.agentBusy.has(id) || (this.subagentCounts.get(id) ?? 0) > 0;
    const ptyWorking = !this.runnerOwned.has(id) && (this.state.get(id)?.busy ?? false);
    if (runnerWorking || ptyWorking) return 'working';
    if (this.dead.has(id)) return 'dead';
    if (unread) return 'done';
    return 'idle';
  }

  /** The pane's agent is waiting on an answer (a `question` frame is open). */
  setBlocked(id: string, on: boolean): void {
    if (on === this.blocked.has(id)) return;
    const before = this.getStatus(id, false);
    if (on) this.blocked.add(id);
    else this.blocked.delete(id);
    if (this.getStatus(id, false) !== before) this.emit('paneChange', id);
  }

  /**
   * Has this pane's runner given up (automatic restarts exhausted)? The RAW
   * bit, not the rolled-up status — `getStatus` ranks `working` above `dead`,
   * so a corpse whose pty is still dribbling output reads as `working` there.
   * That precedence is right for the nav (a spinner is more informative than a
   * ×) but wrong for a caller deciding "is it worth sending to this pane",
   * which is exactly when the mask hurts most.
   */
  isDead(id: string): boolean {
    return this.dead.has(id);
  }

  /** The pane's runner gave up (automatic restarts exhausted). */
  setDead(id: string, on: boolean): void {
    if (on === this.dead.has(id)) return;
    const before = this.getStatus(id, false);
    if (on) this.dead.add(id);
    else this.dead.delete(id);
    if (this.getStatus(id, false) !== before) this.emit('paneChange', id);
  }

  /**
   * Register/unregister the pane as runner-owned. Flipping this can change the
   * pane's status on its own — a runner attaching disqualifies whatever pty
   * output was holding `working` — so it is edge-checked like the others.
   */
  setRunnerOwned(id: string, on: boolean): void {
    if (on === this.runnerOwned.has(id)) return;
    const before = this.getStatus(id, false);
    if (on) this.runnerOwned.add(id);
    else this.runnerOwned.delete(id);
    if (this.getStatus(id, false) !== before) this.emit('paneChange', id);
  }

  /** How many live background subagents this pane has (0 when none). Rendered
   *  as a count badge on the working glyph — a number, not a state. */
  getSubagentCount(id: string): number {
    return this.subagentCounts.get(id) ?? 0;
  }

  /**
   * Mirror the ws layer's durable subagent roster size onto the pane. Emits
   * 'paneChange' when the COUNT changes — the badge shows the number, so a
   * second subagent starting is a real visible change — but NOT when the runner
   * merely re-announces the same roster on its keepalive tick.
   */
  setSubagentCount(id: string, n: number): void {
    const prev = this.subagentCounts.get(id) ?? 0;
    if (prev === n) return;
    if (n > 0) this.subagentCounts.set(id, n);
    else this.subagentCounts.delete(id);
    this.emit('paneChange', id);
  }

  /**
   * Mark a pane busy because a headless (web-chat-driven) agent turn started/
   * finished there. Emits 'paneChange' only when the EFFECTIVE busy value
   * flips (PTY-output busy may already hold it true), so consumers see the
   * same edge-triggered contract markBusy provides and a chat turn fans a
   * live `pane.updated` the moment it starts and ends.
   */
  setAgentBusy(id: string, on: boolean): void {
    if (on === this.agentBusy.has(id)) return;
    const before = this.getStatus(id, false);
    if (on) this.agentBusy.add(id);
    else this.agentBusy.delete(id);
    if (this.getStatus(id, false) !== before) this.emit('paneChange', id);
  }

  /** Synchronous read — empty array when no app urls have been reported. */
  getAppUrls(id: string): AppUrl[] {
    return this.state.get(id)?.appUrls ?? [];
  }

  /**
   * The confirmed app-url list for a pane. The detector's own callback is the
   * production writer; named and public (rather than an inline `update`) so
   * the write side is as visible as `setDead`/`setBlocked`, and so a test can
   * put the cache in the state a real detection produces without standing up
   * sockets and DNS.
   */
  setAppUrls(id: string, urls: AppUrl[]): void {
    this.update(id, { appUrls: urls });
  }

  /** Returns the full snapshot for the given pane, or undefined when unknown. */
  get(id: string): PaneState | undefined {
    return this.state.get(id);
  }

  /** Drop the entry for `id`. Used by route handlers on DELETE /api/panes/:id. */
  forget(id: string): void {
    this.clearBusyTimer(id);
    this.agentBusy.delete(id);
    this.subagentCounts.delete(id);
    this.blocked.delete(id);
    this.dead.delete(id);
    this.runnerOwned.delete(id);
    this.detector.forget(id);
    if (this.state.delete(id)) {
      this.emit('paneRemoved', id);
    }
  }
}

/**
 * Decorate a stored pane row with its live runtime fields (title, foreground
 * command, attention/busy flags, detected app urls) from the cache. The single
 * place this composition lives: the tab GET, the pane-move endpoint, and the
 * ptyd→`pane.updated` forwarder all route through it, so a pane is described
 * identically however it's surfaced. EVERY `pane.updated` emitter routes
 * through this — a hand-built partial payload silently blanks `busy` on the
 * client and poisons the sidebar's change-dedup signature.
 */
export function decoratePane(cache: PtydCache, pane: PaneSpec): PaneSpec {
  const status = cache.getStatus(pane.id, pane.unread === true);
  return {
    ...pane,
    title: cache.getTitle(pane.id),
    foreground_cmd: cache.getFg(pane.id),
    // `attention` keeps its ORIGINAL meaning — the raw BEL bit — deliberately.
    // The new `blocked` state is a superset (BEL ∪ an open question), and
    // widening this field would double-notify: attachAttentionPush
    // fires on its rising edge, and the ws layer already pushes explicitly when
    // a question arrives. Old clients keep exactly the behaviour they had.
    attention: cache.getAttention(pane.id),
    // Deprecated alias, exact by construction.
    busy: status === 'working',
    status,
    agents: cache.getSubagentCount(pane.id),
    app_urls: cache.getAppUrls(pane.id),
  };
}

/**
 * The tab-level equivalent of {@link decoratePane}: fold the live status of
 * every pane in the tab (plus the tab's own manual unread mark) into the row.
 *
 * WHY THIS EXISTS. The tab LIST computed these fields inline while every
 * `tab.updated` / `tab.added` emitter shipped the raw TabStore row — no
 * `status`, no `agents`, no `attention`. Clients coalesce events onto their
 * cached row, so an absent field reads as undefined and BLANKS the sidebar's
 * status rail until the next 5s poll: rename a tab mid-turn and its spinner
 * vanished. Same invariant decoratePane already enforces for panes — EVERY
 * emitter routes through here.
 */
export function decorateTab(
  cache: PtydCache,
  db: Database.Database,
  tab: Tab,
  /** Pre-read manual-unread set, when the caller already has one for the
   *  whole workspace (the list path) — saves a query per row. */
  manualUnreadIds?: ReadonlySet<string>,
  /** Pre-read cron summary per tab, for the same reason (see cronsByTab). */
  cronsByTabId?: ReadonlyMap<string, TabCronSummary>,
): Tab {
  const panes = new PaneStore(db);
  const tabs = new TabStore(db);
  const manualUnread = manualUnreadIds?.has(tab.id) ?? tabs.isUnread(tab.id);
  const tabPanes = panes.listByTab(tab.id);
  const attention = tabPanes.some((p) => cache.getAttention(p.id));
  const unread = manualUnread || tabPanes.some((p) => p.unread);
  // The tab's status is the highest-precedence status among its panes, and a
  // manual "mark unread" counts as a done pane. One rollup primitive for every
  // level, so the tab strip and the sidebar can't drift apart.
  const status = rollupStatus([
    ...tabPanes.map((p) => cache.getStatus(p.id, p.unread === true)),
    ...(manualUnread ? (['done'] as const) : []),
  ]);
  const agents = tabPanes.reduce((n, p) => n + cache.getSubagentCount(p.id), 0);
  // A SCHEDULE, not a status: folded in here (rather than queried per row in
  // the client or the renderer) so the sidebar costs ONE cron query per list,
  // not one per tab. Absent when the tab has none, so the payload — and the
  // client's change-dedup signature — is unchanged for every tab without a cron.
  const cron = cronsByTabId ? cronsByTabId.get(tab.id) : cronsForTab(db, tab.id);
  // Deprecated alias, exact by construction (see PaneStatusSchema).
  return {
    ...tab,
    attention,
    unread,
    busy: status === 'working',
    status,
    agents,
    ...(cron ? { crons: cron.count, next_cron: cron.next } : {}),
  };
}

/** Per-tab cron rollup: how many enabled crons target its panes, and which
 *  fires soonest (the ⏱ tooltip). */
export interface TabCronSummary {
  count: number;
  next: { name: string; next_due_at: number };
}

interface CronTabRow {
  tab_id: string;
  name: string;
  next_due_at: number;
}

/**
 * ONE query for a whole workspace's tabs: enabled pane-targeted crons joined
 * through their pane to its tab. The sidebar renders dozens of rows on every
 * 5s poll, so a per-row lookup here would be the most-executed query in the
 * app; this is the same pre-read shape `unreadIdsByWorkspace` already uses.
 *
 * new-tab crons are deliberately absent: they belong to a WORKSPACE and have
 * no tab until they fire, so there is no row to mark.
 */
export function cronsByTab(
  db: Database.Database,
  workspaceId?: string,
): Map<string, TabCronSummary> {
  const rows = (
    workspaceId === undefined
      ? db
          .prepare(
            `SELECT p.tab_id AS tab_id, c.name AS name, c.next_due_at AS next_due_at
             FROM crons c JOIN panes p ON p.id = c.target_pane
            WHERE c.enabled = 1 AND c.target_kind = 'pane'`,
          )
          .all()
      : db
          .prepare(
            `SELECT p.tab_id AS tab_id, c.name AS name, c.next_due_at AS next_due_at
               FROM crons c
               JOIN panes p ON p.id = c.target_pane
               JOIN tabs t ON t.id = p.tab_id
              WHERE c.enabled = 1 AND c.target_kind = 'pane' AND t.workspace_id = ?`,
          )
          .all(workspaceId)
  ) as CronTabRow[];
  return foldCronRows(rows);
}

/** Single-tab variant, for the emit paths that decorate one row at a time. */
function cronsForTab(db: Database.Database, tabId: string): TabCronSummary | undefined {
  let rows: CronTabRow[];
  try {
    rows = db
      .prepare(
        `SELECT p.tab_id AS tab_id, c.name AS name, c.next_due_at AS next_due_at
           FROM crons c JOIN panes p ON p.id = c.target_pane
          WHERE c.enabled = 1 AND c.target_kind = 'pane' AND p.tab_id = ?`,
      )
      .all(tabId) as CronTabRow[];
  } catch {
    // A DB that predates the crons table (a test fixture built at an older
    // migration) must not break tab decoration — the ⏱ is an accessory.
    return undefined;
  }
  return foldCronRows(rows).get(tabId);
}

function foldCronRows(rows: CronTabRow[]): Map<string, TabCronSummary> {
  const out = new Map<string, TabCronSummary>();
  for (const r of rows) {
    const cur = out.get(r.tab_id);
    if (!cur) {
      out.set(r.tab_id, { count: 1, next: { name: r.name, next_due_at: r.next_due_at } });
    } else {
      cur.count += 1;
      if (r.next_due_at < cur.next.next_due_at)
        cur.next = { name: r.name, next_due_at: r.next_due_at };
    }
  }
  return out;
}

/**
 * The workspace-level equivalent: the highest-precedence status across every
 * pane in every tab, computed ALWAYS — collapsed or not. A collapsed workspace
 * has nothing mounted to observe its tabs, which is exactly why it needs the
 * server to answer "is something running in here?".
 */
export function decorateWorkspace(
  cache: PtydCache,
  db: Database.Database,
  workspace: Workspace,
): Workspace {
  const panes = new PaneStore(db);
  const tabs = new TabStore(db);
  const manualUnreadIds = tabs.unreadIdsByWorkspace(workspace.id);
  let attention = false;
  let unread = false;
  let agents = 0;
  const statuses: PaneStatus[] = [];
  for (const t of tabs.listByWorkspace(workspace.id)) {
    if (manualUnreadIds.has(t.id)) {
      unread = true;
      statuses.push('done');
    }
    for (const p of panes.listByTab(t.id)) {
      if (cache.getAttention(p.id)) attention = true;
      if (p.unread) unread = true;
      statuses.push(cache.getStatus(p.id, p.unread === true));
      agents += cache.getSubagentCount(p.id);
    }
  }
  // No `busy` alias here: WorkspaceSchema never carried one (the deprecated
  // alias exists on panes and tabs only), and inventing it would ship a field
  // no client reads.
  return { ...workspace, attention, unread, status: rollupStatus(statuses), agents };
}
