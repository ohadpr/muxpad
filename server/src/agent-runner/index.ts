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
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { dim } from './ansi.js';
import { RUNNER_USAGE, parseRunnerArgs } from './args.js';
import { createBackend } from './backends/index.js';
import type { AgentBackend, RunnerHost } from './backends/types.js';
import {
  CLOSE_RUNNER_DISPLACED,
  type RunnerFrame,
  type ServerFrame,
  parseAgentMode,
  parseFrame,
} from './protocol.js';

// ARGV IS PARSED BEFORE ANYTHING ELSE HAPPENS — before the pane-env guard, so
// `muxpad agent --help` answers from an ordinary shell too, and before a single
// session can be minted.
//
// Argv that isn't fully understood does NOT start a session; see args.ts for
// why that rule is written in blood (`--help`, `--resume=<sid>`, a misspelt
// `--resme` and a missing value were all, silently, "mint a brand-new session
// in a pane that already had one" — which strands its conversation the moment
// the server's self-heal rewrite believes the hello).
const parsed = parseRunnerArgs(process.argv.slice(2));
if (parsed.kind === 'help') {
  console.log(RUNNER_USAGE);
  process.exit(0);
}
if (parsed.kind === 'error') {
  console.error(parsed.message);
  process.exit(2);
}

const paneId = process.env.MUXPAD_PANE_ID;
const apiUrl = process.env.MUXPAD_API_URL;
if (!paneId || !apiUrl) {
  console.error(
    'muxpad agent: must run inside a muxpad pane (missing MUXPAD_PANE_ID/MUXPAD_API_URL)',
  );
  process.exit(1);
}

// The flags, already parsed and validated (args.ts):
//   --resume <ref>  the session to continue — written into the pane's
//                   startup_cmd by the server once the session exists, so a
//                   respawned pane resumes instead of minting a new one.
//   --model <id>    a launch-time model pin (tabs route; preserved across the
//                   self-heal rewrite). Opaque here — the backend reads it.
//   --backend <id>  which agent CLI/SDK drives the pane (default claude).
//   --mode chat|agent  the LAUNCH mode.
//   --pick          the pane was created "Agent" with no harness chosen yet:
//                   start NO session, just idle so the chat face can show its
//                   harness picker. Picking one hits POST
//                   /panes/:id/agent-backend, which rewrites startup_cmd and
//                   respawns us with a real --backend.
//
// ABSENT --mode = BASELINE_AGENT_MODE ('agent') = exactly the pre-mode
// behavior, and that is deliberate even though the pane-level DEFAULT is now
// Chat. A bare `muxpad agent` is what every pane created before modes existed
// still carries, plus anything hand-typed in a terminal; making the flag's
// absence mean "overlay the house contract" would have silently re-prompted
// all of them on their next respawn. The default is applied where a pane is
// CREATED (agent-tab.ts), which is the only place that knows it is a new
// choice rather than an old row.
const {
  requestedSid,
  requestedModel,
  requestedBackend,
  requestedMode,
  pick: pickMode,
} = parsed.args;

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
// Reap orphaned descendants (dev servers etc.) when the runner exits. Agents
// routinely start long-lived processes — `vite`, `pnpm dev` — that outlive both
// the turn (spawn-per-turn backends exit, reparenting the server to launchd) AND
// the pane, piling up as leaked servers holding ports. A reparented process
// keeps its process-group id, so if WE are the group leader (a foreground shell
// job — the normal pane case), every descendant still shares our pgid and we can
// take the whole group down. Guarded to the leader case so we never signal the
// parent shell's group; best-effort (skips if `ps` is unavailable). Runs from
// the `exit` handler so it fires on EVERY exit path (signals, crash, normal).
let reaped = false;
function reapProcessGroup(): void {
  if (reaped) return;
  reaped = true;
  try {
    const rows = execFileSync('ps', ['-A', '-o', 'pid=,pgid='], {
      encoding: 'utf8',
      timeout: 3000,
    });
    const parsed: Array<[number, number]> = [];
    let myPgid: number | null = null;
    for (const row of rows.split('\n')) {
      const m = row.trim().match(/^(\d+)\s+(\d+)$/);
      if (!m) continue;
      const pid = Number(m[1]);
      const pgid = Number(m[2]);
      parsed.push([pid, pgid]);
      if (pid === process.pid) myPgid = pgid;
    }
    // Only reap when we lead our own group — otherwise `-pgid` would reach the
    // parent shell and its other jobs.
    if (myPgid == null || myPgid !== process.pid) return;
    for (const [pid, pgid] of parsed) {
      if (pgid === myPgid && pid !== process.pid) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // already gone
        }
      }
    }
  } catch {
    // `ps` missing / no permission — nothing we can safely do.
  }
}
process.on('exit', (code) => {
  fileLog(`process exit · code=${code}`);
  reapProcessGroup();
});
fileLog(
  `boot · pid=${process.pid} · cwd=${process.cwd()} · argv: ${process.argv.slice(2).join(' ') || '(none)'}`,
);
// Argv complaints that were not worth refusing to boot over (a `--mode`
// spelling from a newer server). Logged here rather than swallowed: the pane's
// mode is about to disagree with what someone typed, and the log is the only
// place that can say so.
for (const w of parsed.args.warnings) log(dim(w));

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
  : createBackend(requestedBackend, host, { requestedSid, requestedModel, mode: requestedMode });

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
    } else if (frame.t === 'mode') {
      // Validated here (not trusted off the wire) — the same value can end up
      // in a shell-typed startup_cmd on the server side. Tolerant of the
      // pre-rename spellings so a server upgraded under a live runner can
      // still switch it.
      const next = parseAgentMode(frame.mode);
      if (next) b.setMode(next);
    } else if (frame.t === 'answer') {
      b.answer(frame.qid, frame.answers);
    } else if (frame.t === 'notify-result') {
      // Optional on the backend: only one that offers the `notify` tool can
      // have sent the frame this answers.
      if (typeof frame.nid === 'string' && frame.nid) b.notifyResult?.(frame.nid, frame.status);
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
