import type { SubagentProgress } from '@muxpad/shared';

/**
 * The runner's DURABLE subagent roster.
 *
 * Extracted from the Claude backend so the lifecycle is testable on its own:
 * constructing that backend spawns a real Agent SDK session, so nothing inside
 * it can be exercised in a unit test — and this is the piece whose invariants
 * are load-bearing.
 *
 * ── Why there is no timer ────────────────────────────────────────────────
 * An entry is created at its launching `tool_use` and removed ONLY on an
 * explicit end. It deliberately does not clear when the parent turn finishes:
 * a `run_in_background` Task routinely outlives the turn that started it, and
 * wiping the roster there is exactly what made background subagents vanish
 * from the sidebar and the in-pane list the instant the turn ended.
 *
 * Nor is membership timer-based. P1 experiment (2026-08, standalone SDK
 * probe): out-of-turn frames DO keep arriving, but with unbounded silent gaps
 * — a background subagent parked in one `Bash` call emitted nothing for 44
 * seconds while it was demonstrably still running (it wrote its marker file
 * afterwards). Any decay window short enough to be useful is short enough to
 * evict a live agent, so liveness must never depend on the SDK pumping.
 *
 * ── The invariant that makes that safe ───────────────────────────────────
 * EVERY path that ends a subagent must say so. There are exactly three:
 *   1. its non-launch-ack `tool_result`      (a foreground Task completing)
 *   2. its `<task-notification>`             (a background Task completing)
 *   3. {@link retireAll}                     (a Stop or a failed turn, which
 *      take their background tasks down with them and announce it NOWHERE —
 *      no tool_result, no finish notice)
 * Miss one and the entry is immortal: the pane reads `working` until the
 * runner process dies, and the keepalive re-announces the ghost every tick.
 */
export interface RosterEntry extends SubagentProgress {
  lastSentAt: number;
  dirty: boolean;
}

/** Minimum gap between two progress frames for the same subagent. */
const PROGRESS_THROTTLE_MS = 500;

export class SubagentRoster {
  private readonly entries = new Map<string, RosterEntry>();

  /**
   * @param emit Sends one `subagent` frame to the server.
   * @param log  Optional human line for the pane's terminal face.
   * @param now  Injectable clock (tests).
   */
  constructor(
    private readonly emit: (progress: SubagentProgress) => void,
    private readonly log: (line: string) => void = () => {},
    private readonly now: () => number = Date.now,
  ) {}

  get size(): number {
    return this.entries.size;
  }

  /** Live entries, for the reconnect re-announce. */
  values(): RosterEntry[] {
    return [...this.entries.values()];
  }

  has(toolUseId: string): boolean {
    return this.entries.has(toolUseId);
  }

  private send(p: RosterEntry): void {
    p.lastSentAt = this.now();
    p.dirty = false;
    const { lastSentAt, dirty, ...progress } = p;
    this.emit(progress);
  }

  /**
   * Register a subagent at its LAUNCH (the parent's Task/Agent `tool_use`), so
   * the roster knows about it before its first child message — and knows its
   * description, which the child messages never carry. Idempotent.
   */
  launch(toolUseId: string, label: string): void {
    if (this.entries.has(toolUseId)) return;
    const p: RosterEntry = {
      toolUseId,
      steps: 0,
      label,
      seenAt: this.now(),
      lastSentAt: 0,
      dirty: true,
    };
    this.entries.set(toolUseId, p);
    this.send(p);
  }

  /** A message from this subagent. Throttled: an active one is chatty. */
  activity(toolUseId: string, lastTool?: string): void {
    let p = this.entries.get(toolUseId);
    if (!p) {
      // Child messages can outrun (or outlive) the launch we saw — a resumed
      // session whose launch predates this process, for instance. Adopt the id.
      p = { toolUseId, steps: 0, lastSentAt: 0, dirty: false };
      this.entries.set(toolUseId, p);
    }
    p.steps++;
    if (lastTool) p.lastTool = lastTool;
    p.seenAt = this.now();
    p.dirty = true;
    if (this.now() - p.lastSentAt >= PROGRESS_THROTTLE_MS) this.send(p);
  }

  /**
   * This subagent ended. Emits a TERMINAL frame so the server drops it from its
   * own copy in the same beat. Unknown ids are a no-op.
   */
  done(toolUseId: string): void {
    const p = this.entries.get(toolUseId);
    if (!p) return;
    this.entries.delete(toolUseId);
    const { lastSentAt, dirty, ...progress } = p;
    this.emit({ ...progress, done: true });
  }

  /**
   * Retire the WHOLE roster — the third end-path. A Stop or a failed turn kills
   * its background tasks (live-verified), and those deaths produce no
   * tool_result and no finish notice, so nothing else would ever remove them.
   */
  retireAll(reason: string): void {
    if (this.entries.size === 0) return;
    this.log(`⏹ ${this.entries.size} background subagent(s) ended with the turn (${reason})`);
    for (const id of [...this.entries.keys()]) this.done(id);
  }

  /**
   * Push any throttled-but-unsent progress. Explicitly does NOT drop entries —
   * this runs at every turn `result`, and a background subagent legitimately
   * outlives the turn that launched it.
   */
  flush(): void {
    for (const p of this.entries.values()) if (p.dirty) this.send(p);
  }

  /**
   * Re-announce every live entry. Used by the fixed keepalive tick (so the
   * server's copy and the per-row busy dot stay fresh through the long silent
   * tool calls P1 measured) and by `onConnected` (so a reconnecting runner
   * rebuilds the server's roster, which starts empty).
   *
   * Note this does NOT touch `seenAt`: the keepalive re-sends the last REAL
   * activity time, so the per-row busy/quiet dot stays honest rather than
   * being pinned alive by our own heartbeat.
   */
  announceAll(): void {
    for (const p of this.entries.values()) this.send(p);
  }
}
