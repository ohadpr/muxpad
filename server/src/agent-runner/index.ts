// muxpad agent runner — a long-lived process that lives INSIDE a pane's pty
// (launched by `muxpad agent`). The pane's chat face drives it through the main
// server, which relays sends/stops over /ws/agent-runner/:paneId; this
// process's stdout IS the pane's terminal face (a compact activity log).
//
// Why in-pane rather than a server child: ptyd owns the process (it survives
// `muxpad restart` like every terminal), the pane's persisted startup_cmd
// carries `--resume <sid>` so a ptyd restart or reboot springs the pane back
// into the same session from disk, and pane lifecycle = agent lifecycle with
// zero new supervision machinery.
//
// This file is the provider-neutral HARNESS: env/args, logging, the server ws
// link + frame dispatch, and shutdown. The actual session lives behind an
// AgentBackend (backends/*.ts) — Claude today, dispatched on `--backend`. The
// harness never learns which backend runs; it only relays frames.
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { dim } from './ansi.js';
import { createBackend } from './backends/index.js';
import type { AgentBackend, RunnerHost } from './backends/types.js';
import {
  CLOSE_RUNNER_DISPLACED,
  type RunnerFrame,
  type ServerFrame,
  isBackendId,
  parseFrame,
} from './protocol.js';

const paneId = process.env.MUXPAD_PANE_ID;
const apiUrl = process.env.MUXPAD_API_URL;
if (!paneId || !apiUrl) {
  console.error(
    'muxpad agent: must run inside a muxpad pane (missing MUXPAD_PANE_ID/MUXPAD_API_URL)',
  );
  process.exit(1);
}

// --resume <ref> (written into the pane's startup_cmd by the server once the
// session exists, so a respawned pane resumes instead of minting a session)
// and --model <id> (written by the tabs route at creation, preserved across the
// --resume rewrite). Both are opaque here — the backend interprets them.
let requestedSid: string | null = null;
let requestedModel: string | null = null;
// --backend <id> selects the agent CLI/SDK (default claude). Baked into the
// pane's startup_cmd by the tabs route + the server's self-heal rewrite.
let requestedBackend: 'claude' | 'codex' | 'cursor' = 'claude';
{
  const args = process.argv.slice(2);
  const i = args.indexOf('--resume');
  if (i !== -1 && args[i + 1]) requestedSid = args[i + 1] as string;
  const m = args.indexOf('--model');
  if (m !== -1 && args[m + 1]) requestedModel = args[m + 1] as string;
  const b = args.indexOf('--backend');
  if (b !== -1 && isBackendId(args[b + 1])) requestedBackend = args[b + 1] as typeof requestedBackend;
}
// --pick: the pane was created "Agent" without a harness chosen yet. Start NO
// session — just idle so the chat face can show its harness picker; picking one
// hits POST /panes/:id/agent-backend, which rewrites startup_cmd + respawns us
// with a real --backend.
const pickMode = process.argv.slice(2).includes('--pick');

const ts = () => dim(new Date().toLocaleTimeString('en-GB'));

