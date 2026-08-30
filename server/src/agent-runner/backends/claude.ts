// Claude backend — the Anthropic Agent SDK behind the AgentBackend seam. This
// is the entire Claude/SDK surface of the runner: a persistent streaming
// `query()` session, the in-process MCP question/show-files tools, subagent
// progress, self-titling, the context/model status meter, and the turn queue.
// The harness (../index.ts) owns everything provider-neutral and drives this
// through the AgentBackend methods; this file emits frames via `host.emit`.
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import {
  type Options,
  type SDKUserMessage,
  createSdkMcpServer,
  query,
  tool,
} from '@anthropic-ai/claude-agent-sdk';
import {
  LAUNCH_ACK_RE,
  blockText,
  isAgentLaunchTool,
  subagentLabel,
  summarizeToolInput,
  taskNotificationToolUseId,
} from '@muxpad/shared';
import { z } from 'zod';
import { readAgentInstructions } from '../../agent-instructions.js';
import { readDoModeOverlay, wrapModeNote } from '../../agent-modes.js';
import { findTranscript } from '../../chat/TranscriptReader.js';
import { bold, dim } from '../ansi.js';
import type { AgentMode, AgentQuestion, RunnerFrame } from '../protocol.js';
import { SubagentRoster } from '../subagent-roster.js';
import type { AgentBackend, BackendOptions, RunnerHost } from './types.js';

// Default model for a FRESH agent chat with no explicit `--model` pin: muxpad
// starts new chats on Opus rather than the account/settings default. A resume
// deliberately gets NO default (undefined) so an existing session keeps the
// model it was running — this only steers brand-new chats. Still switchable
// per-session via the model picker (set-model).
const DEFAULT_AGENT_MODEL = 'opus';

/**
 * The universal muxpad instructions (<dataDir>/agent-instructions.md) PLUS —
 * when the pane launched in ⚡ Do mode — the Do-mode overlay
 * (<dataDir>/do-mode.md), as an SDK `systemPrompt` option.
 *
 * Injection mechanism for the CLAUDE backend, identical for both blocks: the
 * Agent SDK's NATIVE preset+append — the default claude_code system prompt
 * (with CLAUDE.md, settings, skills all loading exactly as before) plus our
 * text appended. Both files missing/empty → undefined, and the option is
 * omitted entirely (inject nothing, no error).
 *
 * Order matters: the standing instructions describe muxpad's CAPABILITIES,
 * the mode overlay describes HOW to behave. Behavior last, so it reads as the
 * most recent (and therefore governing) instruction.
 *
 * Exported for tests: constructing the backend spawns a real SDK session, so
 * the option-building is the testable seam.
 */
export function claudeSystemPromptOption(
  instructions: string | null,
  modeOverlay: string | null = null,
): Options['systemPrompt'] | undefined {
  const append = [instructions, modeOverlay]
    .filter((s): s is string => !!s?.trim())
    .map((s) => s.trim())
    .join('\n\n');
  return append ? { type: 'preset', preset: 'claude_code', append } : undefined;
}

// ─── The SDK's task lifecycle → the subagent roster ─────────────────────────
// The SDK reports background work on its own channel, independent of the
// message stream: `task_started` / `task_notification` / `task_updated` edges
// and `background_tasks_changed`, the full live-set LEVEL. That channel is the
// roster's source of truth — the message-shape recognisers (a `Task` tool_use,
// a `<task-notification>` text) only cover what the CONVERSATION happens to
// show, and a background agent's end is routinely not in it.
//
// Split out of the session loop because constructing this backend spawns a real
// SDK session: this is the only way the message SHAPES — every one of whose
// id fields is optional — get a unit test.

const TASK_LIFECYCLE_SUBTYPES = new Set([
  'task_started',
  'task_notification',
  'task_updated',
  'background_tasks_changed',
]);

export function isTaskLifecycle(subtype: string): boolean {
  return TASK_LIFECYCLE_SUBTYPES.has(subtype);
}

/** The fields we read, all optional exactly as the SDK declares them. */
export interface TaskLifecycleMessage {
  subtype: string;
  task_id?: string;
  tool_use_id?: string;
  tasks?: Array<{ task_id: string }>;
  patch?: { status?: string };
}

/** Task ids whose `task_updated` means the task is OVER. */
const TERMINAL_TASK_STATUSES = new Set(['completed', 'failed', 'killed']);

