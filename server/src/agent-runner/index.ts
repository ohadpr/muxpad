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
import {
  type Options,
  type SDKUserMessage,
  createSdkMcpServer,
  query,
  tool,
} from '@anthropic-ai/claude-agent-sdk';
import { summarizeToolInput } from '@muxpad/shared';
import WebSocket from 'ws';
import { z } from 'zod';
import { findTranscript } from '../chat/TranscriptReader.js';
import {
  type AgentQuestion,
  type RunnerFrame,
  type ServerFrame,
  type SubagentProgress,
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

// --resume <sid> (written into the pane's startup_cmd by the server once the
// session exists, so a respawned pane resumes instead of minting a session).
let requestedSid: string | null = null;
{
  const args = process.argv.slice(2);
  const i = args.indexOf('--resume');
  if (i !== -1 && args[i + 1]) requestedSid = args[i + 1] as string;
}
// The self-heal startup_cmd is written on hello — BEFORE any turn — so a pane
// can respawn with `--resume <sid>` for a session that never wrote a
// transcript. `resume` on a transcript-less sid kills the session ("no
// conversation found"); start fresh UNDER that id instead, exactly like the
// headless runner's fresh-mode fallback. Either way the pane keeps the id.
const resumeSid = requestedSid && findTranscript(requestedSid) ? requestedSid : null;
if (requestedSid && !resumeSid) {
  console.log(`no transcript yet for ${requestedSid} — starting the session fresh under that id`);
}
const sid = requestedSid ?? randomUUID();

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

// ---------------------------------------------------------------------------
// ask_user: the chat-native question tool. Claude Code's own AskUserQuestion
// is not offered to SDK-hosted sessions (spike-verified), so the runner
// provides an equivalent through the SDK's in-process MCP server: the model
// calls it, the question renders as tappable chips in the chat UI, and the
// tool call blocks until the answer frame comes back (or the turn is
// interrupted — Stop resolves it so the session never wedges).
// ---------------------------------------------------------------------------
interface PendingQuestion {
  qid: string;
  /** The frame, kept so a server reconnect can re-deliver the question. */
  frame: RunnerFrame & { t: 'question' };
  resolve: (answers: Array<{ question: string; answers: string[] }> | null) => void;
}
const pendingQuestions = new Map<string, PendingQuestion>();

function resolveAllQuestions(reason: 'interrupted' | 'shutdown'): void {
  for (const [qid, pq] of pendingQuestions) {
    pendingQuestions.delete(qid);
    sendFrame({ t: 'question-done', qid });
    log(dim(`question dismissed (${reason})`));
    pq.resolve(null);
  }
}

const OptionSchema = z.object({
  label: z.string().min(1).max(80).describe('Concise display text (1–5 words)'),
  description: z.string().max(300).optional().describe('What choosing this means'),
});
const QuestionSchema = z.object({
  question: z
    .string()
    .min(1)
    .max(500)
    .describe('The complete question, ending with a question mark'),
  header: z.string().min(1).max(16).describe('Very short chip label, e.g. "Approach"'),
  multiSelect: z.boolean().optional().describe('Allow selecting multiple options'),
  options: z.array(OptionSchema).min(2).max(5),
});

const askUserTool = tool(
  'ask_user',
  'Ask the user 1–3 multiple-choice questions when you are blocked on a decision only they can make. Each question renders as tappable options in the muxpad chat UI (the user may also type a custom answer). Use it sparingly: for reversible choices with a sensible default, proceed without asking.',
  { questions: z.array(QuestionSchema).min(1).max(3) },
  async (args) => {
    const qid = randomUUID();
    const questions: AgentQuestion[] = args.questions.map((qq) => ({
      question: qq.question,
      header: qq.header,
      multiSelect: qq.multiSelect === true,
      options: qq.options.map((o) => ({
        label: o.label,
        ...(o.description ? { description: o.description } : {}),
      })),
    }));
    log(`${bold('? asking user')} ${questions.map((qq) => qq.header).join(', ')}`);
    const answers = await new Promise<Array<{ question: string; answers: string[] }> | null>(
      (resolve) => {
        const frame = { t: 'question', qid, questions } as const;
        pendingQuestions.set(qid, { qid, frame, resolve });
        sendFrame(frame);
      },
    );
    if (!answers) {
      return {
        content: [
          { type: 'text' as const, text: 'The user dismissed the question without answering.' },
        ],
      };
    }
    const text = answers
      .map((a) => `${a.question}\n→ ${a.answers.join(', ') || '(no selection)'}`)
      .join('\n\n');
    log(dim(`answered: ${answers.map((a) => a.answers.join(', ')).join(' · ')}`));
    return { content: [{ type: 'text' as const, text }] };
  },
);

// ---------------------------------------------------------------------------
// Subagent progress. Subagent messages arrive on the same stream with
// parent_tool_use_id set; count them per task and forward a throttled live
// status so the chat's Task row shows "running · N steps · lastTool" instead
// of sitting inert for minutes.
// ---------------------------------------------------------------------------
const subagents = new Map<string, SubagentProgress & { lastSentAt: number; dirty: boolean }>();

function noteSubagentActivity(parentToolUseId: string, lastTool?: string): void {
  let p = subagents.get(parentToolUseId);
  if (!p) {
    p = { toolUseId: parentToolUseId, steps: 0, lastSentAt: 0, dirty: false };
    subagents.set(parentToolUseId, p);
  }
  p.steps++;
  if (lastTool) p.lastTool = lastTool;
  p.dirty = true;
  const now = Date.now();
  if (now - p.lastSentAt >= 500) {
    p.lastSentAt = now;
    p.dirty = false;
    const { lastSentAt, dirty, ...progress } = p;
    sendFrame({ t: 'subagent', progress });
  }
}

/** Flush any throttled-but-unsent progress, then drop the counters. */
function flushSubagents(): void {
  for (const p of subagents.values()) {
    if (p.dirty) {
      const { lastSentAt, dirty, ...progress } = p;
      sendFrame({ t: 'subagent', progress });
    }
  }
  subagents.clear();
}

// ---------------------------------------------------------------------------
// Self-titling. Interactive Claude Code writes `ai-title` records into the
// transcript; SDK-hosted sessions don't (verified: no ai-title lines, and
// getSessionInfo().summary just echoes the first prompt). So after the first
// completed turn of a FRESH session, generate a title ourselves with a cheap
// one-shot haiku query and send it to the server, which names the pane/tab
// (user renames always win there). Fire-and-forget — never blocks the queue.
// ---------------------------------------------------------------------------
let firstUserText: string | null = null;
let firstAssistantText = '';
let titleGenerated = false;

async function generateTitle(): Promise<void> {
  if (titleGenerated || !firstUserText) return;
  titleGenerated = true;
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 60_000);
  try {
    const prompt = `Generate a concise 3–6 word title for this conversation, in its language. Reply with ONLY the title — no quotes, no trailing punctuation.\n\nUser: ${firstUserText.slice(0, 500)}\n\nAssistant: ${firstAssistantText.slice(0, 500)}`;
    const one = query({
      prompt,
      options: {
        model: 'haiku',
        maxTurns: 1,
        // Bare completion: no user/project settings, no MCP, no tools.
        settingSources: [],
        allowedTools: [],
        abortController: abort,
      },
    });
    let title = '';
    for await (const m of one) {
      if (m.type === 'result' && m.subtype === 'success') title = m.result;
    }
    title = title
      .trim()
      .replace(/^["'“”]+|["'“”.]+$/g, '')
      .replace(/\s+/g, ' ')
      .slice(0, 60)
      .trim();
    if (!title) return;
    log(dim(`titled: ${title}`));
    sendFrame({ t: 'title', title });
    process.stdout.write(`\x1b]0;✳ ${title}\x07`);
  } catch (e) {
    log(dim(`title generation failed: ${e instanceof Error ? e.message : String(e)}`));
  } finally {
    clearTimeout(timeout);
  }
}

async function* userMessages(): AsyncGenerator<SDKUserMessage> {
  while (true) {
    while (!inTurn && pendingTexts.length > 0) {
      const text = pendingTexts.shift() as string;
      if (firstUserText === null) firstUserText = text;
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
// The id the live session actually runs under — updated if a resume drifts.
let liveSid = sid;

function sendFrame(frame: RunnerFrame): void {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
}

const helloFrame = (): RunnerFrame => ({
  t: 'hello',
  sid: liveSid,
  cwd: process.cwd(),
  pid: process.pid,
  turnActive: inTurn,
});

function connect(): void {
  if (closed) return;
  const sock = new WebSocket(wsUrl);
  ws = sock;
  sock.on('open', () => {
    log(dim('connected to muxpad'));
    sendFrame(helloFrame());
    // The server's per-connection state starts empty — re-deliver any
    // question still blocking the turn so chat clients regain it after a
    // server restart or ws blip, and the latest status so the chat header
    // isn't blank until the next turn.
    for (const pq of pendingQuestions.values()) sendFrame(pq.frame);
    if (lastStatus) sendFrame(lastStatus);
  });
  sock.on('message', (data) => {
    const frame = parseFrame<ServerFrame>(data);
    if (!frame) return;
    if (frame.t === 'send' && typeof frame.text === 'string' && frame.text.trim()) {
      pendingTexts.push(frame.text);
      kick();
    } else if (frame.t === 'set-model') {
      if (typeof frame.model === 'string' && frame.model) {
        session
          .setModel(frame.model)
          .then(() => {
            log(`${bold('model')} → ${frame.model}`);
            return refreshStatus(false);
          })
          .catch((e: unknown) => {
            log(dim(`set-model failed: ${e instanceof Error ? e.message : String(e)}`));
          });
      }
    } else if (frame.t === 'slash') {
      // Session-management commands ride the normal turn queue so turn
      // accounting stays exact (the CLI executes them in-band).
      if (frame.cmd === 'compact' || frame.cmd === 'clear') {
        log(dim(`/${frame.cmd} requested from chat`));
        pendingTexts.push(`/${frame.cmd}`);
        kick();
      }
    } else if (frame.t === 'stop') {
      if (inTurn) {
        interruptRequested = true;
        log(dim('⏹ interrupt requested'));
        // A turn parked on ask_user must unblock first or the interrupt has
        // nothing to land on but the tool call.
        resolveAllQuestions('interrupted');
        session.interrupt().catch((e: unknown) => {
          log(dim(`interrupt failed: ${e instanceof Error ? e.message : String(e)}`));
        });
      }
    } else if (frame.t === 'answer') {
      const pq = pendingQuestions.get(frame.qid);
      if (pq) {
        pendingQuestions.delete(frame.qid);
        sendFrame({ t: 'question-done', qid: frame.qid });
        pq.resolve(Array.isArray(frame.answers) ? frame.answers : null);
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
  // The chat-native question tool (Claude Code's own AskUserQuestion is not
  // offered to SDK sessions). alwaysLoad keeps it in the prompt rather than
  // behind tool search — it must be discoverable at the moment of doubt.
  mcpServers: {
    muxpad: createSdkMcpServer({ name: 'muxpad', tools: [askUserTool], alwaysLoad: true }),
  },
  // No settingSources override: default = user+project+local settings,
  // CLAUDE.md, skills, MCP — same session the terminal TUI would run.
};

const session = query({ prompt: userMessages(), options });

// ---------------------------------------------------------------------------
// Session status for the chat header: model + context-window fill (+ the
// model list on the first frame). Refreshed after init, after every turn,
// and after a model switch; cached for re-delivery on reconnect.
// ---------------------------------------------------------------------------
let lastStatus: (RunnerFrame & { t: 'status' }) | null = null;
let modelList: Array<{ value: string; displayName: string; resolvedModel?: string }> | null = null;

async function refreshStatus(includeModels: boolean): Promise<void> {
  try {
    if ((includeModels && !modelList) || modelList === null) {
      const models = await session.supportedModels();
      modelList = models.map((m) => ({
        value: m.value,
        displayName: m.displayName,
        ...(m.resolvedModel ? { resolvedModel: m.resolvedModel } : {}),
      }));
    }
    const usage = await session.getContextUsage();
    const frame: RunnerFrame & { t: 'status' } = {
      t: 'status',
      model: usage.model,
      context: {
        pct: Math.round(usage.percentage),
        tokens: usage.totalTokens,
        max: usage.maxTokens,
      },
      // The list rides every status frame — it's small, and the server keeps
      // only the latest frame for reconnecting chat clients.
      ...(modelList ? { models: modelList } : {}),
    };
    lastStatus = frame;
    sendFrame(frame);
  } catch (e) {
    // Status is decoration — never let it break the session loop.
    log(dim(`status refresh failed: ${e instanceof Error ? e.message : String(e)}`));
  }
}

// Long agentic turns grow the context for minutes between results — refresh
// mid-turn too so the chat's fill meter tracks live instead of only moving
// at rest. Guarded to skip when a refresh is already in flight (control
// requests are async against a busy session).
let statusRefreshing = false;
setInterval(() => {
  if (!inTurn || statusRefreshing) return;
  statusRefreshing = true;
  void refreshStatus(false).finally(() => {
    statusRefreshing = false;
  });
}, 20_000);

async function main(): Promise<void> {
  connect();
  // Resumed sessions don't emit `init` until their first turn — without a
  // boot-time fetch the chat's session chip stays blank until the user
  // sends something. Two attempts, in case the control channel needs a
  // moment (refreshStatus swallows failures).
  setTimeout(() => {
    if (!lastStatus) void refreshStatus(true);
  }, 3000);
  setTimeout(() => {
    if (!lastStatus) void refreshStatus(true);
  }, 15000);
  // Name the pty deliberately (OSC 0) — otherwise the pane label falls back
  // to whatever the shell last set ("muxpad", the node path, …). The pane's
  // persistent NAME gets the session's AI title via the transcript tail.
  process.stdout.write('\x1b]0;\u2733 agent\x07');
  log(`${bold('muxpad agent')} — session ${sid}${resumeSid ? ' (resumed)' : ''}`);
  log(dim(`pane ${paneId} · ${process.cwd()}`));
  log(dim('drive this session from the pane’s Chat face; this log is the terminal face'));

  // A turn can also start WITHOUT a user send: scheduled wakeups and crons
  // fire autonomously inside the persistent session (live-verified). Emit
  // turn-start on the first activity so chat shows the typing indicator, the
  // busy dot lights, and Stop works for those turns too.
  const noteAutonomousTurn = () => {
    if (inTurn) return;
    inTurn = true;
    interruptRequested = false;
    sendFrame({ t: 'turn-start' });
    log(dim('▸ autonomous turn (wakeup/cron/background)'));
  };

  for await (const msg of session) {
    if (msg.type === 'system' && msg.subtype === 'init') {
      log(dim(`ready · ${msg.model} · ${msg.tools.length} tools`));
      void refreshStatus(true);
      if (msg.session_id !== liveSid) {
        // Session-id drift (resume minted a new id). Re-hello so the server
        // re-points the tail and the self-heal startup_cmd at the real id.
        log(dim(`session id drifted → ${msg.session_id}`));
        liveSid = msg.session_id;
        sendFrame(helloFrame());
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
        noteAutonomousTurn();
        sendFrame({ t: 'stream', delta: evt.delta.text });
      }
    } else if (msg.type === 'assistant' && msg.parent_tool_use_id === null) {
      noteAutonomousTurn();
      for (const block of msg.message.content ?? []) {
        if (block.type === 'text' && block.text.trim()) {
          if (!titleGenerated && firstAssistantText.length < 500) {
            firstAssistantText += `${block.text.trim()}\n`;
          }
          log(`${bold('claude')} ${block.text.trim()}`);
        } else if (block.type === 'tool_use') {
          const arg = summarizeToolInput(block.name, block.input);
          log(`${dim('⚙')} ${block.name}${arg ? dim(` ${arg}`) : ''}`);
        }
      }
    } else if (
      (msg.type === 'assistant' || msg.type === 'user') &&
      typeof msg.parent_tool_use_id === 'string'
    ) {
      // Subagent traffic: surface live progress on the parent Task row.
      let lastTool: string | undefined;
      if (msg.type === 'assistant') {
        for (const block of msg.message.content ?? []) {
          if (block.type === 'tool_use') {
            const arg = summarizeToolInput(block.name, block.input);
            lastTool = arg ? `${block.name}: ${arg}` : block.name;
          }
        }
      }
      noteSubagentActivity(msg.parent_tool_use_id, lastTool);
    } else if (msg.type === 'result') {
      inTurn = false;
      // Belt-and-braces: no question outlives its turn, and subagent
      // counters reset (their Task rows resolve via the transcript).
      resolveAllQuestions('interrupted');
      flushSubagents();
      const ok = msg.subtype === 'success' || interruptRequested;
      const secs = (msg.duration_ms / 1000).toFixed(1);
      if (interruptRequested) {
        log(dim(`⏹ stopped after ${secs}s`));
        sendFrame({ t: 'turn-done', ok: true });
      } else if (msg.subtype === 'success') {
        log(dim(`✓ turn done · ${secs}s · $${msg.total_cost_usd.toFixed(2)}`));
        sendFrame({ t: 'turn-done', ok: true });
        // First completed turn of a fresh session: self-title (resumed
        // sessions keep whatever name their pane/tab already carries).
        if (!resumeSid && !titleGenerated) void generateTitle();
      } else {
        const error = msg.errors?.join('; ') || msg.subtype;
        log(`✗ turn failed: ${error}`);
        sendFrame({ t: 'turn-done', ok, error });
      }
      interruptRequested = false;
      kick(); // release the next queued send, if any
      void refreshStatus(false); // context fill changed with the turn
    }
  }
}

function shutdown(code: number): void {
  if (closed) return;
  closed = true;
  resolveAllQuestions('shutdown');
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
