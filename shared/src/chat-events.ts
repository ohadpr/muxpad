// Canonical chat-event model. Claude Code (and later Codex/Cursor) persist a
// session as a JSONL transcript; `normalizeTranscriptLine` turns one raw line
// into zero or more of these events so the web chat view renders from a single
// shape regardless of the provider's on-disk format.
//
// See docs/plans/2026-07-01-web-chat-session-switching.md.

import { parseCronMarker } from './cron.js';

export interface StructuredPatchHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

export interface ChatDiff {
  filePath?: string;
  patch: StructuredPatchHunk[];
}

interface Base {
  /** Stable id (line uuid + block index) — React key + client-side dedupe. */
  id: string;
  /** Epoch ms, or null if the line carried no parseable timestamp. */
  ts: number | null;
}

export interface UserTextEvent extends Base {
  kind: 'user';
  text: string;
}
export interface AssistantTextEvent extends Base {
  kind: 'assistant';
  text: string;
  model?: string;
}
export interface ThinkingEvent extends Base {
  kind: 'thinking';
  text: string;
}
export interface ToolUseEvent extends Base {
  kind: 'tool_use';
  toolUseId: string;
  name: string;
  input: unknown;
}
export interface ToolResultEvent extends Base {
  kind: 'tool_result';
  toolUseId: string;
  ok: boolean;
  text?: string;
  diff?: ChatDiff;
}
/**
 * A harness "control" message — Claude Code injects these into the transcript as
 * user-role text (background-task updates, session reminders). They are not
 * things a human typed, so we render them as a bespoke notice chip rather than a
 * raw `<task-notification>…` chat bubble. `variant` drives the icon/styling.
 */
export interface NoticeEvent extends Base {
  kind: 'notice';
  /** 'cron' is muxpad's own: a scheduled fire landed in this conversation.
   *  It is NOT a status — the pane's existing `working` covers the activity —
   *  just a durable "this turn was started by pr-sweep, not by you" chip in
   *  the transcript where the message actually is. */
  variant: 'task' | 'reminder' | 'cron';
  text: string;
  /** Secondary line, e.g. a task-notification's status. */
  detail?: string;
  /** For a task-notification: the parent Task/Agent tool-use id it reports on.
   *  Lets the live roster match a subagent's FINISH to its launch reliably —
   *  a background agent's own tool_result is only the immediate launch ack. */
  toolUseId?: string;
}

export type ChatEvent =
  | UserTextEvent
  | AssistantTextEvent
  | ThinkingEvent
  | ToolUseEvent
  | ToolResultEvent
  | NoticeEvent;

/**
 * One multiple-choice question an agent poses to the user mid-turn (the
 * runner's ask_user tool). Rendered as tappable chips in the chat UI; the
 * answer resolves the blocked tool call. Shared between the agent-runner
 * protocol (server) and the chat client.
 */
export interface AgentQuestion {
  question: string;
  /** Short chip label, e.g. "Approach". */
  header: string;
  multiSelect: boolean;
  options: Array<{ label: string; description?: string }>;
}

/**
 * Live progress of one subagent (Task tool call), keyed by its tool-use id.
 *
 * This is a ROSTER ENTRY, not a heartbeat. The server holds it from the launch
 * until an explicit finish (`done`) or its runner's death — deliberately NOT on
 * a decay timer. Measured (P1 experiment, 2026-08): a background subagent
 * parked in one long tool call emits ZERO frames for 44s+ while plainly alive,
 * so any timeout short enough to be useful is also short enough to be wrong.
 */
export interface SubagentProgress {
  toolUseId: string;
  /** Messages seen from the subagent so far — a coarse "it's alive" counter. */
  steps: number;
  /** Most recent tool the subagent invoked, e.g. "Bash: pnpm test". */
  lastTool?: string;
  /** The launch description ("audit the status pipeline"), when the runner saw
   *  the launching tool_use. Lets a (re)connecting client name the row without
   *  the transcript — which the 128 KB history window may have scrolled past. */
  label?: string;
  /** Epoch ms of the runner's last REAL observed activity for this subagent
   *  (never bumped by the keepalive — the keepalive re-sends this value
   *  unchanged). Drives the per-row busy/quiet dot; roster MEMBERSHIP never
   *  depends on it. */
  seenAt?: number;
  /** Terminal notice: this subagent is finished — drop it from the roster.
   *  The only way an entry leaves, short of its runner dying. */
  done?: boolean;
}

/**
 * Session status pushed by the agent runner: current model, context-window
 * fill, and (when freshly fetched) the available models. ONE definition for
 * the whole runner→server→web pipeline — hand-kept copies of cross-boundary
 * shapes are how fields silently vanish between hops.
 */
