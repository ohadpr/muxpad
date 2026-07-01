// Canonical chat-event model. Claude Code (and later Codex/Cursor) persist a
// session as a JSONL transcript; `normalizeTranscriptLine` turns one raw line
// into zero or more of these events so the web chat view renders from a single
// shape regardless of the provider's on-disk format.
//
// See docs/plans/2026-07-01-web-chat-session-switching.md.

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

export type ChatEvent =
  | UserTextEvent
  | AssistantTextEvent
  | ThinkingEvent
  | ToolUseEvent
  | ToolResultEvent;

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
    t.startsWith('<command-name>') ||
    t.startsWith('<command-message>') ||
    t.startsWith('<local-command-stdout>') ||
    t.startsWith('<user-prompt-submit-hook>')
  );
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
      return [{ kind: 'user', id: uuid || `u:${ts}`, ts, text: content }];
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
