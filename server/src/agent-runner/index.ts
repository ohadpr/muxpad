// muxpad agent runner — a long-lived process that lives INSIDE a pane's pty
// (launched by `muxpad agent`) and hosts a persistent Claude session via the
// Agent SDK. The pane's chat face drives it through the main server, which
// relays sends/stops over /ws/agent-runner/:paneId; this process's stdout IS
// the pane's terminal face (a compact activity log).
//
// Why in-pane rather than a server child: ptyd owns the process (it survives
// `muxpad restart` like every terminal), the pane's persisted startup_cmd
// carries `--resume <sid>` so a ptyd restart or reboot springs the pane back
// into the same session from disk, and pane lifecycle = agent lifecycle with
// zero new supervision machinery.
//
// The transcript JSONL stays the read path (the chat tail renders it, spike-
// verified for SDK sessions); this process only drives turns and streams the
// live-typing preview.
import { randomUUID } from 'node:crypto';
import { type Options, type SDKUserMessage, query } from '@anthropic-ai/claude-agent-sdk';
import WebSocket from 'ws';
import { type RunnerFrame, type ServerFrame, parseFrame } from './protocol.js';

const paneId = process.env.MUXPAD_PANE_ID;
const apiUrl = process.env.MUXPAD_API_URL;
if (!paneId || !apiUrl) {
  console.error(
    'muxpad agent: must run inside a muxpad pane (missing MUXPAD_PANE_ID/MUXPAD_API_URL)',
  );
  process.exit(1);
}

// --resume <sid> (written into the pane's startup_cmd by the server once the
// session exists, so a respawned pane resumes instead of minting a session).
let resumeSid: string | null = null;
{
  const args = process.argv.slice(2);
  const i = args.indexOf('--resume');
  if (i !== -1 && args[i + 1]) resumeSid = args[i + 1] as string;
}
const sid = resumeSid ?? randomUUID();

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const ts = () => dim(new Date().toLocaleTimeString('en-GB'));
const log = (line: string) => console.log(`${ts()} ${line}`);

// ---------------------------------------------------------------------------
// Turn queue. Sends arriving from chat are serialized: one user turn in
// flight at a time, the next yielded to the SDK only after the previous
// turn's result. (The SDK would accept queued messages, but merging/queuing
// semantics are its own; explicit serialization keeps turn-start/turn-done
// accounting exact for the chat UI.)
// ---------------------------------------------------------------------------
const pendingTexts: string[] = [];
let inTurn = false;
let interruptRequested = false;
let wakeQueue: (() => void) | null = null;
const kick = () => {
  wakeQueue?.();
  wakeQueue = null;
};

async function* userMessages(): AsyncGenerator<SDKUserMessage> {
  while (true) {
    while (!inTurn && pendingTexts.length > 0) {
      const text = pendingTexts.shift() as string;
      inTurn = true;
      interruptRequested = false;
      sendFrame({ t: 'turn-start' });
      log(`${bold('▸ user')} ${text.length > 200 ? `${text.slice(0, 200)}…` : text}`);
      yield {
        type: 'user',
        message: { role: 'user', content: text },
        parent_tool_use_id: null,
      };
    }
    await new Promise<void>((r) => {
      wakeQueue = r;
    });
  }
}

// ---------------------------------------------------------------------------
// Server link. The main server relays chat sends/stops here and fans our
// turn lifecycle back out to every chat client of the pane. Reconnects
// forever — a `muxpad restart` (server-only) drops the socket for a second
// while this process and its Claude session live on in ptyd.
// ---------------------------------------------------------------------------
const wsUrl = `${apiUrl.replace(/^http/, 'ws')}/ws/agent-runner/${paneId}`;
let ws: WebSocket | null = null;
let closed = false;

function sendFrame(frame: RunnerFrame): void {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
}

function connect(): void {
  if (closed) return;
  const sock = new WebSocket(wsUrl);
  ws = sock;
  sock.on('open', () => {
    log(dim('connected to muxpad'));
    sendFrame({ t: 'hello', sid, cwd: process.cwd(), pid: process.pid, turnActive: inTurn });
  });
  sock.on('message', (data) => {
    const frame = parseFrame<ServerFrame>(data);
    if (!frame) return;
    if (frame.t === 'send' && typeof frame.text === 'string' && frame.text.trim()) {
      pendingTexts.push(frame.text);
      kick();
    } else if (frame.t === 'stop') {
      if (inTurn) {
        interruptRequested = true;
        log(dim('⏹ interrupt requested'));
        session.interrupt().catch((e: unknown) => {
          log(dim(`interrupt failed: ${e instanceof Error ? e.message : String(e)}`));
        });
      }
    }
  });
  const retry = () => {
    if (closed) return;
    ws = null;
    setTimeout(connect, 2000);
  };
  sock.on('close', retry);
  sock.on('error', () => {
    try {
      sock.close();
    } catch {
      // close() on a connecting socket can throw; retry fires either way
    }
  });
}

