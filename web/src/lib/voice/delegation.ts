// THE TASK RECORD: one durable handle per thing the user asked for.
//
// This file used to be a claim-ledger with a revision counter bolted on, and it
// conflated three separable things into the one counter:
//
//   (a) IDENTITY — which piece of in-flight work is this?
//   (b) REFERENCE — which piece of work is the user talking about now?
//   (c) ARRIVAL POLICY — what happens when a second request lands on a busy
//       agent?
//
// Answering (c) by bumping a counter destroyed (a) and (b): every new
// delegation invalidated the previous one, so there was only ever one piece of
// work that existed, and "which one do you mean?" could not even be asked. That
// is the whole bug — speaking became a kill switch because the data model had
// no room for two live tasks.
//
// So the primitive here is a TASK RECORD with a stable id and an explicit
// status, and nothing else in this folder is allowed to infer liveness from
// anything but that status. The shape follows two standards that converged on
// it independently — MCP's `io.modelcontextprotocol/tasks` (durable handle,
// `working → input_required → completed|failed|cancelled`) and A2A's `Task`
// (task id plus a context id grouping tasks into one conversation) — because
// where they agree is where the shape is load-bearing rather than fashionable.
// The 1000-year-old version is Hohpe & Woolf's Correlation Identifier.
//
// ═══ THREE THINGS IT HAS TO GET RIGHT ═══
//
// DUPLICATE DELIVERY. `session.delegation.created` is not exactly-once; the
// contract says so outright. An agent turn costs minutes and real money, so
// "handle it twice" is not cosmetic, it is two Claude sessions racing to edit
// the same repo. Every task is CLAIMED before any work starts: `claim` returns
// a record the first time and null forever after, and the caller's only legal
// response to null is to do nothing at all. Claiming is synchronous and happens
// before the first await, which is what makes it a lock rather than a hint.
//
// INPUT_REQUIRED IS NOT DONE. An agent parked on `ask_user` — or on the
// reversibility gate in front of `git push` — is blocked, not finished. It is a
// first-class NON-terminal state here for the same reason MCP made it one: a
// status model that only knows running/finished has to represent "waiting for
// you" as one of the two, and both are lies the UI then tells the user.
//
// CANCELLATION IS COOPERATIVE. `{t:'stop'}` is a REQUEST. The turn takes a
// moment to die and can still emit a final reply on its way out — we cannot
// un-run it. Hence the fence below.
//
// ═══ THE REVISION COUNTER IS A FENCING TOKEN ═══
//
// Not a concurrency policy — a fence, in Kleppmann's sense. Because cancelling
// is cooperative, a task the user has abandoned can still produce output; the
// fence's only job is to stop that output from being SPOKEN. Each task
// snapshots the counter at claim time, an explicit cancel bumps it, and every
// deferred path re-checks before it emits. It decides nothing about whether to
// cancel and nothing about what runs — it is a filter over speech, and that is
// all it has ever been good at.
//
// It is deliberately NOT bumped when a new task arrives. That was the old
// behaviour and it is exactly what made a second question destroy the answer to
// the first.
//
// ═══ WHAT IS DELIBERATELY LEFT OPEN ═══
//
// Tasks share one conversation and are ordered by claim time, so "the one
// before this one" is expressible. RESOLVING a spoken reference to a task
// ("what about that thing I asked earlier?") is not attempted anywhere in this
// folder — it is genuinely unsolved and it belongs in its own module. The point
// of a stable id plus an ordered, queryable set of live tasks is that such a
// module remains POSSIBLE. Do not add heuristics for it here.

/**
 * The task lifecycle. Terminal states drop the record from the live set; the
 * id stays remembered, so a duplicate delivery is still refused afterwards.
 *
 * `settling` is ours rather than MCP's: a voice task exists before anyone knows
 * what it asked for, because the delegation routinely beats the transcript that
 * caused it.
 */
export type TaskStatus =
  /** Claimed. The request is still being reconstructed from the transcript. */
  | 'settling'
  /** Dispatched, waiting its turn behind work already running. */
  | 'queued'
  /** Its turn is on the wire right now. */
  | 'working'
  /** Its turn is blocked on a question for the human. NOT terminal. */
  | 'input_required'
  | 'completed'
  | 'failed'
  | 'cancelled';

const TERMINAL: ReadonlySet<TaskStatus> = new Set<TaskStatus>(['completed', 'failed', 'cancelled']);

export function isTerminal(status: TaskStatus): boolean {
  return TERMINAL.has(status);
}

export interface VoiceTask {
  /** Stable for the life of the task. The model's delegation id — chosen by
   *  someone else, which is what makes it a correlation id rather than a
   *  sequence number we could accidentally reuse. */
  readonly id: string;
  status: TaskStatus;
  /** Fencing token snapshotted at claim time. Compared, never displayed. */
  readonly revision: number;
  readonly claimedAt: number;
  /** The delegation's `offset_ms`, kept so the settle timer can re-ask the
   *  transcript buffer for a sentence that has since finished arriving. */
  readonly offsetMs: number;
  /**
   * Exactly what went out as `{t:'send'}`, once it has. Empty while settling.
   *
   * Load-bearing, not a log field: the server echoes this text back on
   * `turn-start` and on `queued`, and matching it is how a frame on a flat
   * per-pane socket finds the task it belongs to.
   */
  request: string;
  /** The server's queue row id, once it tells us this send was parked. Null
   *  while settling, running, or if it went out on the idle fast path. */
  queueId: string | null;
  /** Did this land behind work of ours that was already in flight? */
  wasQueued: boolean;
  /** When the request went out. The reference point for "has the conversation
   *  moved on since the user asked this?" — see session.ts's `movedOn`. */
  dispatchedAt: number;
  /** How many progress updates this task has already spoken. Part of the
   *  moved-on test: an intermediate update is itself a thing the conversation
   *  did, so a result arriving after one needs re-anchoring even if nobody
   *  said a word in between. */
  intermediatesSent: number;
}