export interface AgentSessionStatus {
  model: string;
  /** The CONCRETE model actually running (e.g. 'claude-opus-4-8'), when the
   *  backend can report it. `model` may be a friendly alias ('opus'); this is
   *  the exact version, so the UI can show precisely which model is live. */
  activeModel?: string;
  /** Context-window fill. OPTIONAL: backends without a context-window notion
   *  (or that don't expose one in their stream — Codex/Cursor) omit it and the
   *  chat header simply hides the meter chip. */
  context?: { pct: number; tokens: number; max: number };
  models?: Array<{ value: string; displayName: string; resolvedModel?: string }>;
}

/**
 * Runtime validator for a status frame arriving off the wire from a runner
 * (version skew is normal: runners only pick up new code when their pane
 * respawns). Returns a sanitized copy or null — an unvalidated frame that
 * reaches a client render is an app-wide crash.
 */
export function sanitizeAgentStatus(raw: unknown): AgentSessionStatus | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.model !== 'string') return null;
  // Context is optional (Codex/Cursor don't stream a window). When present it
  // must be fully-formed numbers; a malformed context is dropped, not fatal.
  const ctx = o.context as Record<string, unknown> | undefined;
  const validContext =
    typeof ctx === 'object' &&
    ctx !== null &&
    typeof ctx.pct === 'number' &&
    typeof ctx.tokens === 'number' &&
    typeof ctx.max === 'number';
  const models = Array.isArray(o.models)
    ? o.models
        .filter(
          (m): m is { value: string; displayName: string; resolvedModel?: string } =>
            typeof m === 'object' &&
            m !== null &&
            typeof (m as Record<string, unknown>).value === 'string' &&
            typeof (m as Record<string, unknown>).displayName === 'string',
        )
        .map((m) => ({
          value: m.value,
          displayName: m.displayName,
          ...(typeof m.resolvedModel === 'string' ? { resolvedModel: m.resolvedModel } : {}),
        }))
    : undefined;
  return {
    model: o.model,
    ...(typeof o.activeModel === 'string' && o.activeModel ? { activeModel: o.activeModel } : {}),
    ...(validContext
      ? {
          context: {
            pct: ctx.pct as number,
            tokens: ctx.tokens as number,
            max: ctx.max as number,
          },
        }
      : {}),
    ...(models && models.length > 0 ? { models } : {}),
  };
}

function tsOf(raw: Record<string, unknown>): number | null {
  const t = raw.timestamp;
  if (typeof t !== 'string') return null;
  const ms = Date.parse(t);
  return Number.isNaN(ms) ? null : ms;
}

// User string content that is muxpad/CLI plumbing, not something a human typed:
// the injected caveat preamble and slash-command wrappers. Rendering these as
// chat bubbles is pure noise (opcode/claude-code-webui filter the same).
function isPlumbingUserText(text: string): boolean {
  const t = text.trimStart();
  return (
    t.startsWith('Caveat: The messages below') ||
    t.startsWith('<local-command-caveat>') ||
    t.startsWith('<command-name>') ||
    t.startsWith('<command-message>') ||
    t.startsWith('<local-command-stdout>') ||
    t.startsWith('<user-prompt-submit-hook>')
  );
}

/** First `<tag>…</tag>` inner text, trimmed; undefined if the tag is absent. */
function extractTag(xml: string, tag: string): string | undefined {
  const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return m?.[1]?.trim();
}

// ── Subagent lifecycle recognisers ──────────────────────────────────────────
// Shared because the RUNNER (which owns the durable roster) and the WEB chat
// (which renders it) must agree byte-for-byte on what a launch and a finish
// look like. Two hand-kept copies of these rules is how a roster starts
// disagreeing with the list right next to it.

/** A Task/Agent tool call — a subagent LAUNCH. */
export function isAgentLaunchTool(name: string): boolean {
  return name === 'Agent' || name === 'Task';
}

/** The human description of a subagent launch, from the launching tool input. */
export function subagentLabel(input: unknown): string {
  if (input && typeof input === 'object') {
    const d = (input as { description?: unknown }).description;
    if (typeof d === 'string' && d.trim()) return d.trim().slice(0, 80);
  }
  return '';
}

/**
 * A BACKGROUND agent's tool_result is the immediate "launched" ack, NOT a
 * completion — so it must not be read as "this agent finished". A FOREGROUND
 * agent's result IS its completion. This tells them apart.
 */
export const LAUNCH_ACK_RE = /agent launched successfully|async agent launched/i;

