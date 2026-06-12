import type { AppUrl } from '@muxpad/shared';
import { PaneRuntime, type PaneRuntimeSpec } from './PaneRuntime.js';

/**
 * A "raw" decoration change for a pane — the manager observed a delta in
 * one of {title, foreground_cmd, attention, appUrls} since the previous
 * tick. Used by ptyd to push lifecycle events on the control channel
 * without needing a PaneStore for full row hydration.
 */
export type PaneChange =
  | { kind: 'title'; title: string | null }
  | { kind: 'fg'; cmd: string | null }
  | { kind: 'attention'; attention: boolean }
  | { kind: 'appUrls'; urls: AppUrl[] };

/**
 * Configuration for PaneManager. All callbacks are optional — ptyd wires
 * `onCwdChange` / `onPaneChange` / `onPaneExit` to fan changes out on its
 * control channel. The main server doesn't construct a PaneManager directly
 * anymore (it talks to ptyd via PtydClient); the manager lives entirely
 * inside ptyd as of the daemon split.
 */
export interface PaneManagerOptions {
  onCwdChange?: (paneId: string, cwd: string) => void;
  /** Polling interval for cwd in ms. Defaults to 30s. */
  cwdPollInterval?: number;
  /**
   * Polling interval for foreground command in ms. Defaults to 10s.
   * We poll faster than cwd because the displayed pane name comes from
   * this fallback when no OSC title is set, and a 30s lag feels stale.
   */
  cmdPollInterval?: number;
  /**
   * Raw change callback: fires once per (title|fg|attention) delta the
   * manager observes. ptyd uses this to fan out decoration events on the
   * control channel — the manager emits only the changed field, not a
   * full pane row, so it doesn't need a PaneStore.
   */
  onPaneChange?: (paneId: string, change: PaneChange) => void;
  /**
   * Lifecycle callback fired when a runtime exits (naturally or via
   * `kill`). Mirrors the `onPaneChange` shape — independent of the cwd
   * persistence hook, so ptyd can wire it on its own.
   */
  onPaneExit?: (paneId: string, code: number, cause: 'natural' | 'killed') => void;
}

const DEFAULT_CWD_POLL_INTERVAL = 30_000;
const DEFAULT_CMD_POLL_INTERVAL = 10_000;