// ---------------------------------------------------------------------------
// File log. The pty scrollback dies with the pane (and a crashed runner's
// last words are exactly what you need after it's gone), so every log line is
// mirrored — ANSI stripped, ISO-timestamped — to an append-only per-pane file
// under ~/.muxpad/agent-logs/. Best-effort: a failed write disables the
// mirror rather than ever breaking the session.
// ---------------------------------------------------------------------------
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI SGR codes
const ANSI_RE = /\x1b\[[0-9;]*m/g;
let logFile: string | null = null;
try {
  const dir = join(process.env.MUXPAD_DATA_DIR ?? join(homedir(), '.muxpad'), 'agent-logs');
  mkdirSync(dir, { recursive: true });
  logFile = join(dir, `${paneId}.log`);
} catch {
  logFile = null;
}
const fileLog = (line: string) => {
  if (!logFile) return;
  try {
    appendFileSync(logFile, `${new Date().toISOString()} ${line.replace(ANSI_RE, '')}\n`);
  } catch {
    logFile = null; // disk gone/unwritable — don't retry per line
  }
};
const log = (line: string) => {
  console.log(`${ts()} ${line}`);
  fileLog(line);
};

// Last-resort crash visibility: an uncaught throw or rejection kills the
// process after node prints to the pty — which vanishes with the pane. Record
// it in the file first, then let the process die (exit nonzero; the
// supervisor's dead-runner sweep respawns the pane).
process.on('uncaughtException', (e) => {
  fileLog(`FATAL uncaughtException: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  console.error(e);
  process.exit(1);
});
process.on('unhandledRejection', (e) => {
  fileLog(`FATAL unhandledRejection: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  console.error(e);
  process.exit(1);
});
process.on('exit', (code) => {
  fileLog(`process exit · code=${code}`);
});
fileLog(
  `boot · pid=${process.pid} · cwd=${process.cwd()} · argv: ${process.argv.slice(2).join(' ') || '(none)'}`,
);

// ---------------------------------------------------------------------------
// Server link. The main server relays chat sends/stops here and fans the
// backend's turn lifecycle back out to every chat client of the pane.
// Reconnects forever — a `muxpad restart` (server-only) drops the socket for a
// second while this process and its session live on in ptyd.
// ---------------------------------------------------------------------------
const wsUrl = `${apiUrl.replace(/^http/, 'ws')}/ws/agent-runner/${paneId}`;
let ws: WebSocket | null = null;
let closed = false;

function sendFrame(frame: RunnerFrame): void {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
}

const host: RunnerHost = {
  emit: sendFrame,
  log,
  connected: () => ws?.readyState === WebSocket.OPEN,
  paneId,
  apiUrl,
};

const backend: AgentBackend | null = pickMode
  ? null
  : createBackend(requestedBackend, host, { requestedSid, requestedModel });

function connect(): void {
  if (closed || !backend) return;
  const b = backend;
  const sock = new WebSocket(wsUrl);
  ws = sock;
  sock.on('open', () => {
    log(dim('connected to muxpad'));
    sendFrame(b.hello());
    // Re-deliver anything the server's per-connection state lost across the
    // blip (a pending question, the last status) so chat clients recover.
    b.onConnected();
  });
  sock.on('message', (data) => {
    const frame = parseFrame<ServerFrame>(data);
    if (!frame) return;
    if (frame.t === 'send' && typeof frame.text === 'string' && frame.text.trim()) {
      b.send(frame.text);
    } else if (frame.t === 'set-model') {
      if (typeof frame.model === 'string' && frame.model) b.setModel(frame.model);
    } else if (frame.t === 'slash') {
      if (frame.cmd === 'compact' || frame.cmd === 'clear') b.slash(frame.cmd);
    } else if (frame.t === 'stop') {
      b.stop();
    } else if (frame.t === 'answer') {
      b.answer(frame.qid, frame.answers);
    }
  });
  const retry = (code?: number) => {
    if (closed) return;
    // A superseded socket's late close must not clobber the live one (or act on
    // its close code) — only the CURRENT socket drives reconnects.
    if (ws !== sock) return;
    ws = null;
    // The server replaced this runner with a newer process for the same pane.
    // Reconnecting would only steal the pane back — two live processes would
    // then trade the registration forever, strobing the chat's status/busy on
    // every steal (live-observed with orphaned duplicate ptys). The loser's
    // correct move is to exit; the pane and its startup_cmd self-heal belong to
    // the survivor.
    if (code === CLOSE_RUNNER_DISPLACED) {
      log('another runner took over this pane — exiting');
      shutdown(0);
      return;
    }
    setTimeout(connect, 2000);
  };
  sock.on('close', (code) => retry(code));
  sock.on('error', () => {
    try {
      sock.close();
    } catch {
      // close() on a connecting socket can throw; retry fires either way
    }
  });
}

async function main(): Promise<void> {
  if (pickMode || !backend) {
    // No harness chosen yet. Stay alive (keep the pane's agent-runner process so
    // the supervisor's dead-runner sweep doesn't churn it) and start no session;
    // the chat face shows the harness picker. Picking rewrites startup_cmd and
    // respawns us, killing this idle process.
    process.stdout.write('\x1b]0;✳ agent\x07');
    log(dim('choose a harness in the chat face to start a session…'));
    // A bare `await new Promise(() => {})` is NOT enough: an unresolved promise
    // isn't a libuv handle, so with no ws/timer the event loop drains and Node
    // exits immediately. A ref'd interval keeps it alive; shutdown()'s
    // process.exit tears it down on SIGTERM/SIGINT.
    setInterval(() => {}, 1 << 30);
    await new Promise<void>(() => {});
    return;
  }
  connect();
  await backend.start();
}

function shutdown(code: number): void {
  if (closed) return;
  closed = true;
  backend?.shutdown();
  try {
    ws?.close();
  } catch {
    // already gone
  }
  process.exit(code);
}

process.on('SIGTERM', () => {
  fileLog('SIGTERM');
  shutdown(0);
});
process.on('SIGINT', () => {
  log(dim('bye')); // Ctrl-C in the pane ends the runner (the session resumes via startup_cmd)
  shutdown(0);
});

main().catch((e: unknown) => {
  const error = e instanceof Error ? e.message : String(e);
  log(`fatal: ${error}`);
  sendFrame({ t: 'fatal', error });
  // Give the frame a beat to flush, then exit nonzero so the shell shows it.
  setTimeout(() => shutdown(1), 300);
});