export function applyTaskLifecycle(roster: SubagentRoster, msg: TaskLifecycleMessage): void {
  switch (msg.subtype) {
    case 'task_started':
      // Binds task id ↔ launching tool_use. Ids we never launched (nested
      // agents, background Bash) are ignored inside bindTask.
      if (msg.tool_use_id && msg.task_id) roster.bindTask(msg.tool_use_id, msg.task_id);
      break;
    case 'task_notification':
      // BOTH keys: `tool_use_id` is optional on this message and `task_id` is
      // not, so keying only on the former would leave an entry with no edge
      // end-path at all whenever the SDK omits it.
      if (msg.tool_use_id) roster.done(msg.tool_use_id);
      if (msg.task_id) roster.doneByTaskId(msg.task_id);
      break;
    case 'task_updated': {
      if (!msg.task_id) break;
      const status = msg.patch?.status;
      if (status && TERMINAL_TASK_STATUSES.has(status)) roster.doneByTaskId(msg.task_id);
      // A paused task may leave the live set without dying — see pauseTask.
      else if (status === 'paused') roster.pauseTask(msg.task_id);
      break;
    }
    case 'background_tasks_changed':
      roster.reconcileBackground((msg.tasks ?? []).map((t) => t.task_id));
      break;
  }
}

export function createClaudeBackend(host: RunnerHost, opts: BackendOptions): AgentBackend {
  const { emit, log } = host;
  const { requestedSid, requestedModel } = opts;

  // ── Agent mode (⚡ do / 🧠 deep) ──────────────────────────────────────────
  // The LAUNCH mode is the only one that can reach the SDK as system-prompt
  // material (systemPrompt is fixed at query() construction and the Query
  // control surface has no prompt mutator — see agent-modes.ts). A later
  // switch sets `pendingModeNote`, which rides the next user message as a
  // delimited <muxpad-mode> block.
  let currentMode: AgentMode = opts.mode;
  let pendingModeNote: string | null = null;
  function setMode(next: AgentMode): void {
    if (next === currentMode) return;
    currentMode = next;
    pendingModeNote = wrapModeNote(next, readDoModeOverlay(next));
    log(dim(`mode → ${next} (applies from the next message; the live system prompt is fixed)`));
  }

  // The self-heal startup_cmd is written on hello — BEFORE any turn — so a pane
  // can respawn with `--resume <sid>` for a session that never wrote a
  // transcript. `resume` on a transcript-less sid kills the session ("no
  // conversation found"); start fresh UNDER that id instead, exactly like the
  // headless runner's fresh-mode fallback. Either way the pane keeps the id.
  const resumeSid = requestedSid && findTranscript(requestedSid) ? requestedSid : null;
  if (requestedSid && !resumeSid) {
    log(`no transcript yet for ${requestedSid} — starting the session fresh under that id`);
  }
  const sid = requestedSid ?? randomUUID();
  // The id the live session actually runs under — updated if a resume drifts.
  let liveSid = sid;

  // -------------------------------------------------------------------------
  // Turn queue. Sends arriving from chat are serialized: one user turn in
  // flight at a time, the next yielded to the SDK only after the previous
  // turn's result. (The SDK would accept queued messages, but merging/queuing
  // semantics are its own; explicit serialization keeps turn-start/turn-done
  // accounting exact for the chat UI.)
  // -------------------------------------------------------------------------
  const pendingTexts: string[] = [];
  let inTurn = false;
  // Timestamp of the last message seen from the SDK session — the "is a query
  // actually alive" signal the failed-interrupt disambiguation relies on.
  // NOTE: silent stretches inside a long tool call don't advance it, so the
  // quiet-window reset can false-positive there — which is why it never
  // kick()s the queue (see the stop handler).
  let lastSessionActivityAt = 0;
  // The single pending quiet-window check for a failed interrupt.
  let interruptFailTimer: ReturnType<typeof setTimeout> | null = null;
  let interruptRequested = false;
  let wakeQueue: (() => void) | null = null;
  const kick = () => {
    wakeQueue?.();
    wakeQueue = null;
  };

  // -------------------------------------------------------------------------
  // ask_user: the chat-native question tool. Claude Code's own AskUserQuestion
  // is not offered to SDK-hosted sessions (spike-verified), so the runner
  // provides an equivalent through the SDK's in-process MCP server: the model
  // calls it, the question renders as tappable chips in the chat UI, and the
  // tool call blocks until the answer frame comes back (or the turn is
  // interrupted — Stop resolves it so the session never wedges).
  // -------------------------------------------------------------------------
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
      emit({ t: 'question-done', qid });
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
          emit(frame);
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

  // Let the agent SHOW files in the chat: screenshots, videos, or documents.
  // Each local path is copied (server-side, disk-to-disk) into the pane's
  // served attachment dir; the returned served paths go verbatim into the
  // agent's reply, where muxpad renders them by type — images/videos inline
  // (multiple → a gallery), other files as a click-to-open chip. No server to
  // start, no Linear round-trip.
  const showFilesTool = tool(
    'show_files',
    'Show files to the user directly in THIS chat: screenshots, images, videos (mp4/webm), or documents (pdf, csv, txt, json, …). Save the file(s) locally first (e.g. `screencapture`, an ffmpeg/webm recording, or write a report), then pass their ABSOLUTE paths. Each is served and a path returned; include those returned paths in your reply — one per line, bare paths (not markdown links) — and they render inline: images/videos as thumbnails (several → a gallery), other files as a download chip. Use whenever the user asks to see/be shown something, or when a file is the best way to share output.',
    {
      paths: z
        .array(z.string())
        .min(1)
        .describe('Absolute paths of local files to show (images, videos, or documents).'),
    },
    async (args) => {
      const served: string[] = [];
      const failed: string[] = [];
      for (const p of args.paths) {
        try {
          const res = await fetch(`${host.apiUrl}/api/panes/${host.paneId}/attachments/by-path`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path: p }),
          });
          if (!res.ok) {
            failed.push(`${basename(p)} (${res.status}: ${(await res.text()).slice(0, 120)})`);
            continue;
          }
          const { path } = (await res.json()) as { path: string };
          served.push(path);
        } catch (err) {
          failed.push(`${basename(p)} (${(err as Error).message})`);
        }
      }
      log(
        `${bold('▸ show_files')} ${dim(`${served.length} shown${failed.length ? `, ${failed.length} failed` : ''}`)}`,
      );
      if (served.length === 0)
        return {
          content: [
            { type: 'text' as const, text: `Could not show any file: ${failed.join('; ')}` },
          ],
          isError: true,
        };
      const lines = [
        'Displayed to the user. Include these exact paths in your reply — one per line, bare paths (not markdown links) — so they render inline:',
        ...served,
      ];
      if (failed.length) lines.push(`(Failed: ${failed.join('; ')})`);
      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    },
  );

  // -------------------------------------------------------------------------
  // Subagent roster. Subagent messages arrive on the same stream with
  // parent_tool_use_id set; count them per task and forward throttled live
  // progress so the chat's Task row shows "running · N steps · lastTool"
  // instead of sitting inert for minutes.
  //
  // The lifecycle rules (durable, no decay window, the four end-paths that
  // make that safe, and why membership is top-level launches ONLY) live in
  // SubagentRoster — extracted so they are testable without spawning a real
  // SDK session.
  // -------------------------------------------------------------------------
  const subagents = new SubagentRoster(
    (progress) => emit({ t: 'subagent', progress }),
    (line) => log(dim(line)),
  );
  /** How often a live roster entry re-announces itself when the SDK is silent. */
  const SUBAGENT_KEEPALIVE_MS = 5_000;
  // Keepalive: re-announce every live entry on a fixed tick so the server's
  // copy (and the per-row busy dot) stays fresh through the long silent tool
  // calls the P1 experiment measured. Cheap — one small frame per live
  // subagent per tick, and nothing at all when the roster is empty.
  const subagentKeepalive = setInterval(() => subagents.announceAll(), SUBAGENT_KEEPALIVE_MS);
  subagentKeepalive.unref?.();

  // -------------------------------------------------------------------------
  // Self-titling. Interactive Claude Code writes `ai-title` records into the
  // transcript; SDK-hosted sessions don't (verified: no ai-title lines, and
  // getSessionInfo().summary just echoes the first prompt). So after the first
  // completed turn of a FRESH session, generate a title ourselves with a cheap
  // one-shot haiku query and send it to the server, which names the pane/tab
  // (user renames always win there). Fire-and-forget — never blocks the queue.
  // -------------------------------------------------------------------------
  let firstUserText: string | null = null;
  let firstAssistantText = '';
  let titleGenerated = false;
  // The current turn's most recent assistant prose — rides along on turn-done so
  // the push notification can say WHAT the agent finished with, not just "done".
  let lastAssistantText = '';

  /** One-line snippet of assistant prose for a push body — strip the loudest
   *  markdown, collapse whitespace, truncate. Empty → undefined (caller falls
   *  back to a generic line). */
  function notifySnippet(text: string): string | undefined {
    const s = text
      .replace(/```[\s\S]*?```/g, ' ') // fenced code
      .replace(/`([^`]+)`/g, '$1') // inline code
      .replace(/\*\*|__|\*|_/g, '') // emphasis
      .replace(/^\s{0,3}#{1,6}\s+/gm, '') // heading markers
      .replace(/^\s*[-*>]\s+/gm, '') // list / quote markers
      .replace(/\s+/g, ' ')
      .trim();
    if (!s) return undefined;
    return s.length > 120 ? `${s.slice(0, 120)}…` : s;
  }

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
      emit({ t: 'title', title });
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
        lastAssistantText = '';
        emit({ t: 'turn-start' });
        log(`${bold('▸ user')} ${text.length > 200 ? `${text.slice(0, 200)}…` : text}`);
        // A pending mode switch rides the next REAL message. Slash commands
        // (`/compact`, `/clear`) are executed in-band by the CLI and must
        // reach it as the bare command — prefixing one would turn it into
        // ordinary prose — so the note stays pending past them.
        let content = text;
        if (pendingModeNote && !text.startsWith('/')) {
          content = `${pendingModeNote}\n\n${text}`;
          pendingModeNote = null;
        }
        yield {
          type: 'user',
          message: { role: 'user', content },
          parent_tool_use_id: null,
        };
      }
      await new Promise<void>((r) => {
        wakeQueue = r;
      });
    }
  }

  // -------------------------------------------------------------------------
  // The Claude session. Streaming input keeps ONE process alive across every
  // turn — so in-session state (scheduled wakeups, background tasks, warm
  // context) survives between chat messages, which per-turn `claude -p` spawns
  // structurally could not.
  // -------------------------------------------------------------------------
  const startModel = requestedModel ?? (resumeSid ? null : DEFAULT_AGENT_MODEL);

  // Universal muxpad instructions + the launch mode's overlay, read at
  // injection time (session construction). Applies to fresh AND resumed
  // sessions alike — it's session-level system-prompt material, not a
  // message. 'deep' contributes nothing, so a deep pane's prompt is byte-for-
  // byte what it was before modes existed.
  const muxpadSystemPrompt = claudeSystemPromptOption(
    readAgentInstructions(),
    readDoModeOverlay(currentMode),
  );

  const options: Options = {
    cwd: process.cwd(),
    ...(resumeSid ? { resume: resumeSid } : { sessionId: sid }),
    // Yolo parity with `muxpad claude --dangerously-skip-permissions`. The SDK
    // auto-approves every tool call under bypass (canUseTool is never consulted
    // — spike-verified), so no permission prompt can wedge a headless turn.
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    includePartialMessages: true,
    // Model: an explicit `--model <m>` pin wins; else a fresh chat gets
    // DEFAULT_AGENT_MODEL (Opus) and a resume keeps its own model.
    ...(startModel ? { model: startModel } : {}),
    // The chat-native question tool (Claude Code's own AskUserQuestion is not
    // offered to SDK sessions). alwaysLoad keeps it in the prompt rather than
    // behind tool search — it must be discoverable at the moment of doubt.
    mcpServers: {
      muxpad: createSdkMcpServer({
        name: 'muxpad',
        tools: [askUserTool, showFilesTool],
        alwaysLoad: true,
      }),
    },
    // Universal agent instructions (<dataDir>/agent-instructions.md) appended
    // to the DEFAULT claude_code system prompt — see claudeSystemPromptOption.
    ...(muxpadSystemPrompt ? { systemPrompt: muxpadSystemPrompt } : {}),
    // No settingSources override: default = user+project+local settings,
    // CLAUDE.md, skills, MCP — same session the terminal TUI would run.
  };

  const session = query({ prompt: userMessages(), options });

  // -------------------------------------------------------------------------
  // Session status for the chat header: model + context-window fill (+ the
  // model list on the first frame). Refreshed after init, after every turn,
  // and after a model switch; cached for re-delivery on reconnect.
  // -------------------------------------------------------------------------
  let lastStatus: (RunnerFrame & { t: 'status' }) | null = null;
  let modelList: Array<{ value: string; displayName: string; resolvedModel?: string }> | null =
    null;
  // The CONCRETE model the session is actually running (e.g. 'claude-opus-4-8'),
  // captured from the init frame and every assistant message. getContextUsage()
  // reports only the ALIAS ('opus'), so this is the sole reliable source of the
  // exact version — the chat's own self-report is unreliable. Rides the status
  // frame so the picker/chip can show precisely which model is live.
  let activeModel: string | null = null;

  // Single-flight across ALL callers (init, turn-done, interval, set-model,
  // boot) — concurrent control requests buy nothing and race lastStatus.
  let statusInFlight: Promise<void> | null = null;
  // Bumped when the session id rotates (/clear); an in-flight refresh started
  // against the OLD session must not land its numbers on the new one.
  let statusEpoch = 0;

  function refreshStatus(refetchModels: boolean): Promise<void> {
    if (statusInFlight) return statusInFlight;
    const epoch = statusEpoch;
    statusInFlight = (async () => {
      // The model list is fetched independently of the usage numbers: a failed
      // or unsupported supportedModels() must not gate the context meter, and
      // must not be retried forever — only refetch when explicitly asked (or
      // never yet fetched).
      let freshModels = false;
      if (refetchModels || modelList === null) {
        try {
          const models = await session.supportedModels();
          modelList = models.map((m) => ({
            value: m.value,
            displayName: m.displayName,
            ...(m.resolvedModel ? { resolvedModel: m.resolvedModel } : {}),
          }));
          freshModels = true;
        } catch (e) {
          log(dim(`model list fetch failed: ${e instanceof Error ? e.message : String(e)}`));
          if (modelList === null) modelList = []; // don't retry a doomed call on every tick
        }
      }
      try {
        const usage = await session.getContextUsage();
        if (epoch !== statusEpoch) return; // session rotated mid-fetch — stale numbers
        const frame: RunnerFrame & { t: 'status' } = {
          t: 'status',
          model: usage.model,
          // The exact concrete model (getContextUsage reports only the alias).
          ...(activeModel ? { activeModel } : {}),
          context: {
            pct: Math.round(usage.percentage),
            tokens: usage.totalTokens,
            max: usage.maxTokens,
          },
          // The list rides only frames where it was (re)fetched; the server
          // merges frames so reconnect hellos keep the last known list.
          ...(freshModels && modelList && modelList.length > 0 ? { models: modelList } : {}),
        };
        // Unchanged numbers → nothing to say (the 20s tick during a quiet tool
        // call would otherwise re-broadcast a no-op to every open chat).
        const changed =
          !lastStatus ||
          lastStatus.model !== frame.model ||
          lastStatus.activeModel !== frame.activeModel ||
          lastStatus.context?.pct !== frame.context?.pct ||
          lastStatus.context?.tokens !== frame.context?.tokens ||
          freshModels;
        // The CACHE always carries the model list (a reconnect re-delivers
        // lastStatus as the server's whole snapshot — without the list the
        // chip loses its picker and shows raw ids); the WIRE frame stays slim.
        lastStatus = {
          ...frame,
          ...(modelList && modelList.length > 0 ? { models: modelList } : {}),
        };
        if (changed) emit(frame);
      } catch (e) {
        // Status is decoration — never let it break the session loop.
        log(dim(`status refresh failed: ${e instanceof Error ? e.message : String(e)}`));
      }
    })().finally(() => {
      statusInFlight = null;
    });
    return statusInFlight;
  }

  // Long agentic turns grow the context for minutes between results — refresh
  // mid-turn too so the chat's fill meter tracks live instead of only moving at
  // rest. Skipped while disconnected (the frame would drop; reconnect re-sends
  // lastStatus); the single-flight above dedups against other callers.
  const statusInterval = setInterval(() => {
    if (inTurn && host.connected()) void refreshStatus(false);
  }, 20_000);

  function hello(): RunnerFrame {
    return {
      t: 'hello',
      sid: liveSid,
      cwd: process.cwd(),
      pid: process.pid,
      turnActive: inTurn,
      backend: 'claude',
    };
  }

  // -------------------------------------------------------------------------
  // AgentBackend surface.
  // -------------------------------------------------------------------------
  function send(text: string): void {
    pendingTexts.push(text);
    kick();
  }

  function slash(cmd: 'compact' | 'clear'): void {
    // Session-management commands ride the normal turn queue so turn accounting
    // stays exact (the CLI executes them in-band).
    log(dim(`/${cmd} requested from chat`));
    pendingTexts.push(`/${cmd}`);
    kick();
  }

  function setModel(model: string): void {
    session
      .setModel(model)
      .then(() => {
        log(`${bold('model')} → ${model}`);
        return refreshStatus(false);
      })
      .catch((e: unknown) => {
        log(dim(`set-model failed: ${e instanceof Error ? e.message : String(e)}`));
      });
  }

  function stop(): void {
    // Stop always empties the queue — a user pressing Stop wants pending
    // messages cancelled, not delivered into whatever runs next. This also
    // covers the send-then-immediate-stop pattern where the send is queued
    // but its turn hasn't started yet.
    const hadQueued = pendingTexts.length > 0;
    pendingTexts.length = 0;
    if (inTurn) {
      interruptRequested = true;
      log(dim('⏹ interrupt requested'));
      // A turn parked on ask_user must unblock first or the interrupt has
      // nothing to land on but the tool call.
      resolveAllQuestions('interrupted');
      session.interrupt().catch((e: unknown) => {
        log(dim(`interrupt failed: ${e instanceof Error ? e.message : String(e)}`));
        // Two cases hide behind a rejection: a transient failure while a query
        // is genuinely running (its result will close the turn — do nothing),
        // or accounting drift (inTurn stuck true with no query — nothing will
        // ever close it). Disambiguate by waiting for session silence. ONE
        // timer (repeat Stops reschedule, never stack), and the reset
        // deliberately does NOT kick(): a false positive during a long silent
        // tool call must not inject a queued message into the live query — the
        // next send's own kick releases the queue.
        if (interruptFailTimer !== null) clearTimeout(interruptFailTimer);
        const failedAt = Date.now();
        interruptFailTimer = setTimeout(() => {
          interruptFailTimer = null;
          if (inTurn && lastSessionActivityAt < failedAt) {
            log(dim('no session activity since failed interrupt — resetting turn state'));
            inTurn = false;
            // This path ends the turn WITHOUT a `result`, so the retirement in
            // the result branch never runs. Do it here too, or a Stop that
            // needed the fallback leaves immortal roster entries.
            subagents.retireAll('stop failed — turn state reset');
            emit({ t: 'turn-done', ok: false, error: 'stop failed — turn state reset' });
          }
        }, 10_000);
      });
    } else if (hadQueued) {
      // Nothing running, but queued sends were just cancelled: tell the chat
      // views so their optimistic bubbles/working state clear (that content
      // will never reach the transcript).
      log(dim('⏹ stop cancelled queued sends'));
      emit({ t: 'turn-done', ok: true });
    }
    // Stop while fully idle stays a no-op here — the SERVER answers the
    // requesting socket with a per-client turn-done resync.
  }

  function answer(qid: string, answers: unknown): void {
    const pq = pendingQuestions.get(qid);
    if (pq) {
      pendingQuestions.delete(qid);
      emit({ t: 'question-done', qid });
      pq.resolve(Array.isArray(answers) ? answers : null);
    }
  }

  function onConnected(): void {
    // The server's per-connection state starts empty — re-deliver any question
    // still blocking the turn so chat clients regain it after a server restart
    // or ws blip, and the latest status so the chat header isn't blank until
    // the next turn.
    for (const pq of pendingQuestions.values()) emit(pq.frame);
    if (lastStatus) emit(lastStatus);
    // …and the live subagent roster. This is the piece that used to be missing:
    // the server rebuilt questions and status on reconnect but not the roster,
    // so a background subagent working through a server restart became
    // permanently invisible — nothing would ever re-announce it.
    subagents.announceAll();
  }

  async function start(): Promise<void> {
    // Resumed sessions don't emit `init` until their first turn — without a
    // boot-time fetch the chat's session chip stays blank until the user sends
    // something. Two attempts, in case the control channel needs a moment
    // (refreshStatus swallows failures).
    for (const ms of [3_000, 15_000]) {
      setTimeout(() => {
        if (!lastStatus) void refreshStatus(true);
      }, ms);
    }
    // Name the pty deliberately (OSC 0) — otherwise the pane label falls back
    // to whatever the shell last set ("muxpad", the node path, …). The pane's
    // persistent NAME gets the session's AI title via the transcript tail.
    process.stdout.write('\x1b]0;✳ agent\x07');
    log(`${bold('muxpad agent')} — session ${sid}${resumeSid ? ' (resumed)' : ''}`);
    log(dim(`pane ${host.paneId} · ${process.cwd()}`));
    // Only announced for 'do': a deep pane's log stays byte-identical to the
    // pre-modes output.
    if (currentMode === 'do') log(dim('⚡ do mode — decisive, terse, result-first'));
    log(dim('drive this session from the pane’s Chat face; this log is the terminal face'));

    // A turn can also start WITHOUT a user send: scheduled wakeups and crons
    // fire autonomously inside the persistent session (live-verified). Emit
    // turn-start on the first activity so chat shows the typing indicator, the
    // busy dot lights, and Stop works for those turns too.
    //
    // D7: "first activity" used to mean the first assistant TEXT. A cron turn
    // that opens with a 90-second Bash call produces no text at all, so no
    // turn-start was emitted: agentBusy stayed unset, hello reported
    // turnActive:false, and the runner's single log line never crossed the
    // 600ms pty warmup. The pane read idle while genuinely working. It now
    // fires on the first message of ANY kind that belongs to a turn — a tool
    // call, a subagent's traffic, a stream delta — whichever lands first.
    const noteAutonomousTurn = () => {
      if (inTurn) return;
      inTurn = true;
      interruptRequested = false;
      lastAssistantText = '';
      emit({ t: 'turn-start' });
      log(dim('▸ autonomous turn (wakeup/cron/background)'));
    };

    for await (const msg of session) {
      lastSessionActivityAt = Date.now();
      if (msg.type === 'system' && msg.subtype === 'init') {
        log(dim(`ready · ${msg.model} · ${msg.tools.length} tools`));
        // Init reports the concrete resolved model (e.g. 'claude-opus-4-8').
        if (typeof msg.model === 'string' && msg.model) activeModel = msg.model;
        void refreshStatus(true);
        if (msg.session_id !== liveSid) {
          // Session-id drift (resume minted a new id, /clear started fresh).
          // Re-hello so the server re-points the tail and the self-heal
          // startup_cmd at the real id — and drop the cached status: the old
          // session's context fill must not be re-delivered over the new one.
          log(dim(`session id drifted → ${msg.session_id}`));
          liveSid = msg.session_id;
          lastStatus = null;
          statusEpoch++;
          emit(hello());
        }
      } else if (msg.type === 'system' && isTaskLifecycle(msg.subtype)) {
        applyTaskLifecycle(subagents, msg as TaskLifecycleMessage);
      } else if (msg.type === 'stream_event') {
        const evt = msg.event as {
          type?: string;
          delta?: { type?: string; text?: string };
        };
        if (msg.parent_tool_use_id === null) {
          // ANY main-thread stream event means a turn is under way — not just a
          // text delta. A turn that opens with a tool call streams
          // content_block_start for the tool_use long before its complete
          // assistant message lands; waiting for text meant a Bash-first cron
          // turn showed nothing at all (D7).
          //
          // Subagent stream events (parent_tool_use_id set) are deliberately
          // NOT a turn signal: a background subagent legitimately emits them
          // with no turn running (measured — see the roster note above), and
          // treating those as a turn start would open a turn nothing ever
          // closes. Their "working" comes from the durable roster instead.
          noteAutonomousTurn();
          if (
            evt.type === 'content_block_delta' &&
            evt.delta?.type === 'text_delta' &&
            typeof evt.delta.text === 'string'
          ) {
            emit({ t: 'stream', delta: evt.delta.text });
          }
        }
      } else if (msg.type === 'assistant' && msg.parent_tool_use_id === null) {
        noteAutonomousTurn();
        // Track the concrete model per assistant message so a mid-session switch
        // (setModel) is reflected; refresh the status when it actually changes.
        const m = msg.message.model;
        if (typeof m === 'string' && m && m !== activeModel) {
          activeModel = m;
          void refreshStatus(false);
        }
        let msgText = '';
        for (const block of msg.message.content ?? []) {
          if (block.type === 'text' && block.text.trim()) {
            msgText += (msgText ? '\n' : '') + block.text.trim();
            if (!titleGenerated && firstAssistantText.length < 500) {
              firstAssistantText += `${block.text.trim()}\n`;
            }
            log(`${bold('claude')} ${block.text.trim()}`);
          } else if (block.type === 'tool_use') {
            const arg = summarizeToolInput(block.name, block.input);
            log(`${dim('⚙')} ${block.name}${arg ? dim(` ${arg}`) : ''}`);
            // A Task/Agent call is a subagent LAUNCH. Roster it here, at the
            // parent's tool_use: this is the only message that carries the
            // description, and a background subagent's first child message can
            // arrive seconds later (or, for a very long first tool call, not
            // for a minute — see the P1 note above).
            if (isAgentLaunchTool(block.name) && typeof block.id === 'string') {
              subagents.launch(block.id, subagentLabel(block.input) || 'subagent');
            }
          }
        }
        // Keep the LATEST prose-bearing assistant message as the turn's summary.
        if (msgText) lastAssistantText = msgText;
      } else if (
        (msg.type === 'assistant' || msg.type === 'user') &&
        typeof msg.parent_tool_use_id === 'string'
      ) {
        // Subagent traffic: surface live progress on the parent Task row.
        //
        // NOTE this stream also carries NESTED agents' traffic, tagged with the
        // nested tool_use id (SDK 0.3.220, probe-verified). Those ids are not in
        // the roster and `activity` ignores them — a grandchild's launch and its
        // end both live inside its parent's stream, so an adopted one could
        // never be retired. That adoption is what made `agents:` climb forever.
        let lastTool: string | undefined;
        if (msg.type === 'assistant') {
          for (const block of msg.message.content ?? []) {
            if (block.type === 'tool_use') {
              const arg = summarizeToolInput(block.name, block.input);
              lastTool = arg ? `${block.name}: ${arg}` : block.name;
            }
          }
        }
        subagents.activity(msg.parent_tool_use_id, lastTool);
      } else if (msg.type === 'user' && msg.parent_tool_use_id === null) {
        // TOP-LEVEL user traffic is where a subagent's END shows up, in two
        // shapes — both must retire the roster entry, or a finished agent
        // lingers forever now that nothing expires it on a timer:
        //  1. the parent's own tool_result for the Task call (a FOREGROUND
        //     subagent's completion). A background launch's immediate
        //     "agent launched successfully" ack is NOT a completion — reading
        //     it as one is the bug that used to drop every background agent
        //     one second after launch.
        //  2. the `<task-notification>` the harness injects when a BACKGROUND
        //     subagent finishes, which carries the launching tool-use-id.
        const content = msg.message.content;
        if (typeof content === 'string') {
          const id = taskNotificationToolUseId(content);
          if (id) subagents.done(id);
        } else {
          for (const block of content ?? []) {
            if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
              if (!subagents.has(block.tool_use_id)) continue;
              if (LAUNCH_ACK_RE.test(blockText(block.content))) continue;
              subagents.done(block.tool_use_id);
            } else if (block.type === 'text') {
              const id = taskNotificationToolUseId(block.text);
              if (id) subagents.done(id);
            }
          }
        }
      } else if (msg.type === 'result') {
        inTurn = false;
        // Belt-and-braces: no question outlives its turn.
        resolveAllQuestions('interrupted');
        // Push any throttled-but-unsent progress. Deliberately does NOT drop
        // entries: a run_in_background Task routinely outlives the turn that
        // launched it, and clearing here is what made those subagents vanish.
        subagents.flush();
        // A `Task` tool_use that never actually ran — a retracted refusal leg,
        // a call the harness dropped — produces no task_started, no
        // tool_result and no child traffic, so no end-path can reach it. The
        // turn's end is where "it produced nothing at all" becomes decidable.
        subagents.retireUnstarted();
        // …but a turn that was STOPPED or FAILED takes its background tasks
        // down with it, and those deaths announce themselves nowhere: no
        // tool_result, no finish notice. Retire them explicitly or they are
        // immortal (there is no decay timer left to catch them).
        if (interruptRequested) subagents.retireAll('stopped');
        else if (msg.subtype !== 'success') subagents.retireAll('turn failed');
        const ok = msg.subtype === 'success' || interruptRequested;
        const secs = (msg.duration_ms / 1000).toFixed(1);
        const summary = notifySnippet(lastAssistantText);
        if (interruptRequested) {
          log(dim(`⏹ stopped after ${secs}s`));
          emit({ t: 'turn-done', ok: true, ...(summary ? { summary } : {}) });
        } else if (msg.subtype === 'success') {
          log(dim(`✓ turn done · ${secs}s · $${msg.total_cost_usd.toFixed(2)}`));
          emit({ t: 'turn-done', ok: true, ...(summary ? { summary } : {}) });
          // First completed turn of a fresh session: self-title (resumed
          // sessions keep whatever name their pane/tab already carries).
          if (!resumeSid && !titleGenerated) void generateTitle();
        } else {
          const error = msg.errors?.join('; ') || msg.subtype;
          log(`✗ turn failed: ${error}`);
          emit({ t: 'turn-done', ok, error });
        }
        interruptRequested = false;
        kick(); // release the next queued send, if any
        void refreshStatus(false); // context fill changed with the turn
      }
    }
  }

  function shutdown(): void {
    clearInterval(statusInterval);
    clearInterval(subagentKeepalive);
    if (interruptFailTimer !== null) clearTimeout(interruptFailTimer); // no spurious post-shutdown turn-done
    resolveAllQuestions('shutdown');
    try {
      session.close();
    } catch {
      // already gone
    }
  }

  return {
    id: 'claude',
    start,
    send,
    slash,
    stop,
    setModel,
    setMode,
    answer,
    onConnected,
    hello,
    shutdown,
  };
}