// ---------------------------------------------------------------------------
// The Claude session. Streaming input keeps ONE process alive across every
// turn — so in-session state (scheduled wakeups, background tasks, warm
// context) survives between chat messages, which per-turn `claude -p` spawns
// structurally could not.
// ---------------------------------------------------------------------------
const options: Options = {
  cwd: process.cwd(),
  ...(resumeSid ? { resume: resumeSid } : { sessionId: sid }),
  // Yolo parity with `muxpad claude --dangerously-skip-permissions`. The SDK
  // auto-approves every tool call under bypass (canUseTool is never consulted
  // — spike-verified), so no permission prompt can wedge a headless turn.
  permissionMode: 'bypassPermissions',
  allowDangerouslySkipPermissions: true,
  includePartialMessages: true,
  // No settingSources override: default = user+project+local settings,
  // CLAUDE.md, skills, MCP — same session the terminal TUI would run.
};

const session = query({ prompt: userMessages(), options });

function summarizeToolUse(name: string, input: unknown): string {
  if (input && typeof input === 'object') {
    const o = input as Record<string, unknown>;
    for (const k of ['command', 'file_path', 'path', 'pattern', 'url', 'description', 'prompt']) {
      if (typeof o[k] === 'string') {
        const v = (o[k] as string).replace(/\s+/g, ' ');
        return v.length > 120 ? `${v.slice(0, 120)}…` : v;
      }
    }
  }
  return '';
}

async function main(): Promise<void> {
  connect();
  log(`${bold('muxpad agent')} — session ${sid}${resumeSid ? ' (resumed)' : ''}`);
  log(dim(`pane ${paneId} · ${process.cwd()}`));
  log(dim('drive this session from the pane’s Chat face; this log is the terminal face'));

  for await (const msg of session) {
    if (msg.type === 'system' && msg.subtype === 'init') {
      log(dim(`ready · ${msg.model} · ${msg.tools.length} tools`));
      if (msg.session_id !== sid) {
        // Session-id drift (resume minted a new id). Re-hello so the server
        // re-points the tail and the self-heal startup_cmd at the real id.
        log(dim(`session id drifted → ${msg.session_id}`));
        sendFrame({
          t: 'hello',
          sid: msg.session_id,
          cwd: process.cwd(),
          pid: process.pid,
          turnActive: inTurn,
        });
      }
    } else if (msg.type === 'stream_event') {
      const evt = msg.event as {
        type?: string;
        delta?: { type?: string; text?: string };
      };
      if (
        evt.type === 'content_block_delta' &&
        evt.delta?.type === 'text_delta' &&
        typeof evt.delta.text === 'string' &&
        msg.parent_tool_use_id === null
      ) {
        sendFrame({ t: 'stream', delta: evt.delta.text });
      }
    } else if (msg.type === 'assistant' && msg.parent_tool_use_id === null) {
      for (const block of msg.message.content ?? []) {
        if (block.type === 'text' && block.text.trim()) {
          log(`${bold('claude')} ${block.text.trim()}`);
        } else if (block.type === 'tool_use') {
          const arg = summarizeToolUse(block.name, block.input);
          log(`${dim('⚙')} ${block.name}${arg ? dim(` ${arg}`) : ''}`);
        }
      }
    } else if (msg.type === 'result') {
      inTurn = false;
      const ok = msg.subtype === 'success' || interruptRequested;
      const secs = (msg.duration_ms / 1000).toFixed(1);
      if (interruptRequested) {
        log(dim(`⏹ stopped after ${secs}s`));
        sendFrame({ t: 'turn-done', ok: true });
      } else if (msg.subtype === 'success') {
        log(dim(`✓ turn done · ${secs}s · $${msg.total_cost_usd.toFixed(2)}`));
        sendFrame({ t: 'turn-done', ok: true });
      } else {
        const error = msg.errors?.join('; ') || msg.subtype;
        log(`✗ turn failed: ${error}`);
        sendFrame({ t: 'turn-done', ok, error });
      }
      interruptRequested = false;
      kick(); // release the next queued send, if any
    }
  }
}

function shutdown(code: number): void {
  if (closed) return;
  closed = true;
  try {
    session.close();
  } catch {
    // already gone
  }
  try {
    ws?.close();
  } catch {
    // already gone
  }
  process.exit(code);
}

process.on('SIGTERM', () => shutdown(0));
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
