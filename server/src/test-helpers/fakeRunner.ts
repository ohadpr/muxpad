// A HIGH-FIDELITY fake `muxpad agent` runner: the REAL Claude backend (and so
// the real SubagentRoster and the real SDK→roster dispatch) behind a
// reimplementation of the ~40 lines of ws glue in agent-runner/index.ts.
//
// index.ts itself is a script — it reads env at import, exits on missing vars,
// installs signal handlers — so it cannot be imported by a test. The glue is
// mirrored here rather than refactored, because the glue is NOT where the
// subagent count is computed; the backend and the server are, and both of those
// are the genuine article on this path.
//
// The caller supplies SDK messages (see sdkScript.ts) and this drives:
//     scripted SDK message
//        → real claude.ts dispatch loop
//        → real SubagentRoster
//        → real `subagent` wire frames over a real WebSocket
//        → real ws.ts /ws/agent-runner/:paneId handler
//        → real PtydCache.setSubagentCount
// which is every layer the pane's `agents: N` badge is built from.
//
// IMPORTANT: the test file must `vi.mock('@anthropic-ai/claude-agent-sdk')`
// onto ./fakeAgentSdk.js BEFORE importing this module, or a real SDK session is
// spawned at backend construction.

import { WebSocket } from 'ws';
import { createClaudeBackend } from '../agent-runner/backends/claude.js';
import type { AgentBackend, RunnerHost } from '../agent-runner/backends/types.js';
import {
  CLOSE_RUNNER_DISPLACED,
  type RunnerFrame,
  type ServerFrame,
  parseFrame,
} from '../agent-runner/protocol.js';
import { type FakeSession, fakeSession } from './fakeAgentSdk.js';

export interface FakeRunner {
  /** The live backend (send/stop/setModel/… exactly as the harness drives it). */
  readonly backend: AgentBackend;
  /** The scripted SDK session feeding the backend's message loop. */
  readonly sdk: FakeSession;
  /** Push SDK messages and wait for the loop to consume them. */
  feed(messages: unknown[]): Promise<void>;
  /** Every frame this runner sent to the server, in order. */
  readonly sent: RunnerFrame[];
  /** Log lines the backend wrote to the pane's terminal face. */
  readonly logs: string[];
  /** Drop the socket WITHOUT reconnecting — a ws blip / server restart. */
  disconnect(): Promise<void>;
  /** Reconnect after {@link disconnect} (re-hello + onConnected re-announce). */
  reconnect(): Promise<void>;
  /** Kill the runner: close the socket for good and shut the backend down. */
  kill(): Promise<void>;
  /** True while the control socket is open. */
  connected(): boolean;
}

export interface FakeRunnerOptions {
  port: number;
  paneId: string;
  sid?: string | null;
  /** Auto-reconnect like the real harness (default false — tests step it). */
  autoReconnect?: boolean;
}

/** Boot a fake runner and wait for its hello to land. */
export async function startFakeRunner(opts: FakeRunnerOptions): Promise<FakeRunner> {
  const { port, paneId } = opts;
  const url = `ws://127.0.0.1:${port}/ws/agent-runner/${paneId}`;
  const sent: RunnerFrame[] = [];
  const logs: string[] = [];
  let sock: WebSocket | null = null;
  let stopped = false;

  const host: RunnerHost = {
    emit(frame) {
      // Exactly index.ts's sendFrame: a frame emitted while the socket is down
      // is DROPPED, not queued. The reconnect path is what re-delivers state.
      sent.push(frame);
      if (sock?.readyState === WebSocket.OPEN) sock.send(JSON.stringify(frame));
    },
    log(line) {
      logs.push(line);
    },
    connected: () => sock?.readyState === WebSocket.OPEN,
    paneId,
    apiUrl: `http://127.0.0.1:${port}`,
  };

  const backend = createClaudeBackend(host, {
    requestedSid: opts.sid ?? null,
    requestedModel: null,
    mode: 'deep',
  });
  const sdk = fakeSession();

  // The backend's message loop. Never awaited by the caller — it resolves only
  // when the scripted stream ends.
  const loop = backend.start().catch(() => {
    // A closed session ends the loop; nothing to report.
  });

  async function open(): Promise<void> {
    const s = new WebSocket(url);
    sock = s;
    await new Promise<void>((resolve, reject) => {
      s.once('open', () => resolve());
      s.once('error', reject);
    });
    s.on('message', (data) => {
      const frame = parseFrame<ServerFrame>(data);
      if (!frame) return;
      if (frame.t === 'send' && typeof frame.text === 'string' && frame.text.trim())
        backend.send(frame.text);
      else if (frame.t === 'stop') backend.stop();
      else if (frame.t === 'set-model' && typeof frame.model === 'string')
        backend.setModel(frame.model);
      else if (frame.t === 'slash' && (frame.cmd === 'compact' || frame.cmd === 'clear'))
        backend.slash(frame.cmd);
      else if (frame.t === 'answer') backend.answer(frame.qid, frame.answers);
    });
    s.on('close', (code) => {
      if (stopped || sock !== s) return;
      sock = null;
      if (code === CLOSE_RUNNER_DISPLACED) return;
      if (opts.autoReconnect) setTimeout(() => void open(), 20);
    });
    s.on('error', () => {
      try {
        s.close();
      } catch {
        // a connecting socket can throw on close; the close handler still runs
      }
    });
    // The harness's open sequence, in order.
    host.emit(backend.hello());
    backend.onConnected();
  }

  await open();
  // Let the server register the runner before the caller scripts anything.
  await new Promise((r) => setTimeout(r, 120));

  return {
    backend,
    sdk,
    sent,
    logs,
    connected: () => sock?.readyState === WebSocket.OPEN,
    async feed(messages) {
      for (const m of messages) sdk.push(m);
      await sdk.settle();
      // …and let the frames the loop emitted reach the server.
      await new Promise((r) => setTimeout(r, 30));
    },
    async disconnect() {
      const s = sock;
      sock = null;
      if (!s) return;
      await new Promise<void>((resolve) => {
        s.once('close', () => resolve());
        s.close();
      });
      await new Promise((r) => setTimeout(r, 60));
    },
    async reconnect() {
      await open();
      await new Promise((r) => setTimeout(r, 120));
    },
    async kill() {
      stopped = true;
      const s = sock;
      sock = null;
      backend.shutdown();
      if (s)
        await new Promise<void>((resolve) => {
          s.once('close', () => resolve());
          s.close();
        });
      sdk.end();
      await loop;
      await new Promise((r) => setTimeout(r, 60));
    },
  };
}
