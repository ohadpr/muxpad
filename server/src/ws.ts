import type { Server } from 'node:http';
import { sanitizeAgentStatus } from '@muxpad/shared';
import type Database from 'better-sqlite3';
import { WebSocket, WebSocketServer } from 'ws';
import type { AgentBridge } from './agent-bridge.js';
import {
  type AgentQuestion,
  CLOSE_RUNNER_DISPLACED,
  type RunnerFrame,
  type ServerFrame,
  type SubagentProgress,
  parseFrame,
} from './agent-runner/protocol.js';
import { TranscriptTail } from './chat/TranscriptReader.js';
import type { EventBus } from './events.js';
import { type PtydCache, decoratePane } from './ptyd-cache.js';
import type { PtydClient } from './ptyd-client/PtydClient.js';
import { proxyAttach } from './ptyd-client/proxyAttach.js';
import type { PaneNotifier } from './push.js';
import { safeCwd } from './safe-cwd.js';
import { AgentSessionStore } from './store/AgentSessionStore.js';
import { PaneStore } from './store/PaneStore.js';
import { TabStore } from './store/TabStore.js';

export interface WsServerHandle {
  close(): Promise<void>;
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
}): WsServerHandle {
  const wss = new WebSocketServer({ noServer: true });
  const panes = new PaneStore(deps.db);
  const tabs = new TabStore(deps.db);
  const agents = new AgentSessionStore(deps.db);
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
  // shifts). A user-given name always wins: we only overwrite a null name or
  // one WE set from an earlier title — tracked here in memory, so after a
  // server restart an existing auto-name is treated as user-given (titles
  // change rarely; losing one update beats clobbering a manual rename).
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
    if (tab.name === 'agent' || tab.name === autoTitledTabs.get(tab.id)) {
      if (tab.name !== title) {
        const updated = tabs.update(tab.id, { name: title });
        autoTitledTabs.set(tab.id, title);
        if (updated) deps.events.emit({ type: 'tab.updated', tab: updated });
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
    turnActive: boolean;
    /** Question awaiting the user, so a (re)connecting chat client can render it. */
    pendingQuestion: { qid: string; questions: AgentQuestion[] } | null;
    /** Latest per-task subagent progress for mid-turn (re)connects. */
    subagents: Map<string, SubagentProgress>;
    /** Latest session status (model, context fill, model list) for hellos. */
    status: (RunnerFrame & { t: 'status' }) | null;
    /** When the last chat send was relayed — see the stop handler's gate. */
    lastSendAt: number;
  }
  const agentRunners = new Map<string, AgentRunnerConn>();
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
    deps.agentBridge.send = (paneId, text) => {
      const t = text.trim();
      if (!t) return { ok: false, reason: 'empty message' };
      const pane = panes.getById(paneId);
      if (!pane) return { ok: false, reason: 'pane not found' };
      if (agentRunners.has(paneId)) {
        return sendToRunner(paneId, { t: 'send', text: t })
          ? { ok: true }
          : { ok: false, reason: 'agent is reconnecting — retry' };
      }
      if (pane.startup_cmd?.startsWith('muxpad agent')) {
        if (respawns.get(paneId)?.gaveUp) {
          return { ok: false, reason: agentExitedMessage(paneId) };
        }
        return { ok: false, reason: 'agent is starting — retry' };
      }
      return { ok: false, reason: 'pane has no agent runner' };
    };
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
  // registering (hello) resets its pane's record.
  const RESPAWN_SWEEP_MS = 20_000;
  const RESPAWN_COOLDOWN_MS = 45_000;
  const RESPAWN_MAX_ATTEMPTS = 3;
  interface RespawnState {
    attempts: number;
    lastAt: number;
    gaveUp: boolean;
  }
  const respawns = new Map<string, RespawnState>();
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
        // A just-created pane may not have typed its startup command yet —
        // the foreground probe would misread the bare shell as a dead
        // runner and bounce a healthy boot.
        if (Date.now() - pane.created_at < 30_000) continue;
        const st = respawns.get(pane.id) ?? { attempts: 0, lastAt: 0, gaveUp: false };
        if (st.gaveUp) continue;
        if (Date.now() - st.lastAt < RESPAWN_COOLDOWN_MS) continue;
        // Foreground probe: a live-but-disconnected runner (ws blip mid-
        // reconnect) still owns the pty foreground — leave it alone, it
        // re-registers on its own. Only a shell prompt (or a pane ptyd
        // doesn't even have) is a dead runner.
        let fg: string | null = null;
        try {
          fg = await deps.ptyd.getForegroundCommand(pane.id);
        } catch {
          fg = null; // ptyd unreachable or pane unknown — treat as dead
        }
        if (fg?.includes('agent-runner')) continue;
        st.lastAt = Date.now();
        st.attempts += 1;
        respawns.set(pane.id, st);
        if (st.attempts > RESPAWN_MAX_ATTEMPTS) {
          st.gaveUp = true;
          bcastToPane(pane.id, { t: 'error', message: agentExitedMessage(pane.id) });
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
            startup_cmd: pane.startup_cmd,
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
          turnActive: false,
          pendingQuestion: null,
          subagents: new Map(),
          status: null,
          lastSendAt: 0,
        };
        agentRunners.set(paneId, conn);
        const bcast = (obj: unknown) => bcastToPane(paneId, obj);
        const emitChange = () =>
          deps.events.emit({ type: 'agent_session.updated', pane_id: paneId });
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
            // A registered runner is proof of recovery — forget any respawn
            // attempts (including a give-up: the user restarting it by hand
            // re-arms supervision).
            respawns.delete(paneId);
            agents.attachRunner({ pane_id: paneId, cwd: frame.cwd, session_id: frame.sid });
            if (conn.turnActive) agents.setStatus(paneId, 'running');
            deps.cache.setAgentBusy(paneId, conn.turnActive);
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
            const prevCmd = panes.getById(paneId)?.startup_cmd ?? '';
            const modelMatch = prevCmd.match(/--model ('[^']*'|[^\s']+)/);
            const modelPart = modelMatch ? ` --model ${modelMatch[1]}` : '';
            const selfHealCmd = `muxpad agent${modelPart} --resume ${frame.sid}`;
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
            if (conn.turnActive) bcast({ t: 'turn-start' });
            emitChange();
          } else if (frame.t === 'turn-start') {
            conn.turnActive = true;
            streamBufs.set(paneId, '');
            agents.setStatus(paneId, 'running');
            // Busy propagates via the cache's own paneChange → pane.updated
            // event; no agent_session.updated here — emitting per turn made
            // every open view refetch the session twice per turn.
            deps.cache.setAgentBusy(paneId, true);
            bcast({ t: 'turn-start' });
          } else if (frame.t === 'stream') {
            if (typeof frame.delta !== 'string') return;
            appendStreamBuf(paneId, frame.delta);
            bcast({ t: 'stream', delta: frame.delta });
          } else if (frame.t === 'turn-done') {
            conn.turnActive = false;
            conn.pendingQuestion = null;
            conn.subagents.clear();
            streamBufs.delete(paneId);
            agents.setStatus(paneId, 'idle');
            deps.cache.setAgentBusy(paneId, false);
            bcast({
              t: 'turn-done',
              ok: frame.ok !== false,
              ...(frame.error ? { error: frame.error } : {}),
            });
            // Chat-native agents never ring BEL, so the attention-push path
            // can't see them — notify turn completion here instead. Gated on
            // interactivity: a turn answered within the suppress window of
            // the user's own chat send is a conversation they're actively
            // driving (every reply would buzz their phone mid-chat).
            // Long-running turns (the user walked away) and autonomous
            // wakeup/cron turns (no recent send) do push.
            if (Date.now() - conn.lastSendAt > INTERACTIVE_PUSH_SUPPRESS_MS) {
              deps.notifyPane?.(
                paneId,
                frame.ok !== false ? 'agent finished its turn' : 'agent turn failed',
              );
            }
          } else if (frame.t === 'question') {
            if (typeof frame.qid !== 'string' || !Array.isArray(frame.questions)) return;
            conn.pendingQuestion = { qid: frame.qid, questions: frame.questions };
            bcast({ t: 'question', qid: frame.qid, questions: frame.questions });
            const q = frame.questions[0]?.question;
            deps.notifyPane?.(
              paneId,
              q ? `agent asks: ${q.slice(0, 140)}` : 'agent has a question',
            );
          } else if (frame.t === 'question-done') {
            if (conn.pendingQuestion?.qid === frame.qid) conn.pendingQuestion = null;
            bcast({ t: 'question-done', qid: frame.qid });
          } else if (frame.t === 'subagent') {
            if (!frame.progress || typeof frame.progress.toolUseId !== 'string') return;
            conn.subagents.set(frame.progress.toolUseId, frame.progress);
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
            bcast({ t: 'error', message: `agent exited: ${frame.error}` });
          }
        });
        const teardown = () => {
          // Only tear down if this socket is still the registered runner —
          // a replaced (old) socket must not detach its successor.
          if (agentRunners.get(paneId) !== conn) return;
          agentRunners.delete(paneId);
          agents.detachRunner(paneId);
          deps.cache.setAgentBusy(paneId, false);
          streamBufs.delete(paneId);
          if (conn.turnActive) {
            bcast({ t: 'turn-done', ok: false, error: 'agent disconnected' });
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
        const syncSession = (first: boolean) => {
          const session = agents.getByPane(chatPaneId);
          const hello = JSON.stringify({
            sid: session?.current_sid ?? null,
            writer: session?.writer ?? null,
            view: session?.view_mode ?? null,
          });
          if (first || hello !== lastHello) {
            lastHello = hello;
            const runner = agentRunners.get(chatPaneId);
            const turnRunning = runner?.turnActive === true;
            const streamText = streamBufs.get(chatPaneId);
            send({
              t: 'session',
              session,
              turnRunning,
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
            tail = new TranscriptTail(sid, {
              tailBytes: CHAT_HISTORY_TAIL_BYTES,
              onEvents: (events, phase) => send({ t: 'events', phase, events }),
              onTitle: (title) => applyAiTitle(chatPaneId, title),
            });
            tail.start();
          }
        };
        syncSession(true);
        const unsubEvents = deps.events.subscribe((e) => {
          if (e.type === 'agent_session.updated' && e.pane_id === chatPaneId) syncSession(false);
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
          if (msg.t !== 'send' || typeof msg.text !== 'string' || !msg.text.trim()) return;
          // Ack receipt immediately. The client arms a watchdog on send: with
          // no ack/error/turn-start coming back it knows the socket was dead
          // and restores the composer instead of spinning forever.
          send({ t: 'send-ack' });
          // Chat drives exactly one thing: the pane's agent runner. TUI
          // sessions (`muxpad claude`) are terminal-driven and chat is a live
          // read-only view of their transcript — the old terminal⇄chat driver
          // hand-off (headless per-turn `claude -p`, takeover, dual-writer
          // guards) was dropped; see PR "drop terminal⇄chat session
          // switching" for the capability's record.
          if (agentRunners.has(chatPaneId)) {
            if (sendToRunner(chatPaneId, { t: 'send', text: msg.text })) {
              const conn = agentRunners.get(chatPaneId);
              if (conn) conn.lastSendAt = Date.now();
            } else {
              send({ t: 'error', message: 'agent is reconnecting — try again' });
            }
            return;
          }
          // Runner-owned pane whose runner is between connections (server
          // just restarted; ws blip; dead process): the startup_cmd marker is
          // the durable sign of runner ownership — never fall back to another
          // writer. If supervision already gave up, say so plainly; otherwise
          // kick a sweep now (a user send is the best "is it back?" moment)
          // and tell them to retry.
          if (panes.getById(chatPaneId)?.startup_cmd?.startsWith('muxpad agent')) {
            if (respawns.get(chatPaneId)?.gaveUp) {
              send({ t: 'error', message: agentExitedMessage(chatPaneId) });
            } else {
              void sweepDeadRunners();
              send({ t: 'error', message: 'agent is reconnecting — try again in a few seconds' });
            }
            return;
          }
          send({
            t: 'error',
            message:
              'This session is driven from its terminal — chat is a read-only view. Start an ✳ Agent tab for a chat-native session.',
          });
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
            onInput: () => deps.cache.noteInput(pane.id),
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
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(heartbeat);
        clearInterval(respawnSweep);
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