export class PaneManager {
  private runtimes = new Map<string, PaneRuntime>();
  /** Last cwd we reported per pane — used to suppress redundant writes. */
  private lastCwd = new Map<string, string>();
  /** Cached foreground command per pane, refreshed by cmdPollTimer. */
  private foregroundCmd = new Map<string, string>();
  // Diff-emit state: the last value broadcast over `events` for each pane.
  // Updated only inside emitDecorations(), which only emits when the
  // current snapshot differs from the prior one — that's how the bus stays
  // quiet for panes whose title/fg/attention haven't changed.
  private lastTitle = new Map<string, string | null>();
  private lastFg = new Map<string, string | null>();
  private lastAttention = new Map<string, boolean>();
  // Diff state for app-urls: the JSON of the last list broadcast per pane.
  // JSON compare keeps the diff cheap and order/label-sensitive.
  private lastAppUrls = new Map<string, string>();
  private cwdPollTimer: NodeJS.Timeout | null = null;
  private cmdPollTimer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: PaneManagerOptions = {}) {
    if (opts.onCwdChange) this.startCwdPolling();
    this.startCmdPolling();
  }

  private startCwdPolling(): void {
    if (this.cwdPollTimer) return;
    const interval = this.opts.cwdPollInterval ?? DEFAULT_CWD_POLL_INTERVAL;
    this.cwdPollTimer = setInterval(() => this.pollCwds(), interval);
    this.cwdPollTimer.unref?.();
  }

  private startCmdPolling(): void {
    if (this.cmdPollTimer) return;
    const interval = this.opts.cmdPollInterval ?? DEFAULT_CMD_POLL_INTERVAL;
    this.cmdPollTimer = setInterval(() => {
      void this.pollCmds();
    }, interval);
    this.cmdPollTimer.unref?.();
  }

  private pollCwds(): void {
    const onChange = this.opts.onCwdChange;
    if (!onChange) return;
    for (const [id, runtime] of this.runtimes) {
      const cwd = runtime.getCurrentCwd();
      if (!cwd) continue;
      if (this.lastCwd.get(id) === cwd) continue;
      this.lastCwd.set(id, cwd);
      try {
        onChange(id, cwd);
      } catch {
        // ignore — we'll retry on the next tick
      }
    }
  }

  private async pollCmds(): Promise<void> {
    // Run all panes' fg-command lookups in parallel so a slow ps on one
    // doesn't hold up the others. Each lookup spawns ps twice; doing
    // them sequentially with N panes would block the loop linearly.
    const entries = [...this.runtimes.entries()];
    const results = await Promise.allSettled(
      entries.map(async ([id, runtime]) => {
        // Re-probe app-urls on the same cadence so a server that has since
        // died drops out of the dropdown (and a late-binding one appears).
        // It self-emits 'appurls-changed' only on a real delta.
        const cmd = await runtime.getForegroundCommand();
        await runtime.refreshAppUrls();
        return { id, cmd };
      }),
    );
    for (const r of results) {
      if (r.status !== 'fulfilled') continue;
      const { id, cmd } = r.value;
      // Don't clear stale values on null — we'd rather show the previous
      // command than nothing while ps blips.
      if (cmd) this.foregroundCmd.set(id, cmd);
    }
    // The fg cache was just refreshed; this is also the cheapest moment to
    // sweep title + attention diffs, because the cmdPoll cadence (default
    // 10s) is the fastest periodic loop we have. Emit any deltas now.
    this.emitDecorations();
  }

  /**
   * Walk every live runtime, compute the current (title, fg, attention)
   * triple, and fire `onPaneChange` (raw, per-field) for any pane whose
   * value changed. ptyd is the sole consumer; it broadcasts each field
   * change as a separate event on its /control channel.
   *
   * Cheap and idempotent — safe to call from both the periodic tick and
   * the eager BEL hook. The diff maps are the only thing that prevents
   * re-emission of unchanged values; do not bypass them.
   */
  private emitDecorations(paneId?: string): void {
    const { onPaneChange } = this.opts;
    // No listener → no diff work. Skipping here also avoids spurious
    // updates to the diff maps that would mask real deltas once a
    // listener attaches later.
    if (!onPaneChange) return;

    const ids = paneId ? [paneId] : [...this.runtimes.keys()];
    for (const id of ids) {
      const runtime = this.runtimes.get(id);
      if (!runtime) continue;
      const title = runtime.getCurrentTitle();
      const fg = this.foregroundCmd.get(id) ?? null;
      const attention = runtime.getNeedsAttention();
      const appUrls = runtime.getAppUrls();
      const appUrlsJson = JSON.stringify(appUrls);

      // Compute per-field deltas explicitly. `has(id)` differentiates
      // "first sample" from "changed value" so the first observation
      // counts as a change and fires the callback.
      const titleChanged = !this.lastTitle.has(id) || this.lastTitle.get(id) !== title;
      const fgChanged = !this.lastFg.has(id) || this.lastFg.get(id) !== fg;
      const attentionChanged =
        !this.lastAttention.has(id) || this.lastAttention.get(id) !== attention;
      const appUrlsChanged = !this.lastAppUrls.has(id) || this.lastAppUrls.get(id) !== appUrlsJson;
      if (!titleChanged && !fgChanged && !attentionChanged && !appUrlsChanged) continue;

      this.lastTitle.set(id, title);
      this.lastFg.set(id, fg);
      this.lastAttention.set(id, attention);
      this.lastAppUrls.set(id, appUrlsJson);

      try {
        if (titleChanged) onPaneChange(id, { kind: 'title', title });
        if (fgChanged) onPaneChange(id, { kind: 'fg', cmd: fg });
        if (attentionChanged) onPaneChange(id, { kind: 'attention', attention });
        if (appUrlsChanged) onPaneChange(id, { kind: 'appUrls', urls: appUrls });
      } catch {
        // Swallow — we don't want one bad subscriber to wedge the loop.
      }
    }
  }

  /**
   * Returns the most recently observed foreground command for a pane, or
   * null if we haven't successfully sampled one yet. Used by the API
   * layer to decorate workspace lists without spawning ps per request.
   */
  getForegroundCommand(paneId: string): string | null {
    return this.foregroundCmd.get(paneId) ?? null;
  }

  /**
   * Force a one-shot poll right now. Intended for graceful shutdown so the
   * latest cwd survives even if the next periodic tick wouldn't have fired
   * before the daemon exits.
   */
  flushCwds(): void {
    this.pollCwds();
  }

  /**
   * Snapshot every live runtime's current cwd. Unlike `flushCwds()` (which
   * only fires the `onCwdChange` hook for *changed* cwds), this returns the
   * full current set — used by the ptyd control RPC so callers can harvest
   * all cwds in one round-trip, regardless of whether they've changed since
   * the last poll.
   */
  snapshotCwds(): Array<{ id: string; cwd: string }> {
    const out: Array<{ id: string; cwd: string }> = [];
    for (const [id, runtime] of this.runtimes) {
      const cwd = runtime.getCurrentCwd();
      if (cwd) out.push({ id, cwd });
    }
    return out;
  }

  getOrCreate(spec: PaneRuntimeSpec): PaneRuntime {
    const existing = this.runtimes.get(spec.id);
    if (existing) return existing;
    const r = new PaneRuntime(spec);
    // Eager BEL emit: a BEL byte flips needsAttention sub-second; we want
    // the attention dot in the UI without waiting for the next 10s
    // cmd-poll tick. The runtime fires `attention-changed` only on
    // transitions, so this won't fan out per output chunk.
    r.on('attention-changed', () => {
      this.emitDecorations(spec.id);
    });
    // App-url list changed (debounced confirm pass found a delta) — push it
    // out eagerly rather than waiting for the next cmd-poll sweep.
    r.on('appurls-changed', () => {
      this.emitDecorations(spec.id);
    });
    r.on('exit', (code) => {
      // Keep it referenced so post-exit consumers can still query snapshot/exitCode,
      // but unhook from the live map so a new spec for the same id can take over.
      this.runtimes.delete(spec.id);
      this.lastCwd.delete(spec.id);
      this.foregroundCmd.delete(spec.id);
      this.lastTitle.delete(spec.id);
      this.lastFg.delete(spec.id);
      this.lastAttention.delete(spec.id);
      this.lastAppUrls.delete(spec.id);
      // Fire the manager-level exit hook AFTER local cleanup so callbacks
      // observing the manager's state see it consistent with the exit.
      const onPaneExit = this.opts.onPaneExit;
      if (onPaneExit) {
        try {
          onPaneExit(spec.id, code, r.getExitCause());
        } catch {
          // ignore
        }
      }
    });
    r.start();
    this.runtimes.set(spec.id, r);
    return r;
  }

  has(id: string): boolean {
    return this.runtimes.has(id);
  }

  get(id: string): PaneRuntime | undefined {
    return this.runtimes.get(id);
  }

  async kill(id: string, signal: NodeJS.Signals = 'SIGHUP'): Promise<void> {
    const r = this.runtimes.get(id);
    if (!r) return;
    if (r.isExited()) {
      this.runtimes.delete(id);
      return;
    }
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      r.once('exit', finish);
      r.kill(signal);
      setTimeout(() => {
        if (this.runtimes.has(id)) {
          r.kill('SIGKILL');
          this.runtimes.delete(id);
          finish();
        }
      }, 2000);
    });
  }

  async killAll(): Promise<void> {
    if (this.cwdPollTimer) {
      clearInterval(this.cwdPollTimer);
      this.cwdPollTimer = null;
    }
    if (this.cmdPollTimer) {
      clearInterval(this.cmdPollTimer);
      this.cmdPollTimer = null;
    }
    await Promise.all([...this.runtimes.keys()].map((id) => this.kill(id)));
  }
}
