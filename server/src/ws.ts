import type { Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { parseCronMarker, sanitizeAgentStatus } from '@muxpad/shared';
import type Database from 'better-sqlite3';
import { WebSocket, WebSocketServer } from 'ws';
import type { AgentBridge } from './agent-bridge.js';
import { recordModelCatalog } from './agent-model-catalog.js';
import {
  type AgentQuestion,
  CLOSE_RUNNER_DISPLACED,
  type RunnerFrame,
  type ServerFrame,
  type SubagentProgress,
  isBackendId,
  parseFrame,
} from './agent-runner/protocol.js';
import { TranscriptTail, identityNormalize, muxpadLocate } from './chat/TranscriptReader.js';
import { agentPaneHasMessages } from './chat/has-messages.js';
import type { EventBus } from './events.js';
import { hasProjectContext } from './project-root.js';
import { type PtydCache, decoratePane, decorateTab } from './ptyd-cache.js';
import type { PtydClient } from './ptyd-client/PtydClient.js';
import { proxyAttach } from './ptyd-client/proxyAttach.js';
import type { PaneNotifier } from './push.js';
import {
  RESPAWN_COOLDOWN_MS,
  RESPAWN_MAX_ATTEMPTS,
  RESPAWN_PROBATION_MS,
  RESPAWN_STARTUP_GRACE_MS,
  RESPAWN_SWEEP_MS,
} from './respawn-policy.js';
import { safeCwd } from './safe-cwd.js';
import { checkOrigin, parseAllowedOrigins } from './same-origin.js';
import { AgentQueueStore } from './store/AgentQueueStore.js';
import { AgentSessionStore } from './store/AgentSessionStore.js';
import { PaneStore } from './store/PaneStore.js';
import { TabStore } from './store/TabStore.js';
import { TabActivity } from './tab-activity.js';

export interface WsServerHandle {
  close(): Promise<void>;
  /**
   * Run one dead-runner sweep now. Exposed so a test can drive the supervision
   * pass deterministically — its real cadence (20s sweep, 45s cooldown) makes
   * it untestable otherwise, and the ptyd-outage behaviour is exactly the part
   * that must not regress. Single-flight, same as the timer's call.
   */
  sweepDeadRunners(): Promise<void>;
}

// Initial chat history window: only the last ~128 KB of the transcript ship on
// connect (≈ a few hundred recent messages for typical transcripts). Older
// messages page in on scroll-up via the `load-older` request, so opening a chat
// backed by a tens-of-MB transcript stays instant.
const CHAT_HISTORY_TAIL_BYTES = 128 * 1024;

// A turn completing within this window of the user's own chat send is an
// interactive conversation — its turn-done must not push-notify (the user
// is right there). Longer turns and autonomous wakeup/cron turns do push.
const INTERACTIVE_PUSH_SUPPRESS_MS = 2 * 60_000;

// Upper bound on a pane's pending send queue. Generous for real batches (queue a
// dozen follow-ups) but a hard stop against unbounded growth from a wedged turn
// or a runaway client / HTTP caller.
const MAX_QUEUED_SENDS = 200;

/**
 * Hard bound on the SERVER's mirror of a pane's subagent roster. The runner
 * enforces its own cap (SubagentRoster.MAX_ROSTER_ENTRIES) — this is the
 * independent one, because runners are version-skewed by design: a pane keeps
 * its old runner process until it respawns, and a pre-durable runner never
 * emits a terminal frame, so this map only ever grew. Deliberately the same
 * number, so the two agree about what "absurd" means.
 */
export const MAX_PANE_SUBAGENTS = 32;

/** Rate limit for the roster-overflow warning, per pane. */
const OVERFLOW_WARN_MS = 60_000;

/**
 * How long a roster entry may show NO forward progress before the server
 * retires it on its own authority.
 *
 * Deliberately generous. A healthy subagent bumps `steps` on every tool call,
 * so minutes of total silence is already abnormal — but "abnormal" is not
 * "dead", and a single very long tool call (a full test suite, a slow network
 * fetch) must not cost a live agent its row. 20 minutes is far past any real
 * tool call and far short of the multi-hour ghosts this exists to kill.
 */
export const SUBAGENT_STALL_MS = 20 * 60_000;

/** How often the stall sweep runs. Cheap: a walk of a handful of small maps. */
const STALL_SWEEP_MS = 60_000;

/**
 * Retire roster entries that have stopped making progress.
 *
 * WHY THE SERVER NEEDS ITS OWN COPY OF THIS. The runner already ends its
 * subagents on four paths, and does it well — but a runner only picks up that
 * code when its PANE RESPAWNS, and panes live for weeks. A pre-durable runner
 * emits no terminal frame at all, so before this the server's mirror had
 * exactly one escape: {@link evictOverflowEntries}, which is a bound (32), not
 * a policy. A pane leaking 2 ghosts never reaches 32 and reads `working`
 * forever. (Live pane, 2026-09: 2 ghosts, 13-day-old runner, an hour after
 * both processes were killed.)
 *
 * WHY NOT JUST TIME-SINCE-LAST-FRAME. The runner's 5s keepalive re-announces
 * every live entry, ghosts included, so arrival time says nothing. What the
 * keepalive deliberately does NOT do is invent progress: it re-sends the last
 * REAL payload unchanged. So the signal is CONTENT CHANGE, not arrival —
 * `steps` advancing is a subagent doing something, and a frozen `steps` across
 * 20 minutes of heartbeats is a subagent that no longer exists.
 *
 * SCOPE — ONLY rows from runners too old to send `seenAt`. This is the whole
 * safety argument, and it is narrow on purpose.
 *
 * A modern runner does not need us. It ends its subagents on four paths plus an
 * authoritative LEVEL signal (`system/background_tasks_changed` carries the full
 * live set), and it knows two things the server cannot see: which rows are
 * PARKED behind a rate limit — `sweepSuspended`, whose own comment is "absence
 * must never be the thing that kills a running subagent" — and that a row's
 * silence may just be one enormous tool call. Neither survives `wireProgress`.
 * So silence, at the server, is not evidence: a rate-limit hold runs for hours
 * and `muxpad agent wait --timeout=3600` is a thing this very codebase does.
 * Second-guessing a modern runner from silence trades a rare leak for a common
 * false negative on a perfectly healthy agent — and a false negative here hides
 * a LIVE agent's row and reads the pane as idle while real work runs.
 *
 * A pre-`seenAt` runner is the opposite case: it has no terminal frame at all,
 * no level reconciliation, and no keepalive. Its leaks are permanent by
 * construction, its `changedAt` is a true "nothing has happened since", and
 * nothing else in the system can ever clean up after it. That is the population
 * worth acting on, and the only one.
 *
 * Reaping is not destructive: nothing is killed, only unlisted. A reaped row
 * returns on its next materially-different frame. But note the tombstone makes
 * that return conditional on real progress rather than automatic — which is
 * exactly why this must not fire on runners whose quiet rows are legitimate.
 */
export function reapStalledEntries(
  subagents: Map<string, SubagentProgress>,
  changedAt: Map<string, number>,
  now: number,
  reaped?: Map<string, SubagentProgress>,
  staleMs: number = SUBAGENT_STALL_MS,
): string[] {
  const dropped: string[] = [];
  for (const [id, p] of subagents) {
    // `seenAt` present ⟹ a runner new enough to end its own subagents and to
    // know which of them are legitimately quiet. Leave it alone; see the scope
    // note above. This is a capability probe, not a freshness read — we never
    // compare against `seenAt`, we only ask whether the field exists.
    if (p.seenAt !== undefined) continue;
    const fresh = changedAt.get(id);
    // No stamp: adopt `now` so the entry gets a full window from when we first
    // noticed it, rather than being reaped on sight.
    if (fresh === undefined) {
      changedAt.set(id, now);
      continue;
    }
    if (now - fresh > staleMs) dropped.push(id);
  }
  for (const id of dropped) {
    // Record what the row looked like at death BEFORE dropping it: the
    // tombstone is what lets the insert path tell a keepalive echo of this
    // exact payload from the row genuinely coming back to life.
    const p = subagents.get(id);
    if (reaped && p) {
      reaped.set(id, p);
      // A bound, not a policy — same reasoning as MAX_PANE_SUBAGENTS. A
      // tombstone is released by a `done`, by real progress, or by teardown;
      // the ghost this exists for does none of those, so its entry would
      // otherwise live as long as the connection, and connections live weeks.
      // Dropping the oldest only risks one more reap/echo cycle for a row
      // nobody has heard from in a very long time.
      while (reaped.size > MAX_PANE_SUBAGENTS) {
        const oldest = reaped.keys().next();
        if (oldest.done) break;
        reaped.delete(oldest.value);
      }
    }
    subagents.delete(id);
    changedAt.delete(id);
  }
  return dropped;
}

/**
 * Did this frame carry real news about the subagent, or is it the keepalive
 * re-sending what we already had? Only the former restarts the stall clock.
 */
export function isMaterialProgress(
  prev: SubagentProgress | undefined,
  next: SubagentProgress,
): boolean {
  if (!prev) return true;
  return (
    prev.steps !== next.steps ||
    prev.lastTool !== next.lastTool ||
    prev.label !== next.label ||
    prev.seenAt !== next.seenAt
  );
}

/**
 * Keep a pane's server-side roster under {@link MAX_PANE_SUBAGENTS} by dropping
 * the oldest INSERTIONS (Map iteration order). Returns the ids evicted so the
 * caller can log; empty in every healthy case.
 */
export function evictOverflowEntries(subagents: Map<string, unknown>): string[] {
  const dropped: string[] = [];
  while (subagents.size > MAX_PANE_SUBAGENTS) {
    const oldest = subagents.keys().next();
    if (oldest.done) break;
    subagents.delete(oldest.value);
    dropped.push(oldest.value);
  }
  return dropped;
}

/**
 * Say no to an upgrade before it becomes a WebSocket.
 *
 * The socket is still a raw TCP stream here — `ws` has not touched it — so the
 * refusal is a hand-written HTTP response. It must be a real one and not a bare
 * `socket.destroy()`: a browser reports a destroyed socket as an opaque
 * connection error, while a 403 shows up in devtools with a body naming the
 * escape hatch. That is the difference between "muxpad is broken" and "muxpad
 * told me exactly which env var to set".
 *
 * Nothing in here may throw. A raw upgrade socket has no 'error' listener yet,
 * and an unhandled 'error' on a net.Socket is a process-level throw — a peer
 * that resets while we write the 403 would take the whole server down, which
 * would be a far better attack than the one we are closing. Hence the no-op
 * listener before the write, and the try/catch around both calls.
 */
function refuseUpgrade(socket: Duplex, why: string): void {
  socket.on('error', () => {
    // The peer is being refused; a reset mid-write is expected, not news.
  });
  const body = JSON.stringify({
    error: {
      code: 'cross_origin_refused',
      message: `cross-origin WebSocket upgrade refused (${why}); set MUXPAD_ALLOWED_ORIGINS to allow this origin`,
    },
  });
  // write-then-destroy delivers this body whole — measured against a client
  // that never reads, truncation only starts around 8 MB, where write() starts
  // returning false. Keep the body small (it is a fixed ~250 bytes) or switch
  // to socket.end(), which flushes but leaves the socket alive until the peer
  // closes it — a worse trade for a refusal an attacker can repeat.
  const head = [
    'HTTP/1.1 403 Forbidden',
    'Connection: close',
    'Content-Type: application/json',
    `Content-Length: ${Buffer.byteLength(body)}`,
  ].join('\r\n');
  try {
    socket.write(`${head}\r\n\r\n${body}`);
  } catch {
    // socket already gone
  }
  try {
    socket.destroy();
  } catch {
    // already destroyed
  }
}

/**
 * Rate limiter for the refusal log. One line per offending origin per minute:
 * enough to diagnose a lockout, not enough for a page (or a wedged client of
 * the user's own) reconnecting in a loop to fill the log with the same line.
 */
function makeRefusalLogger(log: (line: string) => void): (origin: string, why: string) => void {
  const lastLoggedAt = new Map<string, number>();
  const WINDOW_MS = 60_000;
  return (origin, why) => {
    const now = Date.now();
    const previous = lastLoggedAt.get(origin);
    if (previous !== undefined && now - previous < WINDOW_MS) return;
    // Unbounded growth would be a (very slow) leak, and a caller that varies
    // its Origin per request defeats the key anyway. The map only exists to
    // suppress repeats, so dropping the whole thing when it gets silly costs
    // at most one extra log line. Cleared BEFORE the set, or the origin that
    // tripped the limit would be evicted immediately and log again next time —
    // which is exactly the flood this is here to stop.
    if (lastLoggedAt.size > 256) lastLoggedAt.clear();
    lastLoggedAt.set(origin, now);
    log(
      `muxpad: refused WebSocket upgrade from ${origin} — ${why}. If this is your own front end, add its origin to MUXPAD_ALLOWED_ORIGINS.`,
    );
  };
}

export function attachWsServer(deps: {
  http: Server;
  db: Database.Database;
  ptyd: PtydClient;
  cache: PtydCache;
  events: EventBus;
  /** Liveness ping interval in ms. Defaults to 15s; tests pass a small value. */
  heartbeatMs?: number;
  /** When provided, gets its `send` bound to the live runner registry. */
  agentBridge?: AgentBridge;
  /**
   * Web Push sender for chat-runner events that never touch the terminal
   * BEL/attention path: turn-done and agent questions. Optional — tests
   * and push-less deployments omit it.
   */
  notifyPane?: PaneNotifier;
  /**
   * Shared per-tab activity recorder (the living sidebar's recency signal).
   * Optional so existing tests can omit it; when absent this module builds
   * its own, which only costs a duplicate throttle window.
   */
  tabActivity?: TabActivity;
  /**
   * Extra hostnames the upgrade guard trusts as an Origin, on top of loopback
   * and "same hostname as Host". Production omits it and the guard reads
   * MUXPAD_ALLOWED_ORIGINS; this is the injection seam for tests. Same shape
   * and same meaning as AppDeps.allowedOrigins — deliberately, since both feed
   * the one predicate in same-origin.ts.
   */
  allowedOrigins?: Set<string>;
  /** Refusal sink. Defaults to console.warn; tests pass a collector. */
  logRefusal?: (line: string) => void;
}): WsServerHandle {
  const wss = new WebSocketServer({ noServer: true });
  const allowedOrigins =
    deps.allowedOrigins ?? parseAllowedOrigins(process.env.MUXPAD_ALLOWED_ORIGINS);
  const logRefusal = makeRefusalLogger(deps.logRefusal ?? ((line: string) => console.warn(line)));
  const panes = new PaneStore(deps.db);
  const tabs = new TabStore(deps.db);
  // Living sidebar: bumps `tabs.last_activity_at`. Forced for discrete
  // moments (turn done, user send), throttled for raw pty chatter.
  const activity = deps.tabActivity ?? new TabActivity(deps.db);
  const agents = new AgentSessionStore(deps.db);
  // Server-owned queue of user messages waiting for a busy/reconnecting agent.
  // The server drains it one message per turn (see drainQueue), so a queue keeps
  // feeding the agent even with no browser open; chat clients render the pending
  // bubbles from here, so they survive reloads and follow the user across devices.
  const queue = new AgentQueueStore(deps.db);
  // Any headless writer / running status persisted by a previous process is a
  // turn that died with it (restart mid-turn) — clear it or panes look stuck.
  agents.reconcileStartup();
  // Live chat sockets per pane. Turn lifecycle frames (turn-start / stream /
  // turn-done) broadcast to every open chat view of the pane — including one
  // that reconnected mid-turn — not just the socket that sent the message.
  const chatClients = new Map<string, Set<(obj: unknown) => void>>();
  // Accumulated streamed text of the in-flight turn per pane, so a socket
  // that (re)connects mid-turn can show the partial assistant text instead of
  // a bare typing indicator until the next delta. Capped: it's a typing
  // preview, not the source of truth (the transcript is) — a runaway turn
  // must not balloon server memory or reconnect payloads.
  const streamBufs = new Map<string, string>();
  const STREAM_BUF_MAX = 256 * 1024;
  const appendStreamBuf = (paneId: string, delta: string) => {
    const next = (streamBufs.get(paneId) ?? '') + delta;
    streamBufs.set(paneId, next.length > STREAM_BUF_MAX ? next.slice(-STREAM_BUF_MAX) : next);
  };
  // Fan a frame out to every open chat view of a pane.
  const bcastToPane = (paneId: string, obj: unknown) => {
    for (const fn of chatClients.get(paneId) ?? []) fn(obj);
  };
  // Push a pane's fresh row to every browser (face flips, startup_cmd) so
  // views sync live instead of on their next fetch.
  const emitPaneUpdated = (paneId: string) => {
    const pane = panes.getById(paneId);
    if (pane) {
      deps.events.emit({
        type: 'pane.updated',
        tab_id: pane.tab_id,
        pane: decoratePane(deps.cache, pane),
      });
    }
  };
  // Auto-name agent panes/tabs from the session's AI title (the `ai-title`
  // records Claude appends to the transcript after the first turn and on topic
  // shifts).
  //
  // A USER-GIVEN NAME WINS PERMANENTLY, and that is now a persisted fact
  // (`tabs.name_sticky`, set by PATCH /api/tabs whenever a name is supplied)
  // rather than the in-memory map it used to be. The map's own comment
  // conceded the flaw: after a restart every existing auto-name was treated as
  // user-given, so the guard held only by the accident that a manual name
  // matched neither the bootstrap sentinel nor the last title — and a tab
  // renamed BACK to something the namer had once produced was fair game again.
  //
  // The in-memory map survives for PANES (which have no sticky column and use
  // `name === null` as their sentinel) and as the "we set this one" record for
  // tabs within a process lifetime.
  const autoTitledPanes = new Map<string, string>();
  const autoTitledTabs = new Map<string, string>();
  const applyAiTitle = (paneId: string, rawTitle: string) => {
    const title = rawTitle.trim().slice(0, 80);
    if (!title) return;
    // Only agent-native panes (persistent SDK runner) self-name; a terminal
    // pane where the user runs `muxpad claude` keeps its own labeling.
    if (agents.getByPane(paneId)?.writer !== 'sdk') return;
    const pane = panes.getById(paneId);
    if (!pane) return;
    if (pane.name === null || pane.name === autoTitledPanes.get(paneId)) {
      if (pane.name !== title) {
        panes.setName(paneId, title);
        autoTitledPanes.set(paneId, title);
        emitPaneUpdated(paneId);
      } else {
        autoTitledPanes.set(paneId, title);
      }
    }
    // Rename the tab too when this pane is its only one (the agent-tab shape)
    // and the tab still wears the bootstrap default or our previous title.
    const tab = tabs.getById(pane.tab_id);
    if (!tab || panes.listByTab(tab.id).length !== 1) return;
    // The one check that outranks everything else, restart included.
    if (tabs.isNameSticky(tab.id)) return;
    if (tab.name === 'agent' || tab.name === autoTitledTabs.get(tab.id)) {
      if (tab.name !== title) {
        const updated = tabs.update(tab.id, { name: title });
        autoTitledTabs.set(tab.id, title);
        if (updated)
          deps.events.emit({ type: 'tab.updated', tab: decorateTab(deps.cache, deps.db, updated) });
      } else {
        autoTitledTabs.set(tab.id, title);
      }
    }
  };
  // Connected agent runners (`muxpad agent` processes living in panes),
  // keyed by pane. A connected runner owns its pane's session: chat sends
  // and stops relay to it instead of spawning per-turn `claude -p` workers,
  // and its turn lifecycle fans back out through chatClients.
  interface AgentRunnerConn {
    ws: WebSocket;
    sid: string | null;
    /** Which harness drives this pane (claude|codex|cursor); set at hello. */
    backend: string;
    turnActive: boolean;
    /** Question awaiting the user, so a (re)connecting chat client can render it. */
    pendingQuestion: { qid: string; questions: AgentQuestion[] } | null;
    /** Latest per-task subagent progress for mid-turn (re)connects. */
    subagents: Map<string, SubagentProgress>;
    /**
     * When each roster entry's payload last CHANGED, by toolUseId. Not when a
     * frame last arrived — the 5s keepalive re-sends ghosts unchanged, so
     * arrival time cannot tell a live subagent from a dead one. Feeds
     * {@link reapStalledEntries} for runners too old to send `seenAt`.
     */
    subagentChangedAt: Map<string, number>;
    /**
     * Rows this server retired for stalling, and the payload they carried when
     * we did. A TOMBSTONE, and the reason the reaper terminates.
     *
     * Reaping alone is not enough: a keepalive-era runner re-announces its
     * whole roster every 5s and knows nothing about our decision, so a reaped
     * row reappears within one tick, gets re-reaped by the next sweep, and the
     * pane's count blinks between N and N+1 forever — spraying a bogus `done`
     * at every chat client each minute. Suppressing the re-announce is what
     * makes the reap stick.
     *
     * The tombstone is NOT permanent, and that is the whole safety argument for
     * reaping something that might be alive: it is lifted the moment the row
     * shows real progress (see {@link isMaterialProgress}), so a subagent that
     * was merely parked — a rate-limit hold, one enormous tool call — gets its
     * row back on its very next step rather than staying invisible.
     */
    subagentReaped: Map<string, SubagentProgress>;
    /** Rate limit for the roster-overflow warning (see MAX_PANE_SUBAGENTS). */
    lastOverflowWarnAt: number;
    /** Latest session status (model, context fill, model list) for hellos. */
    status: (RunnerFrame & { t: 'status' }) | null;
    /** When the last chat send was relayed — see the stop handler's gate. */
    lastSendAt: number;
    /**
     * When the last HUMAN message was relayed. Distinct from `lastSendAt`,
     * which any relay bumps: a cron fire is a relay but nobody is sitting
     * there. Provenance is read off the message itself (a cron fire carries
     * its marker), so it survives the durable queue and a server restart —
     * there is no in-memory flag to lose.
     *
     * Two consumers, both of which mean "is a human present?": the turn-done
     * push gate (an autonomous turn SHOULD push — you weren't watching) and
     * the cron `quiet_mins` policy (don't barge into a live conversation).
     */
    lastHumanSendAt: number;
  }
  // A message that carries a cron fire marker was written by the scheduler,
  // not typed by anyone. One predicate, shared by both relay paths.
  const isHumanMessage = (text: string) => parseCronMarker(text) === null;
  const agentRunners = new Map<string, AgentRunnerConn>();
  /**
   * Publish the pane's subagent count to the cache — the number `GET /api/panes`
   * renders as `agents:` and `getStatus` reads as "working".
   *
   * DERIVED, never independently maintained: it is always the REGISTERED
   * runner's roster size, and zero when no runner owns the pane. That
   * one-liner is the whole point — the count used to be written from the
   * `subagent` frame handler and cleared only from teardown, which gave it a
   * lifecycle of its own. Teardown is deliberately muted for a DISPLACED
   * runner (a replaced socket must not detach its successor), so a runner that
   * was replaced rather than closed left its count standing with nothing alive
   * that could ever retire it: the pane rendered a dead process's subagents
   * forever and read `working` for good — a spinner with no way back.
   */
  const syncSubagentCount = (paneId: string): void => {
    deps.cache.setSubagentCount(paneId, agentRunners.get(paneId)?.subagents.size ?? 0);
  };
  /**
   * The bus edge for an OPTIMISTIC turn start — the moment the server relays a
   * send and claims `turnActive` before the runner's own `turn-start` echoes
   * back. Without it that round trip is dark to every subscriber: `turn_active`
   * reads true, `busy` reads false, and no `agent_turn` fires (D14). The
   * runner's real turn-start emits a second `start` a beat later; `start` is
   * idempotent for every consumer (a waiter is already waiting, the Archiver
   * dedupes by sid), so a duplicate is strictly better than a gap.
   */
  const emitOptimisticTurnStart = (paneId: string): void => {
    const conn = agentRunners.get(paneId);
    if (!conn) return;
    // Mirror the optimism into the PERSISTED turn state too. The runner's real
    // `turn-start` sets this, but it's a round trip away, and readers of the
    // row — PaneWebSwitch, `muxpad agent list`, conversionRefusal's mid-turn
    // guard — would meanwhile see 'idle' for a turn that has already been
    // relayed. Same D14 lesson as the cache/bus mirroring above: the three
    // views of "is it running" must not disagree for the length of a round
    // trip. Idempotent; the runner's turn-start writes the same value.
    agents.setStatus(paneId, 'running');
    deps.events.emit({
      type: 'agent_turn',
      pane_id: paneId,
      phase: 'start',
      sid: conn.sid,
      backend: conn.backend,
    });
  };
  const sendToRunner = (paneId: string, frame: ServerFrame): boolean => {
    const r = agentRunners.get(paneId);
    if (!r || r.ws.readyState !== WebSocket.OPEN) return false;
    r.ws.send(JSON.stringify(frame));
    return true;
  };
  // Bind the HTTP route layer's late-bound relay (POST /agent-sessions/
  // :paneId/send) to the live registry. Runner-owned panes only — the
  // headless-spawn path with its guard cascade stays chat-socket-only.
  if (deps.agentBridge) {
    // Route external HTTP sends through the same queue path as chat: a message
    // that can't run right now is persisted and drained later, never dropped.
    deps.agentBridge.send = (paneId, text) => {
      const r = submitSend(paneId, text);
      return r.status === 'rejected'
        ? { ok: false, reason: r.reason ?? 'could not send' }
        : { ok: true, queued: r.status === 'queued' };
    };
    // Real turn state for the HTTP layer (`agent wait`): the registry's
    // turnActive, not pty-output `busy`.
    deps.agentBridge.turnActive = (paneId) => agentRunners.get(paneId)?.turnActive ?? null;
    // Mode switches from PATCH /api/panes/:id reach the live runner here.
    // False just means "no runner right now" — the row + startup_cmd already
    // carry the mode, so the next respawn is correct either way.
    deps.agentBridge.setMode = (paneId, mode) => sendToRunner(paneId, { t: 'mode', mode });
    // The UNWRAPPED queue answer, for the cron scheduler's run history. Same
    // single injection path as `send` above — it just doesn't flatten
    // 'sent'/'queued' into one boolean, because a run log that can't tell "it
    // ran" from "it's waiting behind a turn" is most of the way back to the
    // silent failure this whole thing exists to escape.
    deps.agentBridge.submitSend = (paneId, text) => submitSend(paneId, text);
    // Registry reads the cron policies key on. All null/false with no runner
    // connected, which every caller treats as "unknown → don't block on it".
    deps.agentBridge.contextPct = (paneId) =>
      agentRunners.get(paneId)?.status?.context?.pct ?? null;
    deps.agentBridge.lastSendAt = (paneId) => {
      const conn = agentRunners.get(paneId);
      // The HUMAN send, not any relay: a cron's own fire must not count as
      // "the user is right here", or a 5-minute cron with quiet_mins set would
      // defer itself forever. 0 is the never-sent sentinel — report it as
      // "unknown", not as 1970.
      return conn && conn.lastHumanSendAt > 0 ? conn.lastHumanSendAt : null;
    };
    deps.agentBridge.slash = (paneId, cmd) => sendToRunner(paneId, { t: 'slash', cmd });
    deps.agentBridge.blocked = (paneId) => !!agentRunners.get(paneId)?.pendingQuestion;
  }

  // -------------------------------------------------------------------------
  // Dead-runner supervision. The runner is a node process typed into the
  // pane's shell; when it dies the shell prompt returns, the pty stays alive,
  // and ptyd sees nothing wrong — but the pane's chat face would say "agent
  // is reconnecting" forever. Sweep the runner-owned panes (startup_cmd is
  // the durable marker): no registered runner AND no agent-runner process in
  // the pty foreground ⇒ the process is dead. Respawn by bouncing the pane —
  // killPane + ensurePane retypes the startup_cmd, whose `--resume <sid>`
  // brings the same session back from disk. Bounded: a cooldown between
  // attempts (a booting runner takes seconds to register) and a give-up cap
  // so a crash-looping runner (broken build, bad model) converges to a
  // visible "agent exited" instead of an infinite kill/spawn loop. A runner
  // that registers (hello) AND then stays up for the probation window resets
  // its pane's record.
  //
  // Probation, not the bare hello, is what makes the cap bite. A runner whose
  // session can't start (`--resume` of a sid the harness no longer has) still
  // connects and says hello before it dies a second later — clearing the record
  // there re-armed the counter on every cycle, so a pane crash-looped on the
  // sweep interval forever, attempts stuck at 1. Recovery means STAYING alive.
  // The four rails (sweep/cooldown/cap/probation) live in respawn-policy.ts —
  // shared verbatim with the serve supervisor, so tuning one can't silently
  // diverge from the other. Only the liveness PROBE differs between them.
  //
  // A resume against a session id the harness can't find is not a transient
  // crash — retrying the same command is guaranteed to fail identically. The
  // sweep drops `--resume` once and brings the pane back as a fresh session in
  // the same cwd instead of burning the attempt budget on a certainty.
  const DEAD_SESSION_RE = /No conversation found with session ID/i;
  interface RespawnState {
    attempts: number;
    lastAt: number;
    gaveUp: boolean;
    /** Last fatal frame from this pane's runner (cleared once acted on). */
    fatal?: string | undefined;
    /** We already dropped a dead `--resume` from this pane's startup_cmd. */
    healed?: boolean;
  }
  const respawns = new Map<string, RespawnState>();
  // Pending "the runner survived probation" timers, keyed by pane.
  const probation = new Map<string, ReturnType<typeof setTimeout>>();
  const clearProbation = (paneId: string) => {
    const t = probation.get(paneId);
    if (t) {
      clearTimeout(t);
      probation.delete(paneId);
    }
  };
  const armProbation = (paneId: string) => {
    clearProbation(paneId);
    const t = setTimeout(() => {
      probation.delete(paneId);
      respawns.delete(paneId);
    }, RESPAWN_PROBATION_MS);
    t.unref?.();
    probation.set(paneId, t);
  };
  const agentExitedMessage = (paneId: string) =>
    `agent exited — automatic restarts failed; see ~/.muxpad/agent-logs/${paneId}.log, then rerun \`muxpad agent\` from the pane's terminal face`;
  // Single-flight: a slow ptyd must not stack overlapping sweeps.
  let sweepInFlight = false;
  const sweepDeadRunners = async () => {
    if (sweepInFlight) return;
    sweepInFlight = true;
    try {
      const agentPanes = panes.listAgentPanes();
      // Prune records of panes that are gone or no longer runner-owned.
      const liveIds = new Set(agentPanes.map((p) => p.id));
      for (const id of respawns.keys()) if (!liveIds.has(id)) respawns.delete(id);
      for (const pane of agentPanes) {
        if (agentRunners.get(pane.id)) continue;
        // A PENDING agent ('muxpad agent --pick') has no session/runner to
        // supervise — it idles waiting for the user to pick a harness. It never
        // registers, so the fg probe is its only guard; skip it outright rather
        // than rely on that string match (a flaky probe would wrongly respawn a
        // pane whose only "fault" is waiting to be picked).
        if (pane.startup_cmd === 'muxpad agent --pick') continue;
        // A just-created pane may not have typed its startup command yet —
        // the foreground probe would misread the bare shell as a dead
        // runner and bounce a healthy boot.
        if (Date.now() - pane.created_at < RESPAWN_STARTUP_GRACE_MS) continue;
        const st = respawns.get(pane.id) ?? { attempts: 0, lastAt: 0, gaveUp: false };
        if (st.gaveUp) continue;
        if (Date.now() - st.lastAt < RESPAWN_COOLDOWN_MS) continue;
        // Foreground probe: a live-but-disconnected runner (ws blip mid-
        // reconnect) still owns the pty foreground — leave it alone, it
        // re-registers on its own. Only a shell prompt (or a pane ptyd
        // doesn't even have) is a dead runner.
        //
        // A THROW IS NOT DEATH. `getForegroundCommand` only rejects when the
        // ptyd socket isn't OPEN (see PtydClient.call) — an unknown pane
        // RESOLVES with `cmd: null`. So a rejection means LIVENESS UNKNOWN,
        // and judging it "dead" would let a multi-minute ptyd outage burn
        // every agent pane's whole attempt budget, mark healthy panes dead
        // and — worse — permanently clear their durable send queues. Skip the
        // pane entirely: no attempt spent, no cooldown anchor moved, retried
        // on the next sweep once ptyd is back. Same distinction the serve
        // supervisor makes with `hasPane`.
        let fg: string | null = null;
        try {
          fg = await deps.ptyd.getForegroundCommand(pane.id);
        } catch {
          continue;
        }
        if (fg?.includes('agent-runner')) continue;
        // ── The runner really is gone. Only NOW may we change anything. ──
        //
        // Dead-session self-heal: the runner told us (fatal) that its resume
        // target is gone from the harness's store — a bridged session, a
        // pruned transcript, a sid that never got a message. Strip `--resume`
        // so the respawn lands a NEW session in the same cwd/backend/model,
        // and let it use the normal attempt budget from there. The old sid
        // stays in the agent session's lineage; nothing is deleted.
        //
        // This block sits BELOW the fg probe on purpose. Above it, a ptyd
        // outage — the case the probe's `continue` exists to survive — still
        // rewrote startup_cmd, threw the resume target away for good and
        // shouted a notice at every open chat client, all for a pane whose
        // liveness we had just decided we could not judge.
        const deadSid = st.fatal !== undefined && DEAD_SESSION_RE.test(st.fatal);
        if (deadSid && !st.healed) {
          const cmd = pane.startup_cmd ?? '';
          const fresh = cmd.replace(/\s--resume\s+[A-Za-z0-9._-]+/, '');
          if (fresh !== cmd) {
            // Clear the fatal only when we ACT on it. Clearing unconditionally
            // (as this used to) forgot the diagnosis on a command with no
            // `--resume` to strip, so a later respawn that did grow one would
            // never be healed.
            st.fatal = undefined;
            st.healed = true;
            st.attempts = 0;
            respawns.set(pane.id, st);
            panes.setStartupCmd(pane.id, fresh);
            emitPaneUpdated(pane.id);
            bcastToPane(pane.id, {
              t: 'notice',
              message:
                'previous session not found on disk — starting a fresh one in the same folder…',
            });
          }
        }
        st.lastAt = Date.now();
        st.attempts += 1;
        respawns.set(pane.id, st);
        if (st.attempts > RESPAWN_MAX_ATTEMPTS) {
          st.gaveUp = true;
          // The pane is DEAD, not idle. Surface it in the nav (a × in the
          // status rail) instead of leaving a corpse that merely looks quiet.
          deps.cache.setDead(pane.id, true);
          bcastToPane(pane.id, { t: 'error', message: agentExitedMessage(pane.id) });
          // The agent is dead for good — drop its orphaned queue so the pending
          // bubbles don't linger, and a much-later hand-restart (a fresh session)
          // doesn't suddenly flood them all in. New sends are already rejected.
          if (queue.clear(pane.id) > 0) broadcastQueue(pane.id);
          continue;
        }
        bcastToPane(pane.id, {
          t: 'notice',
          message: `agent process died — restarting (attempt ${st.attempts}/${RESPAWN_MAX_ATTEMPTS})…`,
        });
        try {
          try {
            await deps.ptyd.killPane(pane.id);
          } catch {
            // pane not in ptyd (reboot-orphaned) — ensurePane spawns it fresh
          }
          const workspaceId = tabs.getWorkspaceId(pane.tab_id);
          await deps.ptyd.ensurePane({
            id: pane.id,
            shell: pane.shell ?? process.env.SHELL ?? '/bin/zsh',
            // Re-read: the dead-session heal above may have just rewritten it,
            // and typing the stale `--resume` would reproduce the same fatal.
            startup_cmd: panes.getById(pane.id)?.startup_cmd ?? pane.startup_cmd,
            cwd: safeCwd(pane.cwd),
            env: pane.env,
            tab_id: pane.tab_id,
            ...(workspaceId !== undefined ? { workspace_id: workspaceId } : {}),
          });
        } catch {
          // ptyd unreachable — the attempt is spent; the next sweep retries
          // after the cooldown.
        }
      }
    } finally {
      sweepInFlight = false;
    }
  };
  const respawnSweep = setInterval(() => void sweepDeadRunners(), RESPAWN_SWEEP_MS);

  /**
   * Unlist subagents that stopped making progress. See {@link reapStalledEntries}
   * for why the server needs this even though the runner ends its own agents:
   * runners are version-skewed by design and old ones never send a terminal
   * frame, so without this a leaked entry outlives every process involved.
   */
  const sweepStalledSubagents = (): void => {
    const now = Date.now();
    for (const [paneId, conn] of agentRunners) {
      const reaped = reapStalledEntries(
        conn.subagents,
        conn.subagentChangedAt,
        now,
        conn.subagentReaped,
      );
      if (reaped.length === 0) continue;
      // Must look like an end to every client, or the rows linger until the
      // next 10s session poll happens to notice (same contract as eviction).
      for (const id of reaped)
        bcastToPane(paneId, { t: 'subagent', progress: { toolUseId: id, steps: 0, done: true } });
      syncSubagentCount(paneId);
      console.warn(
        `[ws] pane ${paneId}: retired ${reaped.length} subagent row(s) with no progress in ${Math.round(SUBAGENT_STALL_MS / 60_000)}m. Either a runner end-path leaked (stale runner build?) or the work really is over.`,
      );
    }
  };
  const stallSweep = setInterval(sweepStalledSubagents, STALL_SWEEP_MS);
  stallSweep.unref?.();

  // -------------------------------------------------------------------------
  // Server-owned send queue. A user message that can't run right now (agent
  // mid-turn, or its runner between connections) is persisted to `queue` and
  // fed to the runner one turn at a time — on turn-done and on runner
  // (re)connect — so a batch of 20 keeps draining into the agent even after
  // every browser tab is closed. Chat clients render the pending bubbles from
  // this queue (broadcastQueue), so the view survives reloads and follows the
  // user across devices.
  const broadcastQueue = (paneId: string) => {
    bcastToPane(paneId, {
      t: 'queue',
      items: queue.list(paneId).map((r) => ({ id: r.id, text: r.text })),
    });
  };
  // Relay the oldest queued message to the runner if it's idle and connected.
  // Runs one message per call; the next drains when this message's turn-done
  // arrives (or when the runner reconnects), keeping the batch strictly serial
  // and each pending bubble visible until its own turn actually starts.
  const drainQueue = (paneId: string) => {
    const conn = agentRunners.get(paneId);
    if (!conn || conn.turnActive) return; // no runner, or busy → wait
    const next = queue.peek(paneId);
    if (!next) return;
    if (sendToRunner(paneId, { t: 'send', text: next.text })) {
      // Claim busy immediately: the runner's turn-start reaffirms it, but a
      // second drain must not fire before it echoes back.
      //
      // D14: this used to set turnActive WITHOUT touching the cache or the bus,
      // so for a whole round trip `turn_active` read true while `busy` read
      // false and no event fired at all. Mirror the optimism into both.
      conn.turnActive = true;
      conn.lastSendAt = Date.now();
      if (isHumanMessage(next.text)) conn.lastHumanSendAt = conn.lastSendAt;
      deps.cache.setAgentBusy(paneId, true);
      emitOptimisticTurnStart(paneId);
      queue.remove(next.id, paneId);
      broadcastQueue(paneId);
    }
    // Relay failed (socket mid-close) → leave it queued; hello/turn-done retry.
  };
  // Submit a user message. Idle + connected + nothing already waiting → start
  // the turn now. Otherwise persist to the queue (the drain loop feeds it when
  // the agent frees up / the runner returns). Only runner-owned agent panes
  // have a drainer; a read-only TUI-driven pane is rejected. Returns what
  // happened so the caller can ack the sending socket.
  const submitSend = (
    paneId: string,
    text: string,
  ): { status: 'sent' | 'queued' | 'rejected'; id?: string; reason?: string } => {
    const t = text.trim();
    if (!t) return { status: 'rejected', reason: 'empty message' };
    const pane = panes.getById(paneId);
    if (!pane) return { status: 'rejected', reason: 'pane not found' };
    // Living sidebar: the user addressing this pane is a discrete, deliberate
    // act — forced, like turn-done. Recorded before the accept/queue/reject
    // branch on purpose: a message the user MEANT to send is activity even if
    // the agent turns out to be dead.
    activity.touchTab(pane.tab_id, { force: true });
    const conn = agentRunners.get(paneId);
    // Fast path: agent free and nothing queued ahead of it → run immediately.
    if (conn && !conn.turnActive && queue.count(paneId) === 0) {
      if (sendToRunner(paneId, { t: 'send', text: t })) {
        conn.turnActive = true; // optimistic; runner's turn-start reaffirms
        conn.lastSendAt = Date.now();
        if (isHumanMessage(t)) conn.lastHumanSendAt = conn.lastSendAt;
        // Same D14 mirroring as drainQueue: turn state, pane status and the
        // bus must not disagree for the duration of the round trip.
        deps.cache.setAgentBusy(paneId, true);
        emitOptimisticTurnStart(paneId);
        return { status: 'sent' };
      }
      // Relay lost a race with the socket close → fall through and queue it.
    }
    const runnerOwned = pane.startup_cmd?.startsWith('muxpad agent') ?? false;
    if (!runnerOwned) return { status: 'rejected', reason: 'pane has no agent runner' };
    // A runner whose automatic restarts were exhausted will never drain — don't
    // let messages pile into a dead agent; surface the same guidance as a send.
    if (respawns.get(paneId)?.gaveUp)
      return { status: 'rejected', reason: agentExitedMessage(paneId) };
    // Cap the backlog so a stuck turn + a spammy client (or the HTTP send path)
    // can't grow the queue without bound.
    if (queue.count(paneId) >= MAX_QUEUED_SENDS)
      return {
        status: 'rejected',
        reason: `too many queued messages (max ${MAX_QUEUED_SENDS}) — wait for some to run`,
      };
    const row = queue.enqueue(paneId, t);
    broadcastQueue(paneId);
    // Nudge delivery: if the runner is idle we lost a relay race (drain now);
    // if it's absent, a sweep is the best "is it back yet?" probe.
    if (conn) drainQueue(paneId);
    else void sweepDeadRunners();
    return { status: 'queued', id: row.id };
  };

  // Server-side liveness detection. A WebSocket severed abruptly (browser
  // hard-reload, crashed tab, network blip) does NOT fire 'close' until the
  // OS TCP timeout — minutes later. Until then the dead client stays on
  // ptyd's side, and a pane.kind flip can't clean up its bucket until the
  // 'close' eventually fires.
  //
  // Standard ws fix: ping every client on an interval; browsers answer
  // protocol-level pings with a pong automatically (the page never sees it).
  // Any client that missed the previous round gets terminated, which fires
  // 'close' → proxyAttach teardown.
  //
  // Note: ptyd runs its OWN heartbeat against its `/control` and `/pty/:id`
  // sockets. This heartbeat is independent — it's the main server detecting
  // browser-side ghosts on the WSes IT terminates.
  const HEARTBEAT_MS = deps.heartbeatMs ?? 15_000;
  const heartbeat = setInterval(() => {
    for (const client of wss.clients) {
      const live = client as WebSocket & { isAlive?: boolean };
      if (live.isAlive === false) {
        live.terminate();
        continue;
      }
      live.isAlive = false;
      try {
        live.ping();
      } catch {
        // socket already closing; the next sweep (or 'close') cleans up.
      }
    }
  }, HEARTBEAT_MS);

  deps.http.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://x');
    // CSRF for WebSockets. FIRST, above the path dispatch, so it covers every
    // arm below — /ws/pane/:id, /ws/agent-runner/:paneId, /ws/chat/:paneId,
    // /ws/events — and any arm added later without anyone remembering this.
    //
    // Why it is needed at all: muxpad has no auth (reachability is
    // authorization, bounded by the tailnet), the HTTP guard in same-origin.ts
    // exempts GET, and a WS handshake IS a GET that never reaches Hono anyway.
    // So until this, any page the user visited while their browser sat on the
    // tailnet could open /ws/pane/<id> and write OP_INPUT frames straight into
    // a live shell. Browsers apply no CORS to WebSockets; they do send Origin.
    // Exactly the same predicate as the HTTP guard, so there is one policy.
    //
    // MISSING Origin STAYS ALLOWED, same as HTTP, and here is the check of
    // that reasoning for this path specifically — every non-browser WS client
    // in the repo, traced:
    //
    //   - the agent runner (agent-runner/index.ts) opens
    //     `new WebSocket(MUXPAD_API_URL→ws + /ws/agent-runner/:paneId)` with
    //     the `ws` library and no options, which sends NO Origin. It also
    //     reconnects forever across every `muxpad restart`, so refusing it
    //     would not fail loudly — it would spin.
    //   - the `muxpad` CLI never opens a WebSocket at all; `muxpad events`
    //     curls the SSE mirror at /api/events (guarded as a GET, i.e. not).
    //   - every server-side test client is `ws` on 127.0.0.1: no Origin, and
    //     loopback besides.
    //
    // and no browser reaches this branch: RFC 6455 §4.1 makes Origin
    // mandatory for browser clients, and Chrome/Firefox/Safari all send it on
    // every `new WebSocket()`. So "no Origin" means "not a page", which is the
    // whole population this guard is aimed at. A non-browser attacker who can
    // already reach port 7777 on the tailnet is outside the threat model by
    // construction — they could equally curl the API.
    // Node types unknown headers as string | string[]; a repeated header
    // arrives as an array. Take the first — a browser sends exactly one.
    const rawSecFetchSite = req.headers['sec-fetch-site'];
    const verdict = checkOrigin(
      {
        origin: req.headers.origin,
        host: req.headers.host,
        secFetchSite: Array.isArray(rawSecFetchSite) ? rawSecFetchSite[0] : rawSecFetchSite,
      },
      allowedOrigins,
    );
    if (!verdict.ok) {
      logRefusal(req.headers.origin ?? '(no origin)', `${verdict.why} on ${url.pathname}`);
      refuseUpgrade(socket, verdict.why);
      return;
    }
    // App-level event stream. One socket per browser; receives JSON-encoded
    // MuxpadEvent frames for structural state changes (panes/tabs/workspaces).
    // PTY I/O still goes through /ws/pane/:id below.
    if (url.pathname === '/ws/events') {
      wss.handleUpgrade(req, socket, head, (ws) => {
        // Heartbeat participation: the sweep above pings every wss client.
        // Mark this socket alive on attach + pong so it doesn't get
        // terminated as a ghost on the next round.
        const live = ws as WebSocket & { isAlive?: boolean };
        live.isAlive = true;
        ws.on('pong', () => {
          live.isAlive = true;
        });
        const unsub = deps.events.subscribe((e) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(e));
        });
        ws.on('close', unsub);
        ws.on('error', unsub);
      });
      return;
    }
    // Agent runner link: a `muxpad agent` process (living inside the pane's
    // pty) hosting a persistent Claude session. On hello it becomes the
    // pane's single writer, the pane's shared face flips to chat, and the
    // pane's startup_cmd is rewritten to `muxpad agent --resume <sid>` so a
    // ptyd restart/reboot self-heals into the same session. Turn lifecycle
    // frames fan out to the pane's chat clients; sends/stops relay back.
    const runnerMatch = url.pathname.match(/^\/ws\/agent-runner\/([^/]+)$/);
    if (runnerMatch) {
      const paneId = runnerMatch[1] as string;
      if (!panes.getById(paneId)) {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        const live = ws as WebSocket & { isAlive?: boolean };
        live.isAlive = true;
        ws.on('pong', () => {
          live.isAlive = true;
        });
        // Newest runner wins: a respawn (pane reload, crashed process) may
        // connect before the old socket's close fires. Close the old one
        // with 4001 — a DISPLACED runner that is still a live process (an
        // orphaned pty duplicate) must exit rather than reconnect, or the
        // two processes trade the registration forever, strobing the chat's
        // status/busy on every steal. A dead peer never completes the close
        // handshake, so force-terminate after a grace; the teardown handler
        // guards on registration, so late close events from it are inert.
        const prev = agentRunners.get(paneId);
        if (prev) {
          agentRunners.delete(paneId);
          // A displaced runner's TURN dies with it, and this is the only place
          // that can say so. Teardown — which closes the turn out on a plain
          // disconnect — refuses to act for a socket that is no longer the
          // registered one, so a runner replaced MID-TURN used to emit `start`
          // and never `done`: `muxpad agent wait` and the Archiver's realtime
          // enqueue both block to timeout on a turn that ended when the process
          // was told to exit. Same shape as teardown's, with this conn's own
          // sid/backend (the successor's are not known yet, and would be a lie).
          if (prev.turnActive) {
            prev.turnActive = false;
            deps.cache.setAgentBusy(paneId, false);
            bcastToPane(paneId, {
              t: 'turn-done',
              ok: false,
              error: 'agent replaced by a newer runner',
            });
            deps.events.emit({
              type: 'agent_turn',
              pane_id: paneId,
              phase: 'done',
              sid: prev.sid,
              backend: prev.backend,
            });
          }
          // The dead runner's half-streamed sentence is not the successor's.
          // Teardown drops it on every other exit path; without this a chat
          // socket that (re)connects while the NEW runner is mid-turn renders
          // the corpse's partial text as the live stream.
          streamBufs.delete(paneId);
          const stale = prev.ws;
          try {
            stale.close(CLOSE_RUNNER_DISPLACED, 'replaced by a newer runner for this pane');
          } catch {
            // already dead
          }
          setTimeout(() => {
            try {
              stale.terminate();
            } catch {
              // already dead
            }
          }, 5_000).unref?.();
        }
        const conn: AgentRunnerConn = {
          ws,
          sid: null,
          backend: 'claude',
          turnActive: false,
          pendingQuestion: null,
          subagents: new Map(),
          subagentChangedAt: new Map(),
          subagentReaped: new Map(),
          lastOverflowWarnAt: 0,
          status: null,
          lastSendAt: 0,
          lastHumanSendAt: 0,
        };
        agentRunners.set(paneId, conn);
        // THIS runner owns the pane's per-connection state from this instant,
        // and it starts empty. Anything the previous connection left in the
        // CACHE has to go with it — the displaced conn's teardown is a no-op by
        // design (see the guard in teardown), so this is the only place that
        // can retire it. Both fields are rebuilt within a beat by the runner's
        // own `onConnected` re-announce (roster + any question it is really
        // holding), so a plain ws blip costs a blink, not a lost subagent. What
        // it buys is that a REPLACED runner can no longer bequeath a phantom
        // `agents: N` / stuck `working` (or a stuck `blocked`) to its successor.
        syncSubagentCount(paneId);
        deps.cache.setBlocked(paneId, false);
        const bcast = (obj: unknown) => bcastToPane(paneId, obj);
        const emitChange = () =>
          deps.events.emit({ type: 'agent_session.updated', pane_id: paneId });
        // Turn lifecycle on the GLOBAL bus (spec A4): a supervisor watching N
        // workers holds one /ws/events (or /api/events SSE) subscription
        // instead of N chat sockets. Ids only — content stays off the bus.
        const emitTurn = (phase: 'start' | 'done' | 'fatal') =>
          deps.events.emit({
            type: 'agent_turn',
            pane_id: paneId,
            phase,
            sid: conn.sid,
            backend: conn.backend,
          });
        ws.on('message', (data) => {
          // A displaced socket can still deliver in-flight frames during the
          // close handshake — a stale runner's state must not leak into the
          // pane (busy flips, status strobing) once a successor registered.
          if (agentRunners.get(paneId) !== conn) return;
          const frame = parseFrame<RunnerFrame>(data);
          if (!frame) return;
          if (frame.t === 'hello') {
            // The sid ends up in a startup_cmd that PaneRuntime TYPES INTO A
            // SHELL on respawn — constrain its charset (same rule as the
            // HTTP register/hook routes) so a crafted hello can't smuggle
            // shell syntax into the pane. cwd only lands in SQLite, but must
            // at least be a string.
            if (
              typeof frame.sid !== 'string' ||
              !/^[A-Za-z0-9._-]{1,128}$/.test(frame.sid) ||
              typeof frame.cwd !== 'string'
            ) {
              return;
            }
            // ACCEPTED (re)hello = new runner process or new session id — the
            // cached status may describe the OLD session; the runner re-sends
            // its current status right after hello. (After validation: a
            // rejected hello must not wipe a status nothing will re-send.)
            conn.status = null;
            conn.sid = frame.sid;
            conn.turnActive = frame.turnActive === true;
            // Which backend drives this pane (claude|codex|cursor). Absent =
            // legacy runner = claude. Validated against the allowlist so it's
            // safe both as a DB label AND baked into the self-heal shell cmd.
            const backendId = isBackendId(frame.backend) ? frame.backend : 'claude';
            conn.backend = backendId;
            // Registering is a claim of recovery, not proof of it: a runner
            // that can't resume its session says hello and dies seconds later.
            // Clear the respawn record only after it has held the pane for the
            // probation window (the close handler cancels the timer). A pane
            // that had already given up is the exception — a hand-restart is a
            // deliberate act by the user, so re-arm supervision immediately.
            if (respawns.get(paneId)?.gaveUp) respawns.delete(paneId);
            else armProbation(paneId);
            agents.attachRunner({
              pane_id: paneId,
              cwd: frame.cwd,
              session_id: frame.sid,
              assistant: backendId,
            });
            if (conn.turnActive) agents.setStatus(paneId, 'running');
            // This pane's "working" now comes from the RUNNER REGISTRY, not
            // from pty output. Registering flips that gate (see
            // PtydCache.getStatus) — otherwise the runner's own terminal log
            // keeps the pane lit while it idles, and a silently-thinking agent
            // reads idle because it prints nothing.
            deps.cache.setRunnerOwned(paneId, true);
            deps.cache.setAgentBusy(paneId, conn.turnActive);
            // A hand-restart is a fresh claim on the pane: it is no longer dead.
            deps.cache.setDead(paneId, false);
            // A NEW runner attaching (fresh `muxpad agent`, or a resume under
            // a different sid) is the "this pane is chat now" signal — flip
            // the persisted face on every device. A RECONNECT of the same
            // session (server restart, ws blip) must NOT: the user may have
            // deliberately switched to the terminal face since.
            // Preserve a launch-time --model pin across the rewrite. The
            // value is read back from the startup_cmd the server itself wrote
            // (tabs route or a previous rewrite) — never from the ws frame —
            // so no new injection surface; the single-quoted form is the
            // tabs-route shape, the bare form a hand-typed `muxpad agent`.
            const prevPane = panes.getById(paneId);
            const prevCmd = prevPane?.startup_cmd ?? '';
            const modelMatch = prevCmd.match(/--model ('[^']*'|[^\s']+)/);
            const modelPart = modelMatch ? ` --model ${modelMatch[1]}` : '';
            // Preserve the backend selector across the rewrite. Claude stays
            // implicit (bare `muxpad agent …`) so existing panes' startup_cmd
            // never churns; codex/cursor get an explicit, allowlist-safe flag.
            const backendPart = backendId === 'claude' ? '' : ` --backend ${backendId}`;
            // Agent mode, taken from the PANE ROW (the source of truth), not
            // parsed back out of the previous command — a PATCH may have just
            // changed it. 'deep' stays implicit for the same
            // never-churn-existing-panes reason as claude above.
            const modePart = prevPane?.mode === 'do' ? ' --mode do' : '';
            const selfHealCmd = `muxpad agent${backendPart}${modePart}${modelPart} --resume ${frame.sid}`;
            const isReconnect = prevCmd === selfHealCmd;
            // Self-heal: the pane's startup command now resumes THIS session,
            // so the pane survives ptyd restarts and reboots.
            panes.setStartupCmd(paneId, selfHealCmd);
            if (!isReconnect) {
              panes.setFace(paneId, 'chat');
              emitPaneUpdated(paneId);
            }
            // A mid-turn reconnect: already-open chat clients still show an
            // idle composer (their session frame doesn't change shape), so
            // re-broadcast the running state — idempotent client-side.
            // The bus edge matters as much as the chat one: the server's
            // per-connection state was rebuilt from nothing, so to every bus
            // subscriber (a supervisor, `muxpad agent wait`, the Archiver)
            // this IS the start of the turn they can observe. Without it a
            // waiter that attached across the reconnect blocks to timeout on
            // a turn that will only ever emit `done`.
            if (conn.turnActive) {
              bcast({ t: 'turn-start' });
              emitTurn('start');
            }
            emitChange();
            // Converge the runner on the DB's mode. A runner that booted from
            // a startup_cmd predating a mode change (or a hand-typed `muxpad
            // agent`) would otherwise run the wrong contract until its next
            // respawn. Equal-mode frames are a no-op backend-side, so the
            // common case costs nothing; a genuine mismatch surfaces as the
            // one-time <muxpad-mode> note on the next message.
            if (prevPane) sendToRunner(paneId, { t: 'mode', mode: prevPane.mode });
            // Runner is back — resume feeding any queue that was waiting for it
            // (server restart, ws blip, crash+respawn). No-op if it reconnected
            // mid-turn (turnActive) or the queue is empty.
            drainQueue(paneId);
          } else if (frame.t === 'turn-start') {
            conn.turnActive = true;
            streamBufs.set(paneId, '');
            agents.setStatus(paneId, 'running');
            // Busy propagates via the cache's own paneChange → pane.updated
            // event; no agent_session.updated here — emitting per turn made
            // every open view refetch the session twice per turn.
            deps.cache.setAgentBusy(paneId, true);
            bcast({ t: 'turn-start' });
            emitTurn('start');
          } else if (frame.t === 'stream') {
            if (typeof frame.delta !== 'string') return;
            appendStreamBuf(paneId, frame.delta);
            bcast({ t: 'stream', delta: frame.delta });
          } else if (frame.t === 'turn-done') {
            conn.turnActive = false;
            conn.pendingQuestion = null;
            // No question outlives its turn (the runner resolves them all on
            // interrupt/result), so the blocked state can't either.
            deps.cache.setBlocked(paneId, false);
            // conn.subagents is deliberately NOT cleared here. A
            // run_in_background Task routinely outlives the turn that launched
            // it; wiping the roster at turn-done is exactly what made those
            // subagents vanish from the sidebar and the in-pane list the moment
            // the turn ended — with no way to rebuild, since the roster rode
            // only the (now-empty) session snapshot. Entries leave on their
            // runner's `done` frame or on teardown, and nowhere else.
            streamBufs.delete(paneId);
            agents.setStatus(paneId, 'idle');
            deps.cache.setAgentBusy(paneId, false);
            bcast({
              t: 'turn-done',
              ok: frame.ok !== false,
              ...(frame.error ? { error: frame.error } : {}),
            });
            // `done` regardless of ok — the turn ENDED (an errored turn is
            // still a finished wait); a dying runner reports `fatal` below.
            emitTurn('done');
            // Living sidebar: a finished turn is the single most meaningful
            // "something happened here" signal, so it bypasses the throttle.
            activity.touchPane(paneId, { force: true });
            // Chat-native agents never ring BEL, so the attention-push path
            // can't see them — notify turn completion here instead. Gated on
            // interactivity: a turn answered within the suppress window of
            // the user's own chat send is a conversation they're actively
            // driving (every reply would buzz their phone mid-chat).
            // Long-running turns (the user walked away) and autonomous
            // wakeup/cron turns (no recent send) do push.
            if (Date.now() - conn.lastHumanSendAt > INTERACTIVE_PUSH_SUPPRESS_MS) {
              // Prefer a snippet of what the agent actually said over the
              // generic "finished its turn".
              deps.notifyPane?.(
                paneId,
                frame.ok !== false ? frame.summary?.trim() || 'finished its turn' : 'turn failed',
              );
              // Bold the pane "done, unreviewed" in the nav until it's viewed.
              // Same interactivity gate as the push: a turn you're actively
              // driving isn't "unread" (you're watching it). If you're looking
              // but not typing, the chat client clears this on turn-done.
              panes.setUnread(paneId, true);
              emitPaneUpdated(paneId);
            }
            // Turn finished → feed the next queued message. This is the loop
            // that drains a batch with no browser open: turn-done → drain →
            // turn-start → … until the queue empties.
            drainQueue(paneId);
          } else if (frame.t === 'question') {
            if (typeof frame.qid !== 'string' || !Array.isArray(frame.questions)) return;
            conn.pendingQuestion = { qid: frame.qid, questions: frame.questions };
            // D5: "needs input" had NO representation in the nav. The question
            // reached chat sockets and a push and touched nothing else, so a
            // chat parked on ask_user read as plain idle in the sidebar — the
            // highest-value missing state. It is now the top-precedence one.
            // No emitPaneUpdated here: setBlocked fans a `paneChange` on the
            // status edge, and the main entry already forwards that as a
            // DECORATED pane.updated. Emitting again would double every
            // blocked edge on the bus — invisible to the web client (which
            // dedups) but wrong for anything counting edges.
            deps.cache.setBlocked(paneId, true);
            bcast({ t: 'question', qid: frame.qid, questions: frame.questions });
            const q = frame.questions[0]?.question;
            deps.notifyPane?.(
              paneId,
              q ? `asks: ${q.length > 80 ? `${q.slice(0, 80)}…` : q}` : 'has a question',
            );
          } else if (frame.t === 'question-done') {
            if (conn.pendingQuestion?.qid === frame.qid) conn.pendingQuestion = null;
            if (!conn.pendingQuestion) deps.cache.setBlocked(paneId, false);
            bcast({ t: 'question-done', qid: frame.qid });
          } else if (frame.t === 'subagent') {
            if (!frame.progress || typeof frame.progress.toolUseId !== 'string') return;
            if (frame.progress.done) {
              conn.subagents.delete(frame.progress.toolUseId);
              conn.subagentChangedAt.delete(frame.progress.toolUseId);
              conn.subagentReaped.delete(frame.progress.toolUseId);
            } else {
              const id = frame.progress.toolUseId;
              const tomb = conn.subagentReaped.get(id);
              if (tomb !== undefined) {
                // We retired this row for stalling. The runner does not know
                // that and keeps re-announcing it every 5s. Ignore the echo —
                // otherwise the reap never sticks and the count flaps forever.
                // Real progress lifts the tombstone and the row comes back.
                if (!isMaterialProgress(tomb, frame.progress)) return;
                conn.subagentReaped.delete(id);
              }
              // Stamp only on real news. A keepalive re-announce is byte-identical
              // to what we hold, and must NOT restart the stall clock — otherwise
              // a ghost keeps itself alive with the runner's own heartbeat.
              if (isMaterialProgress(conn.subagents.get(id), frame.progress))
                conn.subagentChangedAt.set(id, Date.now());
              conn.subagents.set(id, frame.progress);
            }
            // Independent backstop on the SERVER's copy. The runner caps its own
            // roster, but runners are version-skewed by design — they only pick
            // up new code when their pane respawns, and a pre-durable runner
            // never sends a `done` frame at all, so this map grew for the life
            // of the process (live pane, 2026-08: 19 entries, 7 real). The cap
            // is a bound, never a policy: it drops the OLDEST insertion, so a
            // leak can no longer render an absurd number in the status rail.
            const evicted = evictOverflowEntries(conn.subagents);
            for (const id of evicted) conn.subagentChangedAt.delete(id);
            // An eviction must LOOK like an end to every client, or the rows
            // linger until the next 10s session poll happens to notice.
            for (const id of evicted)
              bcast({ t: 'subagent', progress: { toolUseId: id, steps: 0, done: true } });
            // Loud, but once a minute per pane: a leaking runner sends one of
            // these per frame, and the log must stay readable.
            if (evicted.length > 0 && Date.now() - conn.lastOverflowWarnAt > OVERFLOW_WARN_MS) {
              conn.lastOverflowWarnAt = Date.now();
              console.warn(
                `[ws] pane ${paneId}: subagent roster over ${MAX_PANE_SUBAGENTS} — evicting the oldest entries. A runner end-path is leaking (stale runner build?).`,
              );
            }
            // The roster is a status SOURCE, not a decaying hint: a non-empty
            // roster means "work is running here" whether or not a turn is.
            // setSubagentCount is edge-triggered on the COUNT, so the runner's
            // 5s keepalive (which re-sends the same ids) fans no events.
            syncSubagentCount(paneId);
            bcast({ t: 'subagent', progress: frame.progress });
          } else if (frame.t === 'status') {
            // Validate off the wire — version-skewed runners are NORMAL
            // (they only pick up new code when their pane respawns), and an
            // unvalidated frame cached here would be re-delivered in every
            // hello and crash clients at render. Merge rather than replace:
            // the models list rides only fetch frames, but reconnect hellos
            // must still carry the last known list.
            const clean = sanitizeAgentStatus(frame);
            if (!clean) return;
            // Remember this backend's model list so the LAUNCH picker (which
            // runs before any session exists) can offer real models instead of
            // only "Default". See agent-model-catalog.ts.
            recordModelCatalog(deps.db, conn.backend, clean.models);
            const merged = {
              t: 'status' as const,
              ...clean,
              ...(clean.models ? {} : conn.status?.models ? { models: conn.status.models } : {}),
            };
            conn.status = merged;
            bcast(merged);
          } else if (frame.t === 'title') {
            // Runner-generated conversation title (SDK sessions get no
            // ai-title transcript records) — same rename policy as the
            // transcript-tail path: user-given names always win.
            if (typeof frame.title === 'string') applyAiTitle(paneId, frame.title);
          } else if (frame.t === 'fatal') {
            // A fatal means this runner is on its way out — it never survives
            // probation, so cancel the pending "recovered" timer and hand the
            // reason to the sweep, which decides between a plain retry and the
            // dead-session heal.
            clearProbation(paneId);
            const st = respawns.get(paneId) ?? { attempts: 0, lastAt: 0, gaveUp: false };
            st.fatal = typeof frame.error === 'string' ? frame.error : '';
            respawns.set(paneId, st);
            bcast({ t: 'error', message: `agent exited: ${frame.error}` });
            emitTurn('fatal');
          }
        });
        const teardown = () => {
          // Only tear down if this socket is still the registered runner —
          // a replaced (old) socket must not detach its successor.
          if (agentRunners.get(paneId) !== conn) return;
          // It didn't hold the pane for the probation window — leave the
          // respawn record standing so the attempt budget keeps counting.
          clearProbation(paneId);
          agentRunners.delete(paneId);
          agents.detachRunner(paneId);
          deps.cache.setRunnerOwned(paneId, false);
          deps.cache.setAgentBusy(paneId, false);
          deps.cache.setBlocked(paneId, false);
          // The runner's death is the ONE thing besides a finish notice that
          // retires roster entries: its subagents die with the process, and
          // nothing else will ever report them done. (A reconnecting runner
          // re-announces its live roster in onConnected, so a ws blip costs at
          // most a blink, not a permanently lost subagent.)
          conn.subagents.clear();
          conn.subagentChangedAt.clear();
          conn.subagentReaped.clear();
          // Registry-derived, and this conn has just left the registry — so
          // this is a zero, by the same rule as everywhere else.
          syncSubagentCount(paneId);
          streamBufs.delete(paneId);
          if (conn.turnActive) {
            conn.turnActive = false;
            bcast({ t: 'turn-done', ok: false, error: 'agent disconnected' });
            // Balance the pair on the GLOBAL bus too. A SIGKILLed runner used
            // to emit `start` and never `done`, so `muxpad agent wait` blocked
            // to timeout and the Archiver missed its realtime enqueue.
            emitTurn('done');
          }
          emitChange();
        };
        ws.on('close', teardown);
        ws.on('error', teardown);
      });
      return;
    }
    // Chat view of an agent session: replay the tracked session's transcript
    // as normalized chat events, then stream live appends. Reading works even
    // while the TUI is the live writer (we only tail the JSONL, never the
    // terminal). Driving (composer → headless turn) is gated on single-writer:
    // see the message handler below.
    const chatMatch = url.pathname.match(/^\/ws\/chat\/([^/]+)$/);
    if (chatMatch) {
      const chatPaneId = chatMatch[1] as string;
      if (!panes.getById(chatPaneId)) {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        const live = ws as WebSocket & { isAlive?: boolean };
        live.isAlive = true;
        ws.on('pong', () => {
          live.isAlive = true;
        });
        const send = (obj: unknown) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
        };
        // Register for pane-wide broadcasts (turn lifecycle frames) and tell
        // the client whether a turn is ALREADY in flight — a socket that
        // reconnected mid-turn must restore its working/Stop state instead of
        // stranding the composer as idle.
        let clients = chatClients.get(chatPaneId);
        if (!clients) {
          clients = new Set();
          chatClients.set(chatPaneId, clients);
        }
        clients.add(send);
        const unregister = () => {
          clients.delete(send);
          if (clients.size === 0) chatClients.delete(chatPaneId);
        };
        ws.on('close', unregister);
        ws.on('error', unregister);
        const bcast = (obj: unknown) => bcastToPane(chatPaneId, obj);
        // Session + tail lifecycle. The session row (and its current_sid) can
        // change AFTER this socket connects: `muxpad claude` launches later, a
        // SessionStart hook lands late, or a resume/compact/fork mints a new
        // id mid-turn. A tail bound once at connect goes silently stale in all
        // of those — the classic "I send messages and nothing comes back". So
        // re-sync on every agent_session.updated event for this pane (all the
        // store mutation points emit it), with a slow poll as the belt-and-
        // braces fallback: rebind the tail whenever the sid changes and push a
        // fresh `session` frame whenever the row's shape changes.
        let tail: TranscriptTail | null = null;
        let tailSid: string | null = null;
        let lastHello = '';
        // Mode last delivered to this socket — the gate for the pane.updated
        // subscription below.
        let lastSentMode: 'do' | 'deep' = 'deep';
        // "Has anything been said here?" — shipped on the session frame so the
        // empty-state UI never has to GUESS from `events.length`, which is 0
        // for a beat on every reconnect while history replays asynchronously.
        // That guess made the "open instead" offer flash over real
        // conversations. Using the SAME predicate the conversion routes
        // enforce also means the offer and the server's refusal can never
        // disagree.
        //
        // Cached per sid and latched: messages don't un-say themselves, so
        // once it's true we stop re-reading the transcript. While it's false
        // the check short-circuits cheaply (no session row, or no transcript
        // file yet), so a quiet chat costs nothing on the 10s poll either.
        let msgProbeSid: string | null = null;
        let msgProbeResult = false;
        const paneHasMessages = (sid: string | null): boolean => {
          if (!sid) return false;
          if (msgProbeSid === sid && msgProbeResult) return true;
          if (msgProbeSid !== sid) {
            msgProbeSid = sid;
            msgProbeResult = false;
          }
          msgProbeResult = agentPaneHasMessages(deps.db, chatPaneId);
          return msgProbeResult;
        };
        const syncSession = (first: boolean) => {
          const session = agents.getByPane(chatPaneId);
          // The pane's agent mode rides the session frame so every open chat
          // view learns about a switch. There is deliberately NO chat-header
          // control for it (a claim this comment used to make): mode is chosen
          // at pane creation, and switches come from the CLI / automation via
          // PATCH /api/panes/:id {mode}. That endpoint stays, and so does this
          // relay — a CLI-driven switch must live-update every device rather
          // than wait for a respawn. The 10s poll below re-reads the row and
          // the hello signature includes `mode`, so a change re-pushes.
          const paneMode = panes.getById(chatPaneId)?.mode ?? 'deep';
          const hasMessages = paneHasMessages(session?.current_sid ?? null);
          const hello = JSON.stringify({
            sid: session?.current_sid ?? null,
            writer: session?.writer ?? null,
            view: session?.view_mode ?? null,
            mode: paneMode,
            hasMessages,
            // Re-send when the working dir changes (folder switch → respawn →
            // re-hello) so the chat header's folder chip updates.
            cwd: deps.cache.getCwd(chatPaneId) ?? session?.cwd ?? null,
            // MEMBERSHIP fingerprint of the durable subagent roster. Without it
            // the 10s poll below could never push a later snapshot: a socket
            // that connected before a background subagent launched would keep
            // matching its old hello forever, so only a brand-new socket ever
            // learned about the roster — and it used to be empty by then.
            // Ids only, sorted: progress churn (steps/lastTool) and the
            // runner's keepalive must NOT re-push the whole session frame.
            subagents: [...(agentRunners.get(chatPaneId)?.subagents.keys() ?? [])].sort().join(','),
          });
          if (first || hello !== lastHello) {
            lastHello = hello;
            lastSentMode = paneMode;
            const runner = agentRunners.get(chatPaneId);
            const turnRunning = runner?.turnActive === true;
            const streamText = streamBufs.get(chatPaneId);
            const cwd = deps.cache.getCwd(chatPaneId) ?? session?.cwd ?? null;
            send({
              t: 'session',
              session,
              mode: paneMode,
              hasMessages,
              turnRunning,
              // Server-owned pending queue so a (re)connecting or reloaded
              // client renders the same bubbles — the queue is authoritative
              // state, not this socket's local memory.
              queue: queue.list(chatPaneId).map((r) => ({ id: r.id, text: r.text })),
              ...(cwd ? { cwd, hasProject: hasProjectContext(cwd) } : {}),
              ...(turnRunning && streamText ? { streamText } : {}),
              // Mid-turn (re)connect extras: a question awaiting the user and
              // live subagent progress would otherwise be lost to this socket.
              ...(runner?.pendingQuestion ? { question: runner.pendingQuestion } : {}),
              ...(runner?.status ? { status: runner.status } : {}),
              ...(runner && runner.subagents.size > 0
                ? { subagents: [...runner.subagents.values()] }
                : {}),
            });
          }
          const sid = session?.current_sid ?? null;
          if (sid === tailSid) return;
          tail?.close();
          tail = null;
          tailSid = sid;
          if (sid) {
            // Open with only the recent tail (a big transcript can be tens of
            // MB); the client pages older history in via `load-older`. The
            // client dedupes by event id, so a rebind re-emitting overlapping
            // history is harmless.
            // Non-Claude backends (codex/cursor) don't write a Claude-format
            // transcript — the runner writes a muxpad-owned normalized log
            // instead. Point the tail at that log with the identity normalizer;
            // Claude keeps its ~/.claude file + schema translation unchanged.
            const nonClaude = session?.assistant && session.assistant !== 'claude';
            tail = new TranscriptTail(sid, {
              tailBytes: CHAT_HISTORY_TAIL_BYTES,
              onEvents: (events, phase) => send({ t: 'events', phase, events }),
              onTitle: (title) => applyAiTitle(chatPaneId, title),
              ...(nonClaude ? { locate: muxpadLocate, normalize: identityNormalize } : {}),
            });
            tail.start();
          }
        };
        syncSession(true);
        const unsubEvents = deps.events.subscribe((e) => {
          if (e.type === 'agent_session.updated' && e.pane_id === chatPaneId) syncSession(false);
          // A mode PATCH from another device fans out as pane.updated. Gate
          // hard on the mode actually differing: pane.updated also fires on
          // every busy/title/cwd churn, and re-running syncSession on all of
          // those would burn two SQLite reads per output burst for a value
          // that changes maybe twice a day.
          else if (e.type === 'pane.updated' && e.pane.id === chatPaneId) {
            const m = e.pane.mode ?? 'deep';
            if (m !== lastSentMode) syncSession(false);
          }
        });
        const sessionPoll = setInterval(() => syncSession(false), 10_000);
        const teardown = () => {
          clearInterval(sessionPoll);
          unsubEvents();
          tail?.close();
        };
        ws.on('close', teardown);
        ws.on('error', teardown);
        // Composer: drive a turn from chat by relaying to the pane's agent
        // runner (the only chat driver — TUI sessions are view-only here).
        ws.on('message', (data) => {
          const msg = parseFrame<{
            t?: string;
            text?: string;
            qid?: string;
            id?: string;
            model?: string;
            cmd?: string;
            answers?: Array<{ question: string; answers: string[] }>;
          }>(data);
          if (!msg) return;
          // App-level heartbeat: the client pings on an interval and treats a
          // missing pong as a zombie socket (browsers can't observe protocol-
          // level ping/pong, so this rides the JSON channel).
          if (msg.t === 'ping') {
            send({ t: 'pong' });
            return;
          }
          if (msg.t === 'stop') {
            // Relay when a turn is active OR a send was just relayed —
            // turnActive lags a fresh send by a full round trip, and
            // "send, then immediately Stop (oops)" is the most common stop
            // pattern; the runner cancels the queued send. Otherwise answer
            // THIS socket with a turn-done resync: a stray Stop proves this
            // client thinks a turn is running, and a per-socket reply heals
            // it without wiping other clients' in-flight sends — and works
            // even with the runner gone.
            const conn = agentRunners.get(chatPaneId);
            const sendInFlight = conn ? Date.now() - conn.lastSendAt < 15_000 : false;
            if (conn && (conn.turnActive || sendInFlight)) {
              sendToRunner(chatPaneId, { t: 'stop' });
            } else {
              send({ t: 'turn-done', ok: true });
            }
            return;
          }
          // Control-relay failures reply with `notice`, NOT `error`: the
          // client's error handler treats errors as a rejected SEND and
          // resets sending/optimistic state — wrong for a menu action that
          // failed while a turn may be streaming.
          if (msg.t === 'set-model') {
            if (typeof msg.model === 'string' && msg.model.length <= 128) {
              if (!sendToRunner(chatPaneId, { t: 'set-model', model: msg.model })) {
                send({ t: 'notice', message: 'agent is reconnecting — try again in a moment' });
              }
            }
            return;
          }
          if (msg.t === 'slash') {
            if (msg.cmd === 'compact' || msg.cmd === 'clear') {
              if (!sendToRunner(chatPaneId, { t: 'slash', cmd: msg.cmd })) {
                send({ t: 'notice', message: 'agent is reconnecting — try again in a moment' });
              }
            }
            return;
          }
          if (msg.t === 'answer') {
            // Validate the inner shape too — a malformed entry would throw
            // inside the runner's blocked tool call and fail the turn.
            if (
              typeof msg.qid === 'string' &&
              Array.isArray(msg.answers) &&
              msg.answers.every(
                (a) =>
                  a &&
                  typeof a.question === 'string' &&
                  Array.isArray(a.answers) &&
                  a.answers.every((x) => typeof x === 'string'),
              )
            ) {
              sendToRunner(chatPaneId, { t: 'answer', qid: msg.qid, answers: msg.answers });
            }
            return;
          }
          if (msg.t === 'load-older') {
            // Page in the previous chunk of history (emitted as phase 'older'),
            // then tell the client whether any remains so it can stop asking.
            const hasMore = tail?.loadOlder() ?? false;
            send({ t: 'older-done', hasMore });
            return;
          }
          if (msg.t === 'queue-cancel') {
            // Drop a still-pending message before it runs. Broadcast the new
            // queue to every view (this cancel followed the user across devices).
            if (typeof msg.id === 'string' && queue.remove(msg.id, chatPaneId))
              broadcastQueue(chatPaneId);
            return;
          }
          if (msg.t === 'queue-clear') {
            if (queue.clear(chatPaneId) > 0) broadcastQueue(chatPaneId);
            return;
          }
          if (msg.t !== 'send' || typeof msg.text !== 'string' || !msg.text.trim()) return;
          // Ack receipt immediately. The client arms a watchdog on send: with
          // no ack/error/turn-start coming back it knows the socket was dead
          // and restores the composer instead of spinning forever.
          send({ t: 'send-ack' });
          // Chat drives exactly one thing: the pane's agent runner. The server
          // decides whether this runs now or waits in the queue — a busy or
          // reconnecting agent enqueues instead of dropping, and the server
          // drains it later even with no browser open. (TUI sessions are
          // terminal-driven; chat is a read-only view and submitSend rejects.)
          const outcome = submitSend(chatPaneId, msg.text);
          if (outcome.status === 'rejected') {
            send({
              t: 'error',
              message:
                outcome.reason === 'pane has no agent runner'
                  ? 'This session is driven from its terminal — chat is a read-only view. Start an ✳ Agent tab for a chat-native session.'
                  : (outcome.reason ?? 'could not send'),
            });
          } else if (outcome.status === 'queued') {
            // Tell the sending socket its message was parked so it can drop the
            // optimistic turn state; the pending bubble arrives via the queue
            // broadcast (which every view, including this one, already got).
            send({ t: 'queued', id: outcome.id, text: msg.text.trim() });
          }
          // 'sent' → the runner's turn-start broadcasts the working state.
        });
      });
      return;
    }
    const match = url.pathname.match(/^\/ws\/pane\/([^/]+)$/);
    if (!match) {
      socket.destroy();
      return;
    }
    const paneId = match[1] as string;
    const pane = panes.getById(paneId);
    if (!pane) {
      socket.destroy();
      return;
    }
    // URL panes have no PTY; reject upgrade before reaching ptyd
    // (ensurePane on a null shell would crash node-pty inside ptyd).
    if (pane.kind === 'url') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      // Liveness: mark alive on connect and on every pong. The heartbeat
      // sweep above flips this to false before each ping; a client that
      // doesn't pong before the next sweep is terminated as a ghost.
      const live = ws as WebSocket & { isAlive?: boolean };
      live.isAlive = true;
      ws.on('pong', () => {
        live.isAlive = true;
      });

      // pane.shell / pane.cwd are nullable on PaneSpec (URL panes), but
      // we've already rejected kind === 'url' upgrades above; fall back
      // defensively if a row is malformed.
      // Look up the tab's workspace_id so the spawned shell gets the
      // full identity env (MUXPAD_WORKSPACE_ID).
      const workspaceId = tabs.getWorkspaceId(pane.tab_id);

      // Issue ensurePane against ptyd before bridging. If ptyd is
      // disconnected, ensurePane rejects and we close the browser WS so
      // the client knows to retry. ensurePane is idempotent on ptyd's
      // side — repeated calls for the same id are no-ops.
      deps.ptyd
        .ensurePane({
          id: pane.id,
          shell: pane.shell ?? process.env.SHELL ?? '/bin/zsh',
          startup_cmd: pane.startup_cmd,
          cwd: safeCwd(pane.cwd),
          env: pane.env,
          tab_id: pane.tab_id,
          ...(workspaceId !== undefined ? { workspace_id: workspaceId } : {}),
        })
        .then(() => {
          // Race: the client may have already closed (e.g. tab nav)
          // while ensurePane was inflight. Skip the bridge in that case.
          if (ws.readyState !== WebSocket.OPEN) return;
          const replay = url.searchParams.get('replay') !== '0';
          proxyAttach({
            socketPath: deps.ptyd.socketPath,
            paneId: pane.id,
            browser: ws,
            replay,
            // Discount the echo the user's own typing produces from busy
            // detection (see PtydCache.noteInput / markBusy).
            onInput: () => {
              deps.cache.noteInput(pane.id);
              // Living sidebar: typing in a terminal pane is activity too.
              // THROTTLED (one DB write per tab per 60s) — this fires per
              // keystroke frame, so it is exactly the noisy signal the
              // throttle exists for. pane.tab_id is captured at upgrade time
              // and is stale only if the pane was moved mid-attach, which
              // costs at most one bump on the wrong tab.
              activity.touchTab(pane.tab_id);
            },
          });
        })
        .catch(() => {
          try {
            ws.close(1011, 'ptyd unavailable');
          } catch {
            // already closing
          }
        });
    });
  });

  return {
    sweepDeadRunners,
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(heartbeat);
        clearInterval(respawnSweep);
        clearInterval(stallSweep);
        for (const paneId of [...probation.keys()]) clearProbation(paneId);
        for (const client of wss.clients) {
          try {
            client.terminate();
          } catch {
            // ignore
          }
        }
        wss.close(() => resolve());
      }),
  };
}
