/**
 * Should this chat's process be stopped for being idle — and is it safe?
 *
 * Pulled out of the sweep for the reason `IdleStop` and `AppHeal` were: the
 * timer, ptyd and the client map around it are plumbing, and this is the part
 * that can be wrong. Testable without a pty.
 *
 * ─── THE HALF THAT WAS NEVER BUILT ──────────────────────────────────────────
 * `PaneStore.listAgentPanes` has carried the lazy-START policy from the
 * beginning — "an idle chat starts when its next send is queued, because
 * keeping every historical chat resident is what put 103 panes on this
 * machine". Nothing ever stopped one again, so every chat ever opened stayed
 * resident. Measured: 124 runners holding 125 harness processes, 13.8 GB, of
 * which 71 runners — roughly 8 GB — belonged to chats untouched for three days
 * or more.
 *
 * ─── WHY STOPPING COSTS ALMOST NOTHING ──────────────────────────────────────
 * The thing a resident process is assumed to buy is warm context, and it buys
 * none: the model API is stateless, so every turn re-sends the whole
 * conversation whether the process has been up a week or two seconds, and
 * prompt caching is content-addressed server-side rather than held in the
 * harness. The conversation is on disk and the pane's `startup_cmd` is already
 * `muxpad agent --resume <sid>`. What a revival actually costs is a couple of
 * seconds of process boot.
 *
 * Harness-held WAKEUPS are the one thing genuinely lost, and muxpad already
 * forbids them (see agent-instructions: the harness's own schedulers "live
 * INSIDE this session… lose every fire that came due while the machine was
 * asleep or the pane was closed"). The sanctioned replacement, `muxpad cron`,
 * is a durable row that revives the pane by enqueuing into it — so a correctly
 * written schedule survives parking because it was never in the process.
 *
 * ─── EVERY "DON'T KNOW" KEEPS THE PROCESS ───────────────────────────────────
 * The asymmetry runs one way: parking a chat that was busy destroys work in
 * flight, while failing to park one costs some memory until the next sweep. So
 * every uncertain branch here returns false.
 */

export interface ParkInput {
  /** The agent session's own status. Anything but `idle` is doing something. */
  status: string | null | undefined;
  /** Is this pane's chat open on some device right now? */
  watched: boolean;
  /** Messages waiting to be delivered to it. */
  queued: number;
  /** Spawn rounds of this chat that have not ended — work it is mid-way through. */
  openRounds: number;
  /** Is it a sub-chat (`tabs.spawned_by`)? */
  isSubChat: boolean;
  /**
   * Has its chat left the live list (`tabs.retired_at`)?
   *
   * The strongest signal there is: a retired chat is FINISHED — delivered, or
   * archived by hand — and `listAgentPanes` already refuses to auto-start one.
   * That is the same fact read the other way round, which is why a retired pane
   * is parked on a much shorter fuse than a live chat going quiet.
   */
  retired: boolean;
  /** Has it stopped to ask the user something? */
  blocked: boolean;
  /** Already parked — nothing to do. */
  parked: boolean;
  /** ms since the chat last saw activity; null when it never has. */
  idleMs: number | null;
  idleThresholdMs: number;
  /** The shorter fuse for a chat that has already finished. */
  retiredThresholdMs: number;
}

export function shouldParkPane(i: ParkInput): boolean {
  if (i.parked) return false;
  // Somebody is looking at it. The sweep's own comment makes the same point
  // about resurrection: an unattended chat has no client by definition, and the
  // converse is what this guards — closing a browser must not be the only thing
  // standing between a reader and their chat going away under them.
  if (i.watched) return false;
  // Anything but a settled `idle` is work: a running turn, a status we do not
  // recognise from a newer runner, or no session row at all.
  if (i.status !== 'idle') return false;
  // It stopped to ASK you something. The answer is coming to a process that
  // must still be there to receive it.
  if (i.blocked) return false;
  // Queued work is the very condition `listAgentPanes` uses to START one;
  // parking here would fight the next sweep.
  if (i.queued > 0) return false;
  // Mid-job. A worker between turns of one job has an open round, which is the
  // distinction `JOB_SETTLE_MS` exists to draw.
  if (i.openRounds > 0) return false;
  // A LIVE sub-chat is supposed to be running without having to prove it each
  // time — that is what spawning one means, and its parent is waiting on it.
  //
  // A RETIRED one is not: it delivered, or it died, and `listAgentPanes` will
  // never auto-start it again (its clause is `retired_at IS NULL AND (… OR
  // spawned_by IS NOT NULL)`). Blanket-excluding every sub-chat made this rule
  // the thing holding most of the memory — 139 of 206 agent panes on the
  // measured machine, nearly all of them finished workers.
  if (i.isSubChat && !i.retired) return false;
  // Never active, so nothing is known about it. Not evidence of idleness.
  if (i.idleMs === null) return false;
  // A FINISHED chat does not need three days to prove it is finished. Every
  // guard above still applies — a retired tab mid-round, or one somebody has
  // open, is left alone exactly as a live one would be.
  return i.idleMs >= (i.retired ? i.retiredThresholdMs : i.idleThresholdMs);
}

/**
 * How long a chat must be untouched before its process is stopped.
 *
 * Three days: past any session you are still in, and short enough that the
 * memory actually comes back — on the measured distribution it is the step
 * where 69 of 123 runners sit. The cost of being wrong is a couple of seconds
 * the next time you open one of them.
 */
export const PARK_AFTER_MS = 3 * 86_400_000;

/**
 * …and how long a RETIRED chat waits. An hour, not three days: it has left the
 * live list, so it is done by definition, and the hour is only there so a
 * worker that delivered seconds ago is not killed while anything is still
 * settling around it (the spawn report, the parent's card).
 */
export const PARK_RETIRED_AFTER_MS = 60 * 60_000;

/** How often the sweep looks. Cheap: one query and a set lookup per pane. */
export const PARK_SWEEP_MS = 10 * 60_000;
