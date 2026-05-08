import { PaneRuntime, type PaneRuntimeSpec } from './PaneRuntime.js';

/**
 * Optional persistence hook called periodically with each running pane's
 * latest detected cwd. The manager itself never imports the store directly
 * so it stays unit-testable without sqlite.
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
}

const DEFAULT_CWD_POLL_INTERVAL = 30_000;
const DEFAULT_CMD_POLL_INTERVAL = 10_000;

export class PaneManager {
  private runtimes = new Map<string, PaneRuntime>();
  /** Last cwd we reported per pane — used to suppress redundant writes. */
  private lastCwd = new Map<string, string>();
  /** Cached foreground command per pane, refreshed by cmdPollTimer. */
  private foregroundCmd = new Map<string, string>();
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
        const cmd = await runtime.getForegroundCommand();
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

  getOrCreate(spec: PaneRuntimeSpec): PaneRuntime {
    const existing = this.runtimes.get(spec.id);
    if (existing) return existing;
    const r = new PaneRuntime(spec);
    r.on('exit', () => {
      // Keep it referenced so post-exit consumers can still query snapshot/exitCode,
      // but unhook from the live map so a new spec for the same id can take over.
      this.runtimes.delete(spec.id);
      this.lastCwd.delete(spec.id);
      this.foregroundCmd.delete(spec.id);
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