/** Flatten an SDK tool_result `content` (string, or a block array) to text. */
export function blockText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) =>
      b && typeof b === 'object' && (b as { type?: string }).type === 'text'
        ? String((b as { text?: unknown }).text ?? '')
        : '',
    )
    .join(' ');
}

/**
 * The launching tool-use id carried by a `<task-notification>` — the harness's
 * "your background subagent finished" injection. Returns null for anything
 * else, including a notification that predates the tool-use-id field.
 */
export function taskNotificationToolUseId(text: string): string | null {
  if (!text.includes('<task-notification>')) return null;
  const inner = extractTag(text, 'task-notification');
  if (inner === undefined) return null;
  return extractTag(inner, 'tool-use-id') ?? null;
}

/**
 * Inner text when the WHOLE string (mod surrounding whitespace) is a single
 * `<tag>…</tag>` block; null otherwise. Checking both edges — not just the
 * opening tag — matters: Claude Code also PREPENDS reminders to real user
 * messages, and those must stay user bubbles, not lose the user's text.
 */
function wholeTagContent(content: string, tag: string): string | null {
  const t = content.trim();
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  if (!t.startsWith(open) || !t.endsWith(close)) return null;
  // The first closing tag must be the final one, or there's real text
  // sandwiched between two wrapper blocks.
  if (t.indexOf(close) !== t.length - close.length) return null;
  return t.slice(open.length, t.length - close.length).trim();
}

/**
 * Recognise a harness control message (a whole user string that IS one wrapper
 * tag) and turn it into a NoticeEvent. Returns null for ordinary user text —
 * including messages that merely have a reminder prepended/appended around what
 * the human typed — so only standalone control messages are intercepted.
 */
function parseNotice(content: string, id: string, ts: number | null): NoticeEvent | null {
  const task = wholeTagContent(content, 'task-notification');
  if (task !== null) {
    const status = extractTag(task, 'status');
    const toolUseId = extractTag(task, 'tool-use-id');
    return {
      kind: 'notice',
      id,
      ts,
      variant: 'task',
      text: extractTag(task, 'summary') || 'Background task update',
      ...(status ? { detail: status } : {}),
      ...(toolUseId ? { toolUseId } : {}),
    };
  }
  const reminder = wholeTagContent(content, 'system-reminder');
  if (reminder) return { kind: 'notice', id, ts, variant: 'reminder', text: reminder };
  return null;
}

/**
 * A message delivered by a muxpad cron arrives as `<muxpad-cron …>…</…>` +
 * the prompt. Split it into a marker CHIP and the prompt bubble, so the
 * transcript reads "⏱ pr-sweep · 09:00" followed by what was actually asked —
 * rather than a wall of XML, or (worse) a chip that swallowed the prompt.
 *
 * Returns null for anything that isn't a cron fire. Exported because the two
 * transcript shapes reach it by different roads: Claude's raw JSONL through
 * `normalizeTranscriptLine`, and codex/cursor's already-normalized muxpad log
 * through `expandChatEvent`.
 */
export function expandCronFire(text: string, id: string, ts: number | null): ChatEvent[] | null {
  const parsed = parseCronMarker(text);
  if (!parsed) return null;
  const { marker, body } = parsed;
  const notice: NoticeEvent = {
    kind: 'notice',
    // Distinct id from the user bubble's — they are two React rows.
    id: `${id}:cron`,
    ts,
    variant: 'cron',
    text: marker.name,
    ...(marker.missed > 0
      ? { detail: `${marker.missed} missed fire${marker.missed === 1 ? '' : 's'} collapsed` }
      : {}),
  };
  const prompt = body.trim();
  return prompt ? [notice, { kind: 'user', id, ts, text: prompt }] : [notice];
}

/**
 * Post-process an ALREADY-normalized event (the codex/cursor muxpad log,
 * whose lines are ChatEvents on disk). Today its only job is splitting a cron
 * fire out of a user bubble — the Claude path gets the same treatment inside
 * `normalizeTranscriptLine`, so both backends render a fire identically.
 */
export function expandChatEvent(event: ChatEvent): ChatEvent[] {
  if (event.kind !== 'user') return [event];
  return expandCronFire(event.text, event.id, event.ts) ?? [event];
}

/**
 * One-line human summary of a tool call's input — the argument shown next to
 * the verb in collapsed tool rows (web chat) and the runner's terminal log.
 * Picks the most identifying string field, collapses whitespace, truncates.
 */
