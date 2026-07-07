import type { Server } from 'node:http';
import { homedir } from 'node:os';
import type Database from 'better-sqlite3';
import { WebSocket, WebSocketServer } from 'ws';
import { type RunnerFrame, type ServerFrame, parseFrame } from './agent-runner/protocol.js';
import { HeadlessRunner } from './chat/HeadlessRunner.js';
import { TranscriptTail, findTranscript } from './chat/TranscriptReader.js';
import { findConversationRival } from './chat/conversation-guard.js';
import type { EventBus } from './events.js';
import type { PtydCache } from './ptyd-cache.js';
import type { PtydClient } from './ptyd-client/PtydClient.js';
import { proxyAttach } from './ptyd-client/proxyAttach.js';
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

export function attachWsServer(deps: {
  http: Server;
  db: Database.Database;
  ptyd: PtydClient;
  cache: PtydCache;
  events: EventBus;
  /** Liveness ping interval in ms. Defaults to 15s; tests pass a small value. */
  heartbeatMs?: number;
}): WsServerHandle {
  const wss = new WebSocketServer({ noServer: true });
  const panes = new PaneStore(deps.db);
  const tabs = new TabStore(deps.db);
  const agents = new AgentSessionStore(deps.db);
  // Any headless writer / running status persisted by a previous process is a
  // turn that died with it (restart mid-turn) — clear it or panes look stuck.
  agents.reconcileStartup();
  // One in-flight headless turn per pane. Keyed by pane (not ws) so a client
  // reconnect never spawns a second driver or aborts a running turn.
  const chatRunners = new Map<string, HeadlessRunner>();
  // Panes whose turn is mid-spawn (past the guard, awaiting the foreground
  // check, before the runner lands in chatRunners). Reserved SYNCHRONOUSLY so a
  // double-send can't slip two runners onto one session across the await.
  const startingChat = new Set<string>();
  // Session-ids with a headless turn reserved or in flight → the driving pane.
  // Single-writer is per CONVERSATION, not per pane: a cross-pane
  // `muxpad claude --resume <sid>` can leave two panes tracking the same sid,
  // and two writers on one sid corrupt the transcript regardless of pane.
  const drivingSids = new Map<string, string>();
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
  // Connected agent runners (`muxpad agent` processes living in panes),
  // keyed by pane. A connected runner owns its pane's session: chat sends
  // and stops relay to it instead of spawning per-turn `claude -p` workers,
  // and its turn lifecycle fans back out through chatClients.
  interface AgentRunnerConn {
    ws: WebSocket;
    sid: string | null;
    turnActive: boolean;
  }
  const agentRunners = new Map<string, AgentRunnerConn>();
  const sendToRunner = (paneId: string, frame: ServerFrame): boolean => {
    const r = agentRunners.get(paneId);
    if (!r || r.ws.readyState !== WebSocket.OPEN) return false;
    r.ws.send(JSON.stringify(frame));
    return true;
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
        // connect before the old socket's close fires. Terminate the old one
        // so its close handler can't tear down the new registration.
        const prev = agentRunners.get(paneId);
        if (prev) {
          agentRunners.delete(paneId);
          try {
            prev.ws.terminate();
          } catch {
            // already dead
          }
        }
        const conn: AgentRunnerConn = { ws, sid: null, turnActive: false };
        agentRunners.set(paneId, conn);
        const bcast = (obj: unknown) => bcastToPane(paneId, obj);
        const emitChange = () =>
          deps.events.emit({ type: 'agent_session.updated', pane_id: paneId });
        ws.on('message', (data) => {
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
            conn.sid = frame.sid;
            conn.turnActive = frame.turnActive === true;
            agents.attachRunner({ pane_id: paneId, cwd: frame.cwd, session_id: frame.sid });
            if (conn.turnActive) agents.setStatus(paneId, 'running');
            deps.cache.setAgentBusy(paneId, conn.turnActive);
            // Self-heal: the pane's startup command now resumes THIS session,
            // so the pane survives ptyd restarts and reboots.
            panes.setStartupCmd(paneId, `muxpad agent --resume ${frame.sid}`);
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
            streamBufs.delete(paneId);
            agents.setStatus(paneId, 'idle');
            deps.cache.setAgentBusy(paneId, false);
            bcast({
              t: 'turn-done',
              ok: frame.ok !== false,
              ...(frame.error ? { error: frame.error } : {}),
            });
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
            const turnRunning =
              chatRunners.has(chatPaneId) ||
              startingChat.has(chatPaneId) ||
              agentRunners.get(chatPaneId)?.turnActive === true;
            const streamText = streamBufs.get(chatPaneId);
            send({
              t: 'session',
              session,
              turnRunning,
              ...(turnRunning && streamText ? { streamText } : {}),
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
        // Composer: drive a turn from chat. Single-writer is enforced by
        // refusing to spawn while a Claude TUI is the pane's live foreground —
        // two drivers on one session-id corrupt the transcript. One turn per
        // pane at a time; the runner is keyed by pane so it outlives this ws.
        ws.on('message', (data) => {
          const msg = parseFrame<{ t?: string; text?: string }>(data);
          if (!msg) return;
          if (msg.t === 'stop') {
            if (!sendToRunner(chatPaneId, { t: 'stop' })) {
              chatRunners.get(chatPaneId)?.interrupt();
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
          // Ack receipt immediately (before any guard). The client arms a
          // watchdog on send: with no ack/error/turn-start coming back it
          // knows the socket was dead and restores the composer instead of
          // spinning forever on a message the server never saw.
          send({ t: 'send-ack' });
          // A pane with a live agent runner: relay straight to it. The runner
          // owns the session (it IS the pane's foreground process), so none
          // of the TUI/single-writer guards below apply — it serializes
          // queued sends itself and broadcasts the turn lifecycle back.
          if (agentRunners.has(chatPaneId)) {
            if (!sendToRunner(chatPaneId, { t: 'send', text: msg.text })) {
              send({ t: 'error', message: 'agent is reconnecting — try again' });
            }
            return;
          }
          const s = agents.getByPane(chatPaneId);
          const sid = s?.current_sid;
          if (!s || !sid) {
            send({ t: 'error', message: 'no session to drive' });
            return;
          }
          if (chatRunners.has(chatPaneId) || startingChat.has(chatPaneId)) {
            send({ t: 'error', message: 'a turn is already running' });
            return;
          }
          // Conversation-level single-writer: another pane may hold the same
          // sid (cross-pane `--resume`); its runner is just as much a second
          // writer as one on this pane.
          if (drivingSids.has(sid)) {
            send({ t: 'error', message: 'another pane is already driving this conversation' });
            return;
          }
          // Same rule for a live agent runner on ANOTHER pane: its foreground
          // is `node …/agent-runner`, so the claude-foreground rival scan
          // below can't see it — check the registry (and, via the guard's
          // writer field, the store) directly.
          for (const [otherPane, otherConn] of agentRunners) {
            if (otherPane !== chatPaneId && otherConn.sid === sid) {
              send({
                t: 'error',
                message: "another pane's agent is driving this conversation",
              });
              return;
            }
          }
          // Reserve the pane AND the sid synchronously — before the awaited
          // foreground checks — so a second concurrent send (same pane or a
          // sibling on the same sid) can't spawn a second runner on one
          // session-id (transcript corruption).
          startingChat.add(chatPaneId);
          drivingSids.set(sid, chatPaneId);
          const release = () => {
            startingChat.delete(chatPaneId);
            if (drivingSids.get(sid) === chatPaneId) drivingSids.delete(sid);
          };
          const text = msg.text;
          void (async () => {
            const fg = await deps.ptyd.getForegroundCommand(chatPaneId).catch(() => null);
            if (fg && /\bclaude\b/i.test(fg)) {
              release();
              send({ t: 'blocked', reason: 'terminal-driving' });
              return;
            }
            // Same check for every OTHER pane tracking this sid: a live
            // Claude TUI there is already writing this conversation, and the
            // per-pane foreground check above can't see it.
            const rival = await findConversationRival(chatPaneId, sid, agents.list(), (id) =>
              deps.ptyd.getForegroundCommand(id),
            );
            if (rival) {
              release();
              send({
                t: 'error',
                message: "another pane's terminal is driving this conversation",
              });
              return;
            }
            agents.setWriter(chatPaneId, 'headless');
            agents.setStatus(chatPaneId, 'running');
            // Light the pane's busy flag for the turn. A headless turn writes
            // the transcript file, not the PTY, so the output-activity
            // detector never sees it — without this the tab/workspace spinner
            // stays dark while chat works. The cache emits paneChange →
            // pane.updated, so the spinner flips live, not on the next poll.
            deps.cache.setAgentBusy(chatPaneId, true);
            streamBufs.set(chatPaneId, '');
            bcast({ t: 'turn-start' });
            // A session launched via `muxpad claude` but never prompted has no
            // transcript yet — `--resume` would fail with "no conversation
            // found". Start it fresh under the same id instead, so the first
            // message CAN come from chat.
            const fresh = !findTranscript(sid);
            const runner = new HeadlessRunner({
              cwd: s.cwd ?? homedir(),
              resumeSid: sid,
              fresh,
              text,
              cb: {
                onSessionId: (newSid) => {
                  const prev = agents.getByPane(chatPaneId)?.current_sid;
                  agents.recordSessionId(chatPaneId, newSid);
                  // Sid drift mid-turn: push so every chat socket rebinds its
                  // tail now instead of on the slow fallback poll.
                  if (prev !== newSid) {
                    deps.events.emit({ type: 'agent_session.updated', pane_id: chatPaneId });
                  }
                },
                onText: (delta) => {
                  appendStreamBuf(chatPaneId, delta);
                  bcast({ t: 'stream', delta });
                },
                onDone: (ok, error) => {
                  chatRunners.delete(chatPaneId);
                  if (drivingSids.get(sid) === chatPaneId) drivingSids.delete(sid);
                  // An agent runner may have attached mid-turn (the user typed
                  // `muxpad agent` while this headless turn ran) — its writer/
                  // busy/preview state is not ours to clobber then.
                  if (!agentRunners.has(chatPaneId)) {
                    streamBufs.delete(chatPaneId);
                    agents.setWriter(chatPaneId, 'none');
                    agents.setStatus(chatPaneId, 'idle');
                    deps.cache.setAgentBusy(chatPaneId, false);
                  }
                  bcast({ t: 'turn-done', ok, ...(error ? { error } : {}) });
                },
              },
            });
            chatRunners.set(chatPaneId, runner);
            startingChat.delete(chatPaneId);
            runner.start();
          })().catch((e) => {
            // Anything thrown past the guards (store write, runner ctor)
            // must release the reservations, or the pane wedges forever on
            // "a turn is already running".
            if (!chatRunners.has(chatPaneId)) {
              release();
              if (!agentRunners.has(chatPaneId)) {
                streamBufs.delete(chatPaneId);
                deps.cache.setAgentBusy(chatPaneId, false);
                try {
                  agents.setWriter(chatPaneId, 'none');
                  agents.setStatus(chatPaneId, 'idle');
                } catch {
                  // the store write itself may be what failed
                }
              }
            }
            send({ t: 'error', message: e instanceof Error ? e.message : String(e) });
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
