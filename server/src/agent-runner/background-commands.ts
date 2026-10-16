/**
 * BACKGROUND COMMANDS — the work that outlives the turn that started it, now
 * that subagents do not.
 *
 * ── WHY THIS EXISTS AT ALL ──────────────────────────────────────────────────
 * With `Agent`/`Task` removed from the model's context (see claude.ts), the
 * subagent roster tracks a thing that can no longer happen. What remains on the
 * SAME SDK channel is the other half of it, and it is the half that has been
 * doing the damage: `task_type: 'local_bash'` — a Bash call the model
 * backgrounded, which keeps running after the turn ends.
 *
 * Measured on a recorded 0.3.220 session (the fixture this is tested against):
 * 43 `local_bash` entries against 36 `local_agent`. Removing subagents takes
 * the second to zero and leaves the first exactly as it was.
 *
 * That is not a bookkeeping detail. A child whose final turn was started by a
 * BACKGROUND COMMAND FINISHING is the root cause behind four sub-chat results
 * arriving 5h42m–7h51m late: the round had already been closed and summarised
 * by the time that turn arrived. Knowing what is still running is what lets a
 * round wait for it.
 *
 * ── WHY IT IS NOT THE ROSTER ────────────────────────────────────────────────
 * The roster's membership rule is "an entry exists IFF we saw its top-level
 * `Task`/`Agent` tool_use", and it has to be: a nested agent's traffic arrives
 * on the top-level stream under a nested id, so adopting unknown ids inflated a
 * live pane to 19 rostered against 7 real. A backgrounded Bash call has no such
 * launch to see — which is precisely why the roster ignores it today.
 *
 * None of that machinery is needed here, and reusing it would import all of it:
 *
 *   · MEMBERSHIP IS THE LEVEL SET, and nothing else. `background_tasks_changed`
 *     carries the full set of live background tasks; this class holds exactly
 *     what that message last said, filtered to commands. No edges to bind, no
 *     adoption question, no four end-paths to keep in agreement — the signal
 *     that answers "what is still running" is itself a complete answer.
 *   · THEREFORE NO IMMORTAL ENTRIES. The roster's worst failure is an entry no
 *     end-path can reach, which pins a pane to `working` until the runner dies.
 *     A set that is replaced wholesale on every level message cannot have one.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ────────────────────────────────────────
 * No timer, no decay, for the reason written on the roster: an out-of-turn
 * background task was measured emitting nothing for 44 seconds while
 * demonstrably alive, so any window short enough to be useful is short enough
 * to evict live work. Absence from the LEVEL is the only death.
 */

/** The SDK's own name for a backgrounded shell command. */
export const LOCAL_BASH = 'local_bash';

/** One live background command, as the level signal describes it. */
export interface BackgroundCommand {
  taskId: string;
  /**
   * The tool_use that launched it, when the SDK has told us — `task_started`
   * carries the pair, and it is the only thing that can tie a running command
   * back to a line in the transcript.
   *
   * Optional because the level signal does NOT carry it, and the level signal
   * is the one that decides membership. A command known only by task id is
   * still a command that is running; refusing to count it until an edge turns
   * up would reintroduce exactly the "we missed the edge, so the work is
   * invisible" failure this replaces.
   */
  toolUseId?: string;
}

export class BackgroundCommands {
  /** taskId → entry. Replaced wholesale by every level message. */
  private live = new Map<string, BackgroundCommand>();

  /**
   * The authoritative LEVEL signal: the complete set of live background tasks.
   *
   * `tasks` is every type the SDK reports; commands are selected here rather
   * than by the caller so that one place decides what this class is about. An
   * entry whose type the SDK omits is KEPT — the field is optional in the
   * declared shape, and dropping an unknown-typed live task would under-report
   * running work, which is the failure direction that loses results.
   */
  reconcile(tasks: readonly { task_id: string; task_type?: string }[]): void {
    const next = new Map<string, BackgroundCommand>();
    for (const t of tasks) {
      if (t.task_type !== undefined && t.task_type !== LOCAL_BASH) continue;
      const prev = this.live.get(t.task_id);
      next.set(t.task_id, prev ?? { taskId: t.task_id });
    }
    this.live = next;
  }

  /**
   * `task_started` / `task_progress`: the task id ↔ launching tool_use pair.
   *
   * Does NOT create an entry. Membership belongs to the level signal alone, and
   * a start edge for a task the level has not reported (or has already dropped)
   * would otherwise resurrect finished work — the immortal-entry bug, arriving
   * through a different door.
   */
  bind(taskId: string, toolUseId: string): void {
    const e = this.live.get(taskId);
    if (e) e.toolUseId = toolUseId;
  }

  /**
   * A terminal edge — `task_notification`, or a `task_updated` whose status is
   * terminal.
   *
   * Edges are an OPTIMISATION, not the truth: the level message that follows
   * would drop it anyway. They exist so a pane stops reading busy at the moment
   * the command actually ended rather than at the next level tick.
   */
  done(taskId: string): void {
    this.live.delete(taskId);
  }

  /** How many commands are running. The whole public question. */
  get size(): number {
    return this.live.size;
  }

  /** Is anything still running? Reads at the call site like the question it answers. */
  get busy(): boolean {
    return this.live.size > 0;
  }

  /** The live set, for a caller that needs to name them (logs, diagnostics). */
  list(): BackgroundCommand[] {
    return [...this.live.values()];
  }

  /** Forget everything. The runner calls this when its SESSION is replaced —
   *  a new session's level signal describes a different process's work. */
  clear(): void {
    this.live.clear();
  }
}