export function summarizeToolInput(_name: string, input: unknown): string {
  if (input && typeof input === 'object') {
    const o = input as Record<string, unknown>;
    for (const k of [
      'command',
      'file_path',
      'path',
      'pattern',
      'url',
      'description',
      'prompt',
      'query',
    ]) {
      if (typeof o[k] === 'string' && o[k]) {
        const v = (o[k] as string).replace(/\s+/g, ' ').trim();
        return v.length > 160 ? `${v.slice(0, 160)}…` : v;
      }
    }
    try {
      return JSON.stringify(o).slice(0, 200);
    } catch {
      return '';
    }
  }
  return '';
}

// A tool_result's `content` is either a string or an array of text blocks.
function flattenContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (typeof b === 'string') return b;
        if (b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string')
          return (b as { text: string }).text;
        return '';
      })
      .join('');
  }
  return '';
}

function diffOf(raw: Record<string, unknown>): ChatDiff | undefined {
  const tur = raw.toolUseResult;
  if (!tur || typeof tur !== 'object') return undefined;
  const patch = (tur as { structuredPatch?: unknown }).structuredPatch;
  if (!Array.isArray(patch) || patch.length === 0) return undefined;
  const filePath = (tur as { filePath?: unknown }).filePath;
  return {
    ...(typeof filePath === 'string' ? { filePath } : {}),
    patch: patch as StructuredPatchHunk[],
  };
}

/**
 * Normalize one parsed transcript line into chat events. Returns [] for lines
 * that carry no conversational content (mode/system/attachment/queue/
 * file-history-snapshot/etc.), for sub-agent sidechain lines, and for meta
 * plumbing. A single assistant line can yield several events (text + tool_use).
 *
 * Defensive by contract: the JSONL schema is internal/undocumented, so anything
 * unexpected yields [] rather than throwing — the caller streams many lines and
 * one weird line must never break the feed.
 */
export function normalizeTranscriptLine(line: unknown): ChatEvent[] {
  if (!line || typeof line !== 'object') return [];
  const raw = line as Record<string, unknown>;
  if (raw.isSidechain === true) return []; // sub-agent internals
  if (raw.isMeta === true) return [];
  const type = raw.type;
  const uuid = typeof raw.uuid === 'string' ? raw.uuid : '';
  const ts = tsOf(raw);
  const message = raw.message as Record<string, unknown> | undefined;

  if (type === 'user') {
    const content = message?.content;
    if (typeof content === 'string') {
      if (!content.trim() || isPlumbingUserText(content)) return [];
      const id = uuid || `u:${ts}`;
      const notice = parseNotice(content, id, ts);
      if (notice) return [notice];
      // A cron fire is a user message with a leading marker block — chip +
      // prompt, never raw XML in a bubble.
      const cron = expandCronFire(content, id, ts);
      if (cron) return cron;
      return [{ kind: 'user', id, ts, text: content }];
    }
    if (Array.isArray(content)) {
      const out: ChatEvent[] = [];
      const diff = diffOf(raw);
      content.forEach((block, i) => {
        if (
          block &&
          typeof block === 'object' &&
          (block as { type?: string }).type === 'tool_result'
        ) {
          const b = block as { tool_use_id?: string; is_error?: boolean; content?: unknown };
          const text = flattenContent(b.content);
          out.push({
            kind: 'tool_result',
            id: `${uuid}:${i}`,
            ts,
            toolUseId: typeof b.tool_use_id === 'string' ? b.tool_use_id : '',
            ok: b.is_error !== true,
            ...(text ? { text } : {}),
            ...(diff ? { diff } : {}),
          });
        }
      });
      return out;
    }
    return [];
  }

  if (type === 'assistant') {
    const content = message?.content;
    if (!Array.isArray(content)) return [];
    const model = typeof message?.model === 'string' ? (message.model as string) : undefined;
    const out: ChatEvent[] = [];
    content.forEach((block, i) => {
      if (!block || typeof block !== 'object') return;
      const b = block as {
        type?: string;
        text?: unknown;
        thinking?: unknown;
        id?: string;
        name?: string;
        input?: unknown;
      };
      const id = `${uuid}:${i}`;
      if (b.type === 'text' && typeof b.text === 'string') {
        if (b.text.trim())
          out.push({ kind: 'assistant', id, ts, text: b.text, ...(model ? { model } : {}) });
      } else if (b.type === 'thinking' && typeof b.thinking === 'string') {
        if (b.thinking.trim()) out.push({ kind: 'thinking', id, ts, text: b.thinking });
      } else if (b.type === 'tool_use') {
        out.push({
          kind: 'tool_use',
          id,
          ts,
          toolUseId: typeof b.id === 'string' ? b.id : '',
          name: typeof b.name === 'string' ? b.name : '',
          input: b.input ?? {},
        });
      }
    });
    return out;
  }

  return [];
}