/** Kept as an alias so existing readers of the old name still typecheck.
 *  @deprecated use {@link VoiceTask}. */
export type DelegationContext = VoiceTask;

/** How many task ids to remember for duplicate suppression. A voice session is
 *  minutes long and delegates single digits per minute; this is three orders of
 *  magnitude of headroom, and bounded so a pathological session cannot grow
 *  without limit. */
const SEEN_CAP = 512;

export class DelegationRegistry {
  private revision = 0;
  private readonly seen = new Set<string>();
  private readonly seenOrder: string[] = [];
  private readonly live = new Map<string, VoiceTask>();

  /**
   * Take exclusive ownership of a task.
   *
   * Returns a record on the FIRST call for an id and null on every subsequent
   * call, including calls that arrive long after the work has finished.
   * Idempotent by construction: there is no window between the membership test
   * and the insert, because this function does not await.
   */
  claim(id: string, opts: { now: number; offsetMs: number }): VoiceTask | null {
    if (!id || this.seen.has(id)) return null;
    this.seen.add(id);
    this.seenOrder.push(id);
    if (this.seenOrder.length > SEEN_CAP) {
      const evicted = this.seenOrder.shift();
      if (evicted) this.seen.delete(evicted);
    }
    const task: VoiceTask = {
      id,
      status: 'settling',
      revision: this.revision,
      claimedAt: opts.now,
      offsetMs: opts.offsetMs,
      request: '',
      queueId: null,
      wasQueued: false,
      dispatchedAt: 0,
      intermediatesSent: 0,
    };
    this.live.set(id, task);
    return task;
  }

  /** Has this id ever been claimed? Duplicate detection for callers that want
   *  to log the duplicate rather than silently drop it. */
  hasSeen(id: string): boolean {
    return this.seen.has(id);
  }

  /**
   * Move a task's status on. Terminal statuses retire it from the live set.
   *
   * The one place status changes, so "who closed this task?" has exactly one
   * answer and a late frame cannot quietly resurrect a cancelled one.
   */
  setStatus(id: string, status: TaskStatus): void {
    const task = this.live.get(id);
    if (!task) return;
    task.status = status;
    if (isTerminal(status)) this.live.delete(id);
  }

  /**
   * Invalidate everything claimed so far — the FENCE, bumped on an explicit
   * cancel and on teardown, and nowhere else.
   *
   * In particular NOT on a new task: a second request queues behind the first
   * rather than invalidating it, and bumping here is precisely what made
   * speaking a kill switch. Returns the new revision.
   */
  bumpRevision(): number {
    this.revision += 1;
    return this.revision;
  }

  currentRevision(): number {
    return this.revision;
  }

  /**
   * The one predicate every deferred path asks before it emits speech.
   *
   * Two ways to be stale, and they mean different things: behind the fence (the
   * user explicitly abandoned this), or no longer live (its turn is over). Both
   * mean "do not speak on behalf of this task".
   */
  isStale(task: VoiceTask): boolean {
    return this.currentRevision() !== task.revision || !this.live.has(task.id);
  }

  /** The live record for an id, if it has not reached a terminal state. */
  get(id: string): VoiceTask | undefined {
    return this.live.get(id);
  }

  /**
   * Every live task, oldest claim first.
   *
   * Note what this is FOR. session.ts does not attribute frames with it — it
   * keeps its own list in DISPATCH order, which is the order the server runs
   * them in, and claim order is not quite that (two tasks can settle out of
   * order). This is the addressable, ordered set of live work: the thing a
   * future reference-resolution module ("that thing I asked about earlier")
   * would need to exist. It is not itself a resolution heuristic, and it must
   * not grow into one here.
   */
  openContexts(): VoiceTask[] {
    return [...this.live.values()].sort((a, b) => a.claimedAt - b.claimedAt);
  }

  /**
   * The newest live task.
   *
   * NOT an attribution mechanism — with overlapping tasks "the newest one" is
   * routinely not the one whose turn is on the wire, and using it as one is how
   * an answer to question A gets spoken as the answer to question B. Kept for
   * the narrow cases that genuinely mean "the most recent thing the user asked
   * for", such as which task to speak a cancel confirmation under.
   */
  active(): VoiceTask | undefined {
    let best: VoiceTask | undefined;
    for (const task of this.live.values()) {
      if (!best || task.claimedAt >= best.claimedAt) best = task;
    }
    return best;
  }

  isOpen(id: string): boolean {
    return this.live.has(id);
  }

  /** Work is done (or abandoned). The id stays in `seen`, so a duplicate
   *  delivery after completion is still refused. Prefer {@link setStatus} when
   *  the REASON is known — it is the difference between "answered" and
   *  "cancelled" in every diagnostic downstream. */
  finish(id: string): void {
    this.setStatus(id, 'completed');
  }

  /** End of session. Live work is abandoned and the fence bumps so any timer
   *  that survives the teardown finds itself stale. */
  reset(): void {
    this.live.clear();
    this.bumpRevision();
  }
}
