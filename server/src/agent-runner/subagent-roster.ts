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
 * The LEVEL signal is the source of truth, and the roster's job is to make sure
 * every background entry is REACHABLE by it. That reachability is established at
 * the launch ack ({@link bindBackgroundTask}) — a tool_result in the
 * conversation with no optional fields — rather than from `task_started`, whose
 * `tool_use_id` the SDK declares optional and whose absence used to leave an
 * entry with no task id and therefore no background end-path at all.
 *
 * EVERY path that ends a subagent must say so. There are exactly four:
 *   1. its non-launch-ack `tool_result`      (a foreground Task completing)
 *   2. its finish notice                     (a background Task completing:
 *      the SDK's `system/task_notification`, or the `<task-notification>`
 *      the harness injects into the conversation when no turn is open)
 *   3. {@link reconcileBackground}           (the SDK's authoritative LEVEL
 *      signal — `system/background_tasks_changed` carries the full set of
 *      live background tasks, so an end whose edge we missed is still caught)
 *   4. {@link retireForeground}              (a Stop or a failed turn, whose
 *      FOREGROUND subagents die announcing nothing — no tool_result, no finish
 *      notice. Its background ones are NOT covered here: the SDK announces the
 *      kills it makes, and the agents earlier turns launched keep running)
 * Miss one and the entry is immortal: the pane reads `working` until the
 * runner process dies, and the keepalive re-announces the ghost every tick.
 * Over-reach and the opposite happens — the count reads below the truth and a
 * live agent loses its row.
 *
 * ── Membership: TOP-LEVEL launches only ──────────────────────────────────
 * `activity()` used to ADOPT any `parent_tool_use_id` it had never seen
 * launched. That is the over-counting bug (2026-08, live pane: 19 rostered,
 * 7 real). A subagent can itself spawn subagents, and a NESTED agent's
 * traffic arrives on the SAME top-level SDK stream carrying the nested
 * tool_use id (SDK probe, 0.3.220 — see the roster tests). But its LAUNCH
 * never appears at top level (it rides its parent's `parent_tool_use_id`),
 * and neither does its END: the nested `tool_result` and finish notice are
 * delivered to the PARENT agent's message stream. An adopted grandchild is
 * therefore structurally immortal — no end-path can ever reach it, and every
 * research fan-out permanently inflated the pane's `agents:` count.
 *
 * So: an entry exists IFF we saw its top-level `Task`/`Agent` `tool_use` — or
 * IFF it is the resurrection of one (see {@link reconcileBackground}, which is
 * how a RESUMED agent gets its row back now that nothing adopts ids).
 * Everything else is ignored, and the pane counts what its chat can render.
 */
export interface RosterEntry extends SubagentProgress {
  lastSentAt: number;
  dirty: boolean;
  /** The SDK task id behind this tool_use, once known — from the LAUNCH ACK
   *  ({@link bindBackgroundTask}) or from `system/task_started`
   *  ({@link bindTask}). Only this lets the LEVEL signal — which speaks task
   *  ids, not tool_use ids — reconcile against the roster. */
  taskId?: string;
  /** This entry is KNOWN to be a background task, so the level signal's
   *  membership is authoritative for it and a Stop does not take it. Earned
   *  from the launching tool_use's `run_in_background` (the SDK's own typed
   *  statement), from its launch ack, or from a live level sighting. A
   *  FOREGROUND Task never earns it, so it is never swept by its absence. */
  background?: boolean;
  /** Sweep suppression for a PAUSED task (see {@link pauseTask}): it may leave
   *  the live set while still being a live agent. Kept separate from
   *  {@link background} so a pause suspends the sweep without ALSO erasing the
   *  knowledge that this is a background task — a resumed agent whose next
   *  level sighting never comes would otherwise lose the sweep for good. */
  sweepSuspended?: boolean;
  /** Its launch ack arrived — proof the agent actually STARTED. Distinct from
   *  {@link background}, which now comes from the launching tool_use's
   *  `run_in_background` and is therefore true even for a launch that was
   *  retracted before it ever ran. {@link retireUnstarted} needs the former. */
  launchAcked?: boolean;
}

/** Minimum gap between two progress frames for the same subagent. */
const PROGRESS_THROTTLE_MS = 500;

/**
 * Hard bound on roster size — a backstop, NOT a policy. Real fan-outs top out
 * around a dozen concurrent top-level background agents; anything past this is
 * a leak, and a leak must never again render an absurd number in the status
 * rail. Exceeding it retires the least-recently-active entry and logs, so the
 * count stays bounded and the cause stays visible.
 */
export const MAX_ROSTER_ENTRIES = 32;

/** Rate limit for the cap warning. */
const OVERFLOW_WARN_INTERVAL_MS = 60_000;

/** How many finished task ids to remember for resurrection (see knownTasks). */
const MAX_REMEMBERED_TASKS = 256;

/** The roster's own bookkeeping fields, stripped for the wire. */
function wireProgress(p: RosterEntry): SubagentProgress {
  const { lastSentAt, dirty, taskId, background, sweepSuspended, launchAcked, ...progress } = p;
  return progress;
}

export class SubagentRoster {
  private readonly entries = new Map<string, RosterEntry>();
  /** The most recent live background-task LEVEL payload (task ids). Kept so a
   *  `task_started` that lands AFTER its level event can still mark its entry
   *  as background — the SDK documents that ordering as unspecified. */
  private lastLevel = new Set<string>();
  /**
   * taskId → the launch it came from, REMEMBERED PAST RETIREMENT. A finished
   * background agent can be resumed (the harness's own notice says so: "the
   * same task-id may notify more than once"), and a resume re-enters the live
   * set under the SAME task id but a NEW tool_use id — the resuming
   * `SendMessage` call's, not the original `Task` call's (probe-verified).
   * Its child messages, though, still carry the ORIGINAL id. So the only way
   * to show a resumed agent on its own row is to resurrect that row from here.
   */
  private readonly knownTasks = new Map<
    string,
    { toolUseId: string; label?: string; steps: number }
  >();
  /** Clock of the last cap warning (0 = never). */
  private lastOverflowWarnAt = Number.NEGATIVE_INFINITY;

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
    this.emit(wireProgress(p));
  }

  /**
   * Register a subagent at its LAUNCH (the parent's TOP-LEVEL Task/Agent
   * `tool_use`), so the roster knows about it before its first child message —
   * and knows its description, which the child messages never carry.
   *
   * This is the ONLY way an entry is created: see the membership note above.
   * Idempotent.
   *
   * @param background The launching tool_use's `run_in_background` — the SDK's
   *   own typed statement of which kind of agent this is. It decides which
   *   end-paths apply, so it must come from that field and never from prose:
   *   a FOREGROUND agent's completion text carries an `agentId:` trailer and is
   *   the subagent's own report, which can read exactly like a launch ack.
   */
  launch(toolUseId: string, label: string, background = false): void {
    if (this.entries.has(toolUseId)) return;
    this.enforceCap();
    const p: RosterEntry = {
      toolUseId,
      steps: 0,
      label,
      seenAt: this.now(),
      lastSentAt: 0,
      dirty: true,
      ...(background ? { background: true } : {}),
    };
    this.entries.set(toolUseId, p);
    this.send(p);
  }

  /**
   * A message from this subagent. Throttled: an active one is chatty.
   *
   * An id we never saw LAUNCHED is ignored — it belongs to a nested (grandchild)
   * agent whose whole lifecycle is invisible at this level, so rostering it
   * would be rostering something nothing can ever retire.
   */
  activity(toolUseId: string, lastTool?: string): void {
    const p = this.entries.get(toolUseId);
    if (!p) return;
    p.steps++;
    if (lastTool) p.lastTool = lastTool;
    p.seenAt = this.now();
    p.dirty = true;
    if (this.now() - p.lastSentAt >= PROGRESS_THROTTLE_MS) this.send(p);
  }

  /**
   * Bind the SDK task id (`system/task_started`) to the launching tool_use, so
   * {@link reconcileBackground} — which speaks task ids — can find this entry.
   * Ids we never launched (nested agents, background Bash) are ignored.
   */
  bindTask(toolUseId: string, taskId: string): void {
    const p = this.entries.get(toolUseId);
    if (!p) return;
    // A REBIND (this tool_use already named a DIFFERENT task) must re-earn the
    // background flag from scratch: carrying it over would let a level payload
    // that predates the new binding sweep a live entry.
    //
    // A FIRST bind must not: `task_started` can land after the launch ack, and
    // clearing the flag there would throw away the one piece of positive
    // evidence we have — the ack saying outright that this is a background
    // agent — leaving the entry unsweepable unless a level payload happens to
    // name it in the same instant.
    if (p.taskId !== undefined && p.taskId !== taskId) {
      p.background = false;
      p.sweepSuspended = false;
    }
    p.taskId = taskId;
    // The level payload may have arrived FIRST (the SDK documents the ordering
    // as unspecified); if it named this task, it is already known-background.
    if (this.lastLevel.has(taskId)) p.background = true;
    this.remember(taskId, p);
  }

  /**
   * Bind from the BACKGROUND LAUNCH ACK — the `tool_result` the SDK returns for
   * a `run_in_background` Task/Agent call, which carries `agentId: <task_id>`
   * (probe-verified, 0.3.220).
   *
   * This exists because {@link bindTask}'s source, `system/task_started`, has an
   * OPTIONAL `tool_use_id`: when the SDK omits it there is no binding at all,
   * and an entry with no task id is invisible to BOTH background end-paths —
   * {@link reconcileBackground} skips it and {@link doneByTaskId} cannot match
   * it. Its only remaining end would be `task_notification`'s equally optional
   * `tool_use_id`; miss that too and the entry is immortal, exactly the shape
   * the live pane showed (hundreds of steps, never retired, `retireUnstarted`
   * powerless because it plainly RAN).
   *
   * The ack has no optional field and no ordering hazard: it is a tool_result in
   * the conversation, always delivered, always after the launch. And unlike a
   * level sighting it is POSITIVE evidence of backgroundness, so the entry
   * becomes sweep-eligible immediately rather than waiting to be caught live.
   *
   * `taskId` is null when the ack text says "launched" but carries no `agentId`.
   * The backgroundness still counts: see {@link reconcileBackground}, where an
   * EMPTY live set retires it regardless of whether it was ever bound.
   */
  bindBackgroundTask(toolUseId: string, taskId: string | null): void {
    const p = this.entries.get(toolUseId);
    if (!p) return;
    p.background = true;
    p.launchAcked = true;
    if (!taskId) return;
    if (p.taskId !== taskId) p.sweepSuspended = false;
    p.taskId = taskId;
    this.remember(taskId, p);
  }

  /**
   * Retire by TASK id. `tool_use_id` is optional on the SDK's task messages
   * (`task_notification`, and absent entirely from `task_updated`) while
   * `task_id` is not — so without this, a finish edge that omits it would leave
   * the entry to the level signal alone, and an entry whose `task_started` also
   * omitted it would have no edge end-path at all.
   */
  doneByTaskId(taskId: string): void {
    for (const p of this.entries.values()) {
      if (p.taskId === taskId) {
        this.done(p.toolUseId);
        return;
      }
    }
  }

  /**
   * This task is PAUSED (`task_updated`, e.g. parked behind a rate limit). It
   * may drop out of the live background set while still being a live agent —
   * the level signal's documented membership changes don't mention pause either
   * way — so make it ineligible for the level sweep until it is seen live
   * again. Absence must never be the thing that kills a running subagent.
   */
  pauseTask(taskId: string): void {
    for (const p of this.entries.values()) if (p.taskId === taskId) p.sweepSuspended = true;
  }

  /** This task is RUNNING again (`task_updated`), so the level signal speaks for
   *  it once more. The next level payload naming it would do this anyway; this
   *  just doesn't wait for one. */
  resumeTask(taskId: string): void {
    for (const p of this.entries.values()) if (p.taskId === taskId) p.sweepSuspended = false;
  }

  /**
   * Retire launches that never actually RAN. A `Task` tool_use can be delivered
   * and then retracted (a refused leg superseded by the fallback), or simply
   * never execute — no `task_started`, no `tool_result`, no child traffic, and
   * never in the level set, so not one end-path can reach it. Called at the
   * turn `result`, where "it produced nothing at all" is finally decidable.
   *
   * This is NOT the turn-clearing regression: an agent that actually started has
   * a bound task id, an arrived launch ack, or steps — and is untouched.
   *
   * `launchAcked` rather than `background` on purpose. Backgroundness now comes
   * from the launching tool_use's `run_in_background`, so it is true of a
   * RETRACTED launch too — which is precisely what this method exists to sweep.
   * The ack is the proof the agent actually ran, and it matters on its own: an
   * ack whose text carried no `agentId` leaves an entry that is unbound and, for
   * up to 44 measured seconds, stepless.
   */
  retireUnstarted(): void {
    for (const p of [...this.entries.values()]) {
      if (!p.taskId && !p.launchAcked && p.steps === 0) this.done(p.toolUseId);
    }
  }

  /** Record (or refresh) the launch behind a task id, for resurrection. */
  private remember(taskId: string, p: RosterEntry): void {
    this.knownTasks.delete(taskId); // re-insert so the map stays LRU-ordered
    this.knownTasks.set(taskId, {
      toolUseId: p.toolUseId,
      steps: p.steps,
      ...(p.label ? { label: p.label } : {}),
    });
    while (this.knownTasks.size > MAX_REMEMBERED_TASKS) {
      const oldest = this.knownTasks.keys().next();
      if (oldest.done) break;
      this.knownTasks.delete(oldest.value);
    }
  }

  /**
   * The SDK's LEVEL signal: the complete set of live background task ids after
   * a membership change. REPLACE semantics, so it is the one source of truth
   * that a missed edge cannot wedge — an entry we have SEEN in this set and
   * that has now left it is finished, whatever else did or didn't arrive.
   *
   * Only entries KNOWN to be background are eligible — from their launch ack, or
   * from a live sighting here. A foreground Task never appears in this payload,
   * and sweeping it on absence would evict a live agent.
   *
   * It resurrects too. A task id that is live again but has no row is a RESUMED
   * agent — the level signal is the only place that shows up, since the resume
   * carries the `SendMessage` call's tool_use id rather than the launch's.
   */
  reconcileBackground(liveTaskIds: readonly string[]): void {
    this.lastLevel = new Set(liveTaskIds);
    for (const p of [...this.entries.values()]) {
      if (!p.taskId) {
        // Known-background but never BOUND (its ack carried no agentId and
        // `task_started` omitted the optional tool_use_id): no id to match, so
        // membership tells us nothing — except when the live set is EMPTY, which
        // says outright that no background task is running. That is a deduction
        // from the level signal, not a guess about this entry.
        if (p.background && !p.sweepSuspended && this.lastLevel.size === 0) {
          this.done(p.toolUseId);
        }
        continue;
      }
      if (this.lastLevel.has(p.taskId)) {
        p.background = true;
        p.sweepSuspended = false;
      } else if (p.background && !p.sweepSuspended) {
        this.done(p.toolUseId);
      }
    }
    for (const taskId of this.lastLevel) {
      const known = this.knownTasks.get(taskId);
      // Only ids we once saw LAUNCHED at top level can come back — a nested
      // agent is never remembered, so the level signal cannot smuggle one in.
      if (!known || this.entries.has(known.toolUseId)) continue;
      this.enforceCap();
      const p: RosterEntry = {
        toolUseId: known.toolUseId,
        steps: known.steps,
        seenAt: this.now(),
        lastSentAt: 0,
        dirty: true,
        taskId,
        background: true,
        ...(known.label ? { label: known.label } : {}),
      };
      this.entries.set(known.toolUseId, p);
      this.send(p);
    }
  }

  /**
   * This subagent ended. Emits a TERMINAL frame so the server drops it from its
   * own copy in the same beat. Unknown ids are a no-op.
   */
  done(toolUseId: string): void {
    const p = this.entries.get(toolUseId);
    if (!p) return;
    // Carry the step count over, so a RESUMED agent's row picks up where it
    // left off rather than restarting at zero.
    if (p.taskId) this.remember(p.taskId, p);
    this.entries.delete(toolUseId);
    this.emit({ ...wireProgress(p), done: true });
  }

  /**
   * Keep the roster under {@link MAX_ROSTER_ENTRIES} by retiring the
   * EARLIEST-LAUNCHED entry. Reaching this means an end-path is leaking — the
   * log says so — but the status rail stays bounded meanwhile.
   *
   * Deliberately launch order, not `seenAt`: evicting the longest-SILENT entry
   * would be a decay window wearing a different hat, and P1 measured a live
   * background subagent going 44s without a word.
   */
  private enforceCap(): void {
    while (this.entries.size >= MAX_ROSTER_ENTRIES) {
      const first = this.entries.values().next();
      if (first.done) return;
      const oldest = first.value;
      // One line per overflow episode, not one per launch — a leaking roster
      // would otherwise fill the pane's terminal face.
      if (this.now() - this.lastOverflowWarnAt >= OVERFLOW_WARN_INTERVAL_MS) {
        this.lastOverflowWarnAt = this.now();
        this.log(
          `⚠ subagent roster hit its ${MAX_ROSTER_ENTRIES}-entry cap — retiring the stalest entry (${oldest.label ?? oldest.toolUseId}). An end-path is leaking.`,
        );
      }
      this.done(oldest.toolUseId);
    }
  }

  /**
   * Retire only the entries a stopped/failed turn takes with it that nothing
   * else will report: the ones that are NOT background tasks.
   *
   * {@link retireAll} used to run here, and it was wrong. Live probe
   * (`--stop-after`, 2026-09): an interrupt kills the tasks of the INTERRUPTED
   * turn and announces each — `task_updated{status:'killed'}` then
   * `task_notification{status:'stopped'}` — while the level payload emitted at
   * the same instant still lists the background tasks belonging to EARLIER
   * turns, which go on to finish normally (measured: 19s and 28s later). A
   * fleet is exactly that: long-running agents launched across many turns. So
   * `retireAll` on a Stop was deleting live agents, and the pane's count read
   * BELOW the truth until a later level payload happened to resurrect them.
   *
   * A FOREGROUND Task in flight has no such reporting: it never appears in the
   * level set and its `tool_result` may never arrive if the turn was killed.
   * That — and only that — is what this retires.
   */
  retireForeground(reason: string): void {
    const doomed = this.values().filter((p) => !p.background);
    const spared = this.entries.size - doomed.length;
    if (doomed.length === 0 && spared === 0) return;
    // Always say something when the roster was non-empty. A Stop that
    // deliberately keeps rows is the interesting case, and a leak there would
    // otherwise leave no breadcrumb in the pane's terminal face at all.
    this.log(
      `⏹ ${reason}: retired ${doomed.length} foreground subagent(s), kept ${spared} background one(s)`,
    );
    for (const p of doomed) this.done(p.toolUseId);
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
