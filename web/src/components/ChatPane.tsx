import {
  type AgentQuestion,
  type AgentSessionStatus,
  type ChatEvent,
  type NoticeEvent,
  type SubagentProgress,
  type ToolResultEvent,
  type ToolUseEvent,
  IMAGE_MIME_BY_EXT,
  imageExtForMime,
  summarizeToolInput,
} from '@muxpad/shared';
import {
  type ChangeEvent,
  type ReactNode,
  isValidElement,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { SvgAgentGlyph } from './PaneWebSwitch';
import { api } from '../api';
import { AGENT_BACKENDS, type AgentBackendId } from '../lib/agent-backend';
import { AgentBackendLogo } from './AgentLogos';
import { type MessagePart, splitMessageAttachments } from '../lib/attachments';

/** Open a media item in the lightbox (image or video). */
type OpenMedia = (m: { url: string; name: string; video: boolean }) => void;
import { recallChatScroll, rememberChatScroll } from '../lib/chat-scroll';
import { companionTextForImagePaste, splitClipboard } from '../lib/clipboard-detect';
import { isMobileLayout } from '../lib/mobile-layout';
import { useDismissable } from '../lib/use-dismissable';
import './ChatPane.css';

// Assistant + streaming text is rendered as GitHub-flavored markdown. No raw
// HTML is allowed through (no rehype-raw) so user/model content can't inject
// markup — react-markdown escapes everything by default. Links open safely in
// a new tab; everything else is styled from the .chat-md-* rules in the CSS.
// Per-block base direction, computed in JS from the block's first strong
// character over its (possibly nested) children. This is dir="auto" done
// right: native dir="auto" on a <li> fails because react-markdown wraps
// loose-list text in a <p> — the <li> then has no DIRECT text and defaults
// LTR, flipping the bullet to the wrong side; and dir="auto" on the whole
// message mis-directs a Hebrew body under an English intro line. Computing
// from the real text sidesteps both — each paragraph/list-item/quote gets its
// own correct direction. Code stays LTR.
const RTL_CHAR = /[\u0590-\u05FF\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB1D-\uFB4F\uFB50-\uFDFF\uFE70-\uFEFF]/; // Hebrew, Arabic (+ presentation forms)
const LTR_CHAR = /[a-z\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF]/i; // Latin, Greek, Cyrillic
function textOf(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isValidElement(node)) return textOf((node.props as { children?: ReactNode }).children);
  return '';
}
function baseDir(children: ReactNode): 'rtl' | 'ltr' | undefined {
  for (const ch of textOf(children)) {
    if (RTL_CHAR.test(ch)) return 'rtl';
    if (LTR_CHAR.test(ch)) return 'ltr';
  }
  return undefined;
}
const MD_COMPONENTS: Components = {
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer noopener" />,
  p: ({ node: _node, children, ...props }) => (
    <p dir={baseDir(children)} {...props}>
      {children}
    </p>
  ),
  ul: ({ node: _node, children, ...props }) => (
    <ul dir={baseDir(children)} {...props}>
      {children}
    </ul>
  ),
  ol: ({ node: _node, children, ...props }) => (
    <ol dir={baseDir(children)} {...props}>
      {children}
    </ol>
  ),
  li: ({ node: _node, children, ...props }) => (
    <li dir={baseDir(children)} {...props}>
      {children}
    </li>
  ),
  h1: ({ node: _node, children, ...props }) => (
    <h1 dir={baseDir(children)} {...props}>
      {children}
    </h1>
  ),
  h2: ({ node: _node, children, ...props }) => (
    <h2 dir={baseDir(children)} {...props}>
      {children}
    </h2>
  ),
  h3: ({ node: _node, children, ...props }) => (
    <h3 dir={baseDir(children)} {...props}>
      {children}
    </h3>
  ),
  h4: ({ node: _node, children, ...props }) => (
    <h4 dir={baseDir(children)} {...props}>
      {children}
    </h4>
  ),
  h5: ({ node: _node, children, ...props }) => (
    <h5 dir={baseDir(children)} {...props}>
      {children}
    </h5>
  ),
  h6: ({ node: _node, children, ...props }) => (
    <h6 dir={baseDir(children)} {...props}>
      {children}
    </h6>
  ),
  blockquote: ({ node: _node, children, ...props }) => (
    <blockquote dir={baseDir(children)} {...props}>
      {children}
    </blockquote>
  ),
  pre: ({ node: _node, ...props }) => <pre dir="ltr" {...props} />,
};

/** Renders (possibly partial/streaming) markdown for assistant messages. */
function Markdown({ text }: { text: string }) {
  return (
    <div className="chat-md" dir="auto">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

/** Camera glyph for the photo/attach button (matches the TUI composer). */
function SvgCamera() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" fill="none">
      <path
        d="M4 8a2 2 0 0 1 2-2h1.2a2 2 0 0 0 1.66-.89l.62-.92A1 1 0 0 1 10.3 4h3.4a1 1 0 0 1 .82.43l.62.92A2 2 0 0 0 16.8 6H18a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="13" r="3.2" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

/** Queue glyph — an arrow settling onto a baseline ("send it in later"). */
function SvgQueue() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" fill="none">
      <path
        d="M12 4v10m0 0 4-4m-4 4-4-4"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M5 19h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

/** Restore glyph — a curved back-arrow ("pull it back to the composer"). */
function SvgRestore() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" fill="none">
      <path
        d="M9 10H5V6"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M5 10a8 8 0 1 1 2 5.3"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SvgFolder({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" fill="none">
      <path
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
        d="M2 4.5C2 3.7 2.7 3 3.5 3h2.6c.5 0 .9.2 1.2.6l.6.8h4.6c.8 0 1.5.7 1.5 1.5v5.1c0 .8-.7 1.5-1.5 1.5h-9C2.7 13 2 12.3 2 11.5v-7Z"
      />
    </svg>
  );
}

/** The chat header's working-directory chip: shows the folder + a warning when
 *  it has no project context (git/rules/MCP), and opens a switcher that respawns
 *  the agent in a new folder. */
function FolderChip({
  cwd,
  hasProject,
  paneId,
}: {
  cwd: string;
  hasProject: boolean;
  paneId: string;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(cwd);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  useDismissable(open, wrapRef, () => setOpen(false));
  useEffect(() => {
    if (open) {
      setDraft(cwd);
      setErr(null);
    }
  }, [open, cwd]);
  const base = cwd.replace(/\/+$/, '').split('/').pop() || cwd;
  const submit = async () => {
    const next = draft.trim();
    if (!next || next === cwd) {
      setOpen(false);
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await api.setPaneCwd(paneId, next);
      setOpen(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'could not switch folder');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="chat-folder" ref={wrapRef}>
      <button
        type="button"
        className={`chat-folder-chip${hasProject ? '' : ' -nowarn'}`}
        onClick={() => setOpen((o) => !o)}
        title={hasProject ? cwd : `${cwd} — no project context (no git/AGENTS.md/.mcp.json)`}
      >
        <SvgFolder />
        <span className="chat-folder-name">{base}</span>
        {!hasProject ? (
          <span className="chat-folder-warn" aria-label="no project context">
            !
          </span>
        ) : null}
      </button>
      {open ? (
        <div className="chat-folder-menu" role="dialog">
          <div className="chat-folder-path">{cwd}</div>
          {!hasProject ? (
            <div className="chat-folder-nocontext">
              No project context here — no git repo, AGENTS.md, or .mcp.json up the tree, so the
              agent has no project rules or MCP.
            </div>
          ) : null}
          <label className="chat-folder-lbl" htmlFor={`fld-${paneId}`}>
            Switch folder (restarts the agent)
          </label>
          <input
            id={`fld-${paneId}`}
            className="chat-folder-input"
            value={draft}
            spellCheck={false}
            // biome-ignore lint/a11y/noAutofocus: opened by an explicit user click
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void submit();
              } else if (e.key === 'Escape') {
                setOpen(false);
              }
            }}
          />
          {err ? <div className="chat-folder-error">{err}</div> : null}
          <button type="button" className="chat-folder-go" disabled={busy} onClick={() => void submit()}>
            {busy ? 'Switching…' : 'Switch & restart'}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Composer chip + dropdown for session management: shows "model · ctx%",
 * opens a menu with the context meter, a model picker (SDK setModel), and
 * Compact / Clear (relayed to the runner as /compact and /clear through the
 * normal turn queue). Renders only when a runner has pushed status — chat
 * views without a live agent runner have nothing to manage.
 */
function SessionMenu({
  status,
  send,
  assistant,
}: {
  status: AgentStatus;
  send: (obj: unknown) => void;
  assistant?: string;
}) {
  // Compact/Clear are Claude-session commands; Codex/Cursor don't implement them
  // (the runner no-ops the slash), so hiding them avoids a dead action — and
  // keeps them from being buried under Cursor's very long model list.
  const supportsSlash = assistant !== 'codex' && assistant !== 'cursor';
  const [open, setOpen] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  useDismissable(open, wrapRef, () => setOpen(false));
  useEffect(() => {
    if (!open) setConfirmClear(false);
  }, [open]);
  // Match the reported model to a list row. Order matters: several rows can
  // RESOLVE to the same wire model (e.g. "Default" resolves to the same id as
  // "Opus"), and a naive first-match made a switch to Opus label itself
  // "Default". Exact value first, then a resolved match on a specific row,
  // and the default row only as a last resort.
  const list = status.models ?? [];
  const modelLc = status.model.toLowerCase();
  const current =
    list.find((m) => m.value === status.model) ??
    list.find((m) => m.value !== 'default' && m.resolvedModel === status.model) ??
    list.find((m) => m.resolvedModel === status.model) ??
    // Case-insensitive fallback: Cursor reports e.g. 'Auto' but lists 'auto'.
    list.find((m) => m.value.toLowerCase() === modelLc);
  const modelLabel = current?.displayName ?? status.model;
  const kTokens = (n: number) => `${Math.round(n / 1000)}k`;
  // Context is optional — backends without a context-window (Codex/Cursor)
  // omit it, and the meter chip/section simply don't render.
  const ctx = status.context;
  return (
    <div className="chat-session" ref={wrapRef}>
      <button
        type="button"
        className="chat-session-chip"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Session — model, context, compact, clear"
      >
        {modelLabel}
        {ctx ? ` · ${ctx.pct}%` : ''}
      </button>
      {open ? (
        <div className="chat-session-menu" role="menu">
          {ctx ? (
            <>
              <div className="chat-session-head">Context</div>
              <div className="chat-session-context">
                <div className="chat-session-bar">
                  <div
                    className="chat-session-bar-fill"
                    style={{ width: `${Math.min(100, ctx.pct)}%` }}
                  />
                </div>
                <span className="chat-session-context-label">
                  {ctx.pct}% · {kTokens(ctx.tokens)} / {kTokens(ctx.max)} tokens
                </span>
              </div>
            </>
          ) : null}
          {status.models?.length ? <div className="chat-session-head">Model</div> : null}
          {status.models?.map((m) => (
            <button
              key={m.value}
              type="button"
              role="menuitem"
              className={`chat-session-item${m === current ? ' is-active' : ''}`}
              onClick={() => {
                if (m !== current) send({ t: 'set-model', model: m.value });
                setOpen(false);
              }}
            >
              <span className="chat-session-item-label">{m.displayName}</span>
            </button>
          ))}
          {supportsSlash ? (
            <>
              <div className="chat-session-head">Session</div>
              <button
                type="button"
                role="menuitem"
                className="chat-session-item"
                onClick={() => {
                  send({ t: 'slash', cmd: 'compact' });
                  setOpen(false);
                }}
              >
                <span className="chat-session-item-label">Compact conversation</span>
                <span className="chat-session-item-desc">Summarize history to free context</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className={`chat-session-item${confirmClear ? ' is-danger' : ''}`}
                onClick={() => {
                  if (!confirmClear) {
                    setConfirmClear(true);
                    return;
                  }
                  send({ t: 'slash', cmd: 'clear' });
                  setOpen(false);
                }}
              >
                <span className="chat-session-item-label">
                  {confirmClear ? 'Tap again to clear everything' : 'Clear conversation'}
                </span>
                {!confirmClear ? (
                  <span className="chat-session-item-desc">Wipes the conversation — starts fresh</span>
                ) : null}
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

interface SessionMeta {
  current_sid: string | null;
  writer: string;
  view_mode: string;
  assistant: string;
}

/** Display name for the pane's agent backend — used in composer/working copy
 *  so a Codex/Cursor pane doesn't say "Claude". */
function assistantLabel(a: string | null | undefined): string {
  if (a === 'codex') return 'Codex';
  if (a === 'cursor') return 'Cursor';
  return 'Claude';
}

type PendingQuestion = { qid: string; questions: AgentQuestion[] };

/** Session status pushed by the agent runner — shape shared with the server
 * pipeline via @muxpad/shared so the two ends can't drift apart. */
type AgentStatus = AgentSessionStatus;

type ServerMsg =
  | {
      t: 'session';
      session: (SessionMeta & Record<string, unknown>) | null;
      // True when a headless turn is already in flight for this pane — a
      // reconnect mid-turn restores the working/Stop state from this.
      turnRunning?: boolean;
      // The turn's streamed text so far, so that reconnect shows the partial
      // assistant message instead of a bare typing indicator.
      streamText?: string;
      // Mid-turn (re)connect extras: an unanswered agent question and live
      // subagent progress.
      question?: PendingQuestion;
      subagents?: SubagentProgress[];
      status?: AgentStatus;
      /** The pane's working dir + whether it has project context (git/rules/MCP). */
      cwd?: string;
      hasProject?: boolean;
    }
  | { t: 'events'; phase: 'history' | 'live' | 'older'; events: ChatEvent[] }
  | { t: 'older-done'; hasMore: boolean }
  | { t: 'send-ack' }
  | { t: 'pong' }
  | { t: 'turn-start' }
  | { t: 'stream'; delta: string }
  | { t: 'turn-done'; ok: boolean; error?: string }
  | { t: 'question'; qid: string; questions: AgentQuestion[] }
  | { t: 'question-done'; qid: string }
  | { t: 'subagent'; progress: SubagentProgress }
  | ({ t: 'status' } & AgentStatus)
  | { t: 'error'; message: string }
  | {
      /** Non-fatal server notice (e.g. a menu action while the runner is
       * reconnecting). Display only — never touches send/turn state. */
      t: 'notice';
      message: string;
    };

/**
 * Assistant texts of the CURRENT turn (everything after the last user
 * message) that have already landed in the transcript. These render as real
 * events, so they must be stripped from the live streaming preview.
 */
function landedThisTurn(ordered: readonly ChatEvent[]): string[] {
  let lastUser = -1;
  for (let i = ordered.length - 1; i >= 0; i--) {
    if (ordered[i]?.kind === 'user') {
      lastUser = i;
      break;
    }
  }
  return ordered
    .slice(lastUser + 1)
    .filter((e): e is Extract<ChatEvent, { kind: 'assistant' }> => e.kind === 'assistant')
    .map((e) => e.text);
}

/**
 * Return the un-landed remainder of the streaming preview. The preview
 * accumulates every text delta of the turn; once a block lands in the
 * transcript (rendered as a real event) its copy must leave the preview or
 * it shows twice — the "every message doubled while a turn runs" bug.
 *
 * We ANCHOR on the LAST landed block and keep only what follows it, rather
 * than stripping each landed block off the head in sequence. Sequential
 * head-stripping was a one-shot on a mid-turn reconnect (the hello resends
 * the whole-turn buffer): a single byte of whitespace/normalization drift in
 * ANY earlier block broke the prefix match, so nothing stripped and the
 * entire turn re-rendered as a trailing message — and the re-replayed
 * history deduped away, so it never self-healed. Tail-anchoring only needs
 * the final block to match; earlier drift is irrelevant. If even the anchor
 * isn't found (deeper drift, or a tail-sliced 256KB buffer that dropped it),
 * trust the transcript over the buffer and hide the preview — the un-landed
 * tail re-lands within a tail-poll, so nothing is lost for long. Never
 * re-show landed text.
 */
function consumeStreamedText(preview: string, landed: string[]): string {
  if (!landed.length) return preview;
  const last = landed[landed.length - 1] as string;
  const idx = preview.lastIndexOf(last);
  return idx >= 0 ? preview.slice(idx + last.length) : '';
}

/** A Task/Agent tool call — a subagent LAUNCH. It gets its own notice bubble
 *  (mirroring the finish notice the harness injects), so it is NEVER folded
 *  into an action run and never rendered as a plain tool row. */
function isAgentLaunch(e: ChatEvent): boolean {
  return e.kind === 'tool_use' && (e.name === 'Agent' || e.name === 'Task');
}
function agentLaunchDescription(e: ToolUseEvent): string {
  const desc = (e.input as { description?: string } | null)?.description?.trim();
  return desc || 'subagent';
}
/** A BACKGROUND agent's tool_result is the immediate "launched" ack, NOT a
 *  completion — so it must not be read as "this agent finished". A foreground
 *  agent's result IS its completion. This tells them apart. */
const LAUNCH_ACK_RE = /agent launched successfully|async agent launched/i;

/** How long a rostered subagent may go without a progress frame — while no
 *  parent turn is driving — before we treat it as finished. A LIVE background
 *  subagent pings progress every ≤500ms; prolonged quiet while the pane is idle
 *  means it completed/was killed even when no finish-notice ever lands (a
 *  stopped/failed turn, a subagent that finished while idle with no next turn to
 *  inject the notice, or a post-compaction ghost launch event). This is the
 *  backstop that keeps the bottom-right roster from accreting stale rows; the
 *  finish-notice path still clears the clean case instantly. Generous so a
 *  single long silent tool call inside a background subagent doesn't blink it
 *  out (it re-appears on its next progress frame if still alive). */
const STALE_ROSTER_MS = 30_000;

/** '.ext' when the filename carries a renderable image extension — the
 *  picker's fallback for providers that report an empty MIME type (mirrors
 *  the server upload route's accept rule). */
function imageExtFromName(name: string): string | null {
  const m = /\.[a-z0-9]+$/i.exec(name);
  const ext = m ? m[0].toLowerCase() : '';
  return ext && ext in IMAGE_MIME_BY_EXT ? ext : null;
}

/**
 * Chat view of the Claude session tracked in a pane. Connects to
 * /ws/chat/:paneId, replays the transcript as chat, then streams live turns
 * (dedupes by event id — the server may re-emit history after a compaction
 * rewrite). The composer drives the session (a headless turn). Switching
 * between terminal and chat — and stopping/relaunching the underlying Claude —
 * is owned by the pane's Terminal/Chat toggle, so by the time chat is showing,
 * it is already the driver.
 */
export function ChatPane({
  paneId,
  active,
  agentNative = false,
  pendingPick = false,
}: {
  paneId: string;
  active: boolean;
  /** Pane runs `muxpad agent` (durable startup_cmd marker). */
  agentNative?: boolean;
  /** Pane was created "Agent" with no harness chosen yet (`--pick`) — the chat
   *  shows the harness picker instead of a session. */
  pendingPick?: boolean;
}) {
  // undefined = still connecting; null = connected but no agent session.
  const [session, setSession] = useState<SessionMeta | null | undefined>(undefined);
  const [events, setEvents] = useState<ChatEvent[]>([]);
  // Ordered event list (source of truth for `events`). The server sends the
  // recent tail first, then older batches on demand — which must be PREPENDED,
  // so we keep an explicit array rather than relying on Map insertion order.
  const ordered = useRef<ChatEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const byId = useRef(new Set<string>()); // seen event ids, for dedupe
  // The sid whose events are currently rendered — a mid-mount sid change
  // (/clear, resume rotation) wipes the log (see the session handler).
  const renderedSid = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);
  // Live mirror of `active` for the WS message handler's closures (which
  // capture it at subscription time) — see the turn-done seen-clear.
  const activeRef = useRef(active);
  activeRef.current = active;
  const wsRef = useRef<WebSocket | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Composer draft, persisted per pane: switching sidebar tabs unmounts the
  // whole pane tree, so plain state would wipe half-typed messages. Restored
  // on mount, cleared when the input empties (send, or manual delete).
  // Device-local by design — a draft is not cross-device state.
  const draftKey = `muxpad.chatDraft.${paneId}`;
  const [input, setInput] = useState(() => {
    try {
      return localStorage.getItem(draftKey) ?? '';
    } catch {
      return '';
    }
  });
  useEffect(() => {
    try {
      if (input) localStorage.setItem(draftKey, input);
      else localStorage.removeItem(draftKey);
    } catch {
      // storage unavailable (private mode / quota) — drafts just don't persist
    }
  }, [input, draftKey]);
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  // tone 'info' = transient connection chatter (reconnecting, not connected
  // yet) — rendered as a quiet muted line and auto-cleared when the socket
  // recovers. tone 'danger' = a real failure (turn failed, send rejected)
  // that keeps the loud styling and sticks until the next turn.
  const [notice, setNotice] = useState<{ text: string; tone: 'info' | 'danger' } | null>(null);
  // Older-history pagination: the server opens with just the recent tail; we
  // page earlier messages in on scroll-up. `hasMoreOlder` starts true and is
  // corrected by the server's `older-done`; `olderAnchor` preserves the scroll
  // position across a prepend so the view doesn't jump.
  const [hasMoreOlder, setHasMoreOlder] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const loadingOlderRef = useRef(false);
  // The in-flight request's safety-net timer — cleared when `older-done` lands
  // (or on unmount/pane switch) so a stale timer can't fire into a LATER
  // request and clear its loading flag mid-flight.
  const olderTimeout = useRef<number | undefined>(undefined);
  const olderAnchor = useRef<{ height: number; top: number } | null>(null);
  // Tool calls collapse to a one-line summary; tapping opens this modal with the
  // full command + output. null = closed.
  const [openTool, setOpenTool] = useState<ToolDetail | null>(null);
  // A pasted image opened full-size in a lightbox from history. null = closed.
  const [openImage, setOpenImage] = useState<{
    url: string;
    name: string;
    video: boolean;
  } | null>(null);
  // Floating "jump to latest" arrow — shown only when scrolled up off the bottom.
  const [showScrollDown, setShowScrollDown] = useState(false);
  // The floating composer overlaps the scroll area, so we reserve its exact
  // measured height as bottom padding — that way, scrolled all the way down, the
  // last message clears the box instead of hiding behind it (the box grows with
  // multi-line input + the mobile safe-area, so a fixed guess isn't enough).
  const composerRef = useRef<HTMLDivElement>(null);
  const [composerH, setComposerH] = useState(0);
  // Live assistant text streamed from the headless turn (token-level), shown
  // as a preview until the final message lands in the transcript tail.
  const [streamingText, setStreamingText] = useState('');
  // A session whose transcript never shows up (ended, or its file is gone):
  // after a grace period, say so instead of spinning "waiting" forever.
  const [stale, setStale] = useState(false);
  // The message you just sent, shown immediately as a user bubble until the
  // real one lands from the transcript tail (then deduped away).
  const [optimisticUser, setOptimisticUser] = useState<string | null>(null);
  // An agent question awaiting the user (the runner's ask_user tool) —
  // rendered as tappable option chips at the end of the conversation.
  const [question, setQuestion] = useState<PendingQuestion | null>(null);
  // Live per-task subagent progress, keyed by the Task tool-use id.
  const [subagents, setSubagents] = useState<Record<string, SubagentProgress>>({});
  // Last progress-frame arrival per task — the staleness horizon for the
  // running-subagents indicator (a background task that's gone silent past
  // it reads as done, not running; its tool_result may never stream here).
  const subagentSeenAt = useRef(new Map<string, number>());
  // Expanded action-run blocks, keyed by the run's first event id.
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  // Runner-pushed session status: model, context fill, available models.
  // null = no runner status yet (TUI-view chats never get one).
  const [agentStatus, setAgentStatus] = useState<AgentStatus | null>(null);
  const [folder, setFolder] = useState<{ cwd: string; hasProject: boolean } | null>(null);
  // The text of the in-flight send, held so a socket death before the ack
  // can restore it into the composer instead of losing it.
  const pendingText = useRef('');
  // Delivery tracking. A send on a half-dead socket (mobile coming back from
  // background) vanishes silently — the browser reports the socket open until
  // the TCP timeout. The server acks every received frame; if neither an ack
  // nor a close arrives in time, we restore the composer instead of spinning
  // on a message that went nowhere.
  const acked = useRef(true);
  const sendWatchdog = useRef<number | undefined>(undefined);
  // Escape hatch to trigger an immediate reconnect from outside the effect
  // (assigned inside it, where the socket machinery lives).
  const reconnectNow = useRef<() => void>(() => {});
  // App-level heartbeat: browsers can't observe ws protocol pings, so the
  // client pings over the JSON channel and treats a missing pong as a zombie
  // socket (mobile networks kill connections without a close event). This
  // catches death while IDLE — the send watchdog only catches it on send.
  const lastPongAt = useRef(0);

  useEffect(() => {
    byId.current = new Set();
    ordered.current = [];
    setEvents([]);
    setSession(undefined);
    setSending(false);
    setNotice(null);
    setOptimisticUser(null);
    setQuestion(null);
    setSubagents({});
    setHasMoreOlder(true);
    setLoadingOlder(false);
    loadingOlderRef.current = false;
    window.clearTimeout(olderTimeout.current);
    olderTimeout.current = undefined;
    olderAnchor.current = null;
    acked.current = true;
    pendingText.current = '';
    window.clearTimeout(sendWatchdog.current);

    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;

    const onMessage = (ev: MessageEvent) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '') as ServerMsg;
      } catch {
        return;
      }
      // ANY server frame proves the socket is alive — a busy server (large
      // transcript read stalling the pong) must not read as a zombie while
      // stream deltas are flowing.
      lastPongAt.current = Date.now();
      if (msg.t === 'session') {
        // Session-id changed under the same pane (/clear starts fresh, a
        // resume rotates ids): the rendered log belongs to the OLD id — wipe
        // it and let the rebound tail re-deliver the new transcript's
        // history (for a resume that includes the carried-over messages; for
        // /clear it's empty, which is the point).
        const newSid = msg.session?.current_sid ?? null;
        if (newSid && renderedSid.current && renderedSid.current !== newSid) {
          byId.current = new Set();
          ordered.current = [];
          setEvents([]);
          setStreamingText('');
          setHasMoreOlder(true);
        }
        if (newSid) renderedSid.current = newSid;
        setSession(
          msg.session
            ? {
                current_sid: msg.session.current_sid,
                writer: msg.session.writer,
                view_mode: msg.session.view_mode,
                assistant: msg.session.assistant,
              }
            : null,
        );
        // A (re)connect that lands mid-turn restores the working/Stop state —
        // the turn's frames now broadcast to every socket of the pane, so this
        // socket will get the stream/turn-done too. streamText carries the
        // partial assistant message so far.
        if (msg.turnRunning) {
          setSending(true);
          if (msg.streamText) {
            // The hello's streamText is the WHOLE turn's accumulated buffer —
            // including text that already landed in the transcript. On a
            // same-socket-lifecycle reconnect those landed messages are
            // already rendered (and dedupe away from the history replay), so
            // consume them here or every text segment of the turn shows
            // twice. (On a fresh remount ordered is still empty → landed is
            // [] → the whole buffer shows, then the history replay below
            // strips block by block as it lands.)
            setStreamingText(consumeStreamedText(msg.streamText, landedThisTurn(ordered.current)));
          }
        }
        setQuestion(msg.question ?? null);
        // Mirror the hello exactly: no status means no live runner status —
        // a stale chip would keep offering controls that go nowhere.
        setAgentStatus(msg.status ?? null);
        setFolder(msg.cwd ? { cwd: msg.cwd, hasProject: msg.hasProject ?? false } : null);
        if (msg.subagents) {
          const now = Date.now();
          // Full snapshot — REBUILD the seen-at map too (a plain set would
          // leak entries for tasks the snapshot no longer carries).
          subagentSeenAt.current = new Map(msg.subagents.map((p) => [p.toolUseId, now]));
          setSubagents(Object.fromEntries(msg.subagents.map((p) => [p.toolUseId, p])));
        }
      } else if (msg.t === 'events') {
        const fresh = msg.events.filter((e) => !byId.current.has(e.id));
        // A subagent's FINISH notice (matched by tool-use-id) ends it — prune
        // its live-detail entry so the map doesn't grow across a long session.
        // (NOT its tool_result: for a background agent that's the immediate
        // launch ack, which would wipe the detail the moment it launches.)
        const finishedNow = fresh
          .filter(
            (e): e is Extract<ChatEvent, { kind: 'notice' }> =>
              e.kind === 'notice' && e.variant === 'task' && !!e.toolUseId,
          )
          .map((e) => e.toolUseId as string);
        if (finishedNow.length) {
          for (const id of finishedNow) subagentSeenAt.current.delete(id);
          setSubagents((m) => {
            if (!finishedNow.some((id) => id in m)) return m;
            const next = { ...m };
            for (const id of finishedNow) delete next[id];
            return next;
          });
        }
        if (fresh.length) {
          for (const e of fresh) byId.current.add(e.id);
          // Assistant text that just landed in the transcript leaves the
          // streaming preview, or it would render twice until turn end.
          // 'history' matters as much as 'live': a mid-turn (re)connect —
          // tab switch remounting this pane, heartbeat reconnect — restores
          // the FULL stream buffer from the hello, while the turn's already-
          // landed messages replay as history. Without consuming those, every
          // text segment of the turn shows again, concatenated, until
          // turn-done. Scope to the CURRENT turn (landedThisTurn) so a prior
          // turn's text can't become the tail anchor and wrongly clear the
          // live first block. Only 'older' pages are excluded — back-scrolled
          // ancient messages must never touch the live preview.
          if (msg.phase !== 'older') {
            const landed = landedThisTurn([...ordered.current, ...fresh]);
            if (landed.length) setStreamingText((s) => (s ? consumeStreamedText(s, landed) : s));
          }
          if (msg.phase === 'older') {
            // Anchor the scroll to the current top so the prepend (which grows
            // content above the viewport) doesn't yank the view — see the
            // useLayoutEffect below. The batch is chronological and entirely
            // before the current head, so prepend it wholesale.
            const el = scrollRef.current;
            if (el) olderAnchor.current = { height: el.scrollHeight, top: el.scrollTop };
            ordered.current = [...fresh, ...ordered.current];
          } else {
            ordered.current = [...ordered.current, ...fresh];
          }
          setEvents(ordered.current);
        }
      } else if (msg.t === 'older-done') {
        window.clearTimeout(olderTimeout.current);
        olderTimeout.current = undefined;
        setHasMoreOlder(msg.hasMore);
        setLoadingOlder(false);
        loadingOlderRef.current = false;
      } else if (msg.t === 'send-ack') {
        acked.current = true;
        window.clearTimeout(sendWatchdog.current);
      } else if (msg.t === 'pong') {
        lastPongAt.current = Date.now();
      } else if (msg.t === 'turn-start') {
        acked.current = true;
        window.clearTimeout(sendWatchdog.current);
        setSending(true);
        setNotice(null);
        setStreamingText('');
        pendingText.current = '';
      } else if (msg.t === 'stream') {
        setStreamingText((s) => s + msg.delta);
      } else if (msg.t === 'turn-done') {
        setSending(false);
        setStreamingText('');
        setOptimisticUser(null);
        setQuestion(null);
        // BACKGROUND subagents outlive the turn — keep their progress so the
        // running-subagents indicator stays honest (each entry hides when its
        // tool_result lands). A failed/stopped turn kills subagents with it
        // (live-verified: Stop interrupts background tasks too) — clear the live
        // detail AND the seen-at clocks, so the transcript-driven roster evicts
        // their now-orphaned launches on the next render (they'll read as stale
        // immediately rather than lingering the full STALE_ROSTER_MS).
        if (msg.ok === false) {
          setSubagents({});
          subagentSeenAt.current.clear();
        }
        setNotice(msg.ok ? null : { text: msg.error ?? 'turn failed', tone: 'danger' });
        // If you're looking at this pane when the turn finishes, it's already
        // "read" — clear the server's "done, unreviewed" bold immediately so
        // the nav never flickers unread for the pane you're actively watching.
        // (The server marks unread on every unobserved turn-done; being here IS
        // observing.) No-op when the pane already isn't unread.
        if (activeRef.current) void api.markPaneSeen(paneId).catch(() => {});
      } else if (msg.t === 'question') {
        setQuestion({ qid: msg.qid, questions: msg.questions });
      } else if (msg.t === 'question-done') {
        setQuestion((q) => (q?.qid === msg.qid ? null : q));
      } else if (msg.t === 'subagent') {
        subagentSeenAt.current.set(msg.progress.toolUseId, Date.now());
        setSubagents((m) => ({ ...m, [msg.progress.toolUseId]: msg.progress }));
      } else if (msg.t === 'status') {
        setAgentStatus((prev) => {
          const next: AgentStatus = {
            model: msg.model,
            ...(msg.context ? { context: msg.context } : {}),
            ...(msg.models ? { models: msg.models } : {}),
          };
          // Identical payload → keep the previous object so React skips the
          // re-render (the runner already suppresses no-op frames; this is
          // the client-side belt to its braces).
          return prev && JSON.stringify(prev) === JSON.stringify(next) ? prev : next;
        });
      } else if (msg.t === 'notice') {
        setNotice({ text: msg.message, tone: 'info' });
      } else if (msg.t === 'error') {
        acked.current = true;
        window.clearTimeout(sendWatchdog.current);
        setSending(false);
        // The send was rejected — its message never reaches the transcript,
        // so the optimistic bubble would otherwise stick around forever.
        setOptimisticUser(null);
        pendingText.current = '';
        setNotice({ text: msg.message, tone: 'danger' });
      }
    };

    const connect = () => {
      if (cancelled) return;
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${proto}//${location.host}/ws/chat/${paneId}`);
      wsRef.current = ws;
      ws.onopen = () => {
        attempt = 0;
        setConnected(true);
        // A recovered socket makes "reconnecting…" chatter stale — clear it
        // (real failures stay until the next turn resolves them).
        setNotice((n) => (n?.tone === 'info' ? null : n));
      };
      ws.onmessage = onMessage;
      ws.onerror = () => {
        try {
          ws.close();
        } catch {
          // ignore; onclose drives the retry
        }
      };
      ws.onclose = () => {
        setConnected(false);
        // Reset the composer while disconnected so it doesn't sit on Stop with
        // a frozen preview. If a turn is still running server-side, the
        // reconnect's session hello (turnRunning) restores the working state,
        // and the turn's frames broadcast to the new socket.
        setSending(false);
        setStreamingText('');
        // A send the server never acked died with this socket — put the text
        // back in the composer and drop the optimistic bubble, so the message
        // isn't silently lost (nor blindly re-sent, which could double it).
        if (!acked.current) {
          acked.current = true;
          window.clearTimeout(sendWatchdog.current);
          const lost = pendingText.current;
          pendingText.current = '';
          setOptimisticUser(null);
          if (lost) {
            setInput((prev) => prev || lost);
            setNotice({
              text: 'Connection dropped before the message was sent — try again.',
              tone: 'info',
            });
          }
        }
        if (cancelled) return;
        // Reconnect with backoff — covers server restarts, network blips, and
        // the mobile tab being backgrounded (which drops the socket). Replaying
        // history on reconnect dedupes into byId, so no duplicates.
        retryTimer = setTimeout(connect, Math.min(1000 * 2 ** attempt, 10000));
        attempt += 1;
      };
    };

    // Immediate reconnect if the socket is down — skipping any pending backoff.
    // A socket already up or coming up is left alone; CLOSING too: its onclose
    // will schedule the retry, and connecting now would leave a duplicate.
    const kick = () => {
      if (cancelled) return;
      const rs = wsRef.current?.readyState;
      if (rs === WebSocket.OPEN || rs === WebSocket.CONNECTING || rs === WebSocket.CLOSING) return;
      if (retryTimer) clearTimeout(retryTimer);
      attempt = 0;
      connect();
    };
    reconnectNow.current = kick;
    // Reconnect right away when the tab returns to the foreground, instead of
    // waiting out the backoff (mobile drops the socket while backgrounded).
    const onVisible = () => {
      if (document.visibilityState === 'visible') kick();
    };
    document.addEventListener('visibilitychange', onVisible);
    connect();

    // Heartbeat sweep. Only while visible — a backgrounded tab's socket is
    // expected to die, and the visibilitychange handler reconnects on return.
    const heartbeat = window.setInterval(() => {
      if (cancelled || document.visibilityState !== 'visible') return;
      const sock = wsRef.current;
      if (!sock || sock.readyState !== WebSocket.OPEN) return;
      const pingSentAt = Date.now();
      try {
        sock.send(JSON.stringify({ t: 'ping' }));
      } catch {
        return; // dying socket; onclose drives the retry
      }
      window.setTimeout(() => {
        // No pong since this ping → zombie. Close it; the backoff machinery
        // (plus onVisible) brings up a fresh socket.
        if (!cancelled && wsRef.current === sock && lastPongAt.current < pingSentAt) {
          try {
            sock.close();
          } catch {
            // already closing
          }
        }
      }, 8000);
    }, 20000);

    return () => {
      cancelled = true;
      window.clearInterval(heartbeat);
      if (retryTimer) clearTimeout(retryTimer);
      window.clearTimeout(olderTimeout.current);
      olderTimeout.current = undefined;
      window.clearTimeout(sendWatchdog.current);
      document.removeEventListener('visibilitychange', onVisible);
      const ws = wsRef.current;
      wsRef.current = null;
      ws?.close();
    };
  }, [paneId]);

  // Watchdog: a socket can look OPEN yet be dead (mobile background/network
  // flip) — a send then vanishes with no close event for minutes. No ack in
  // time → restore the composer and close the zombie so the backoff machinery
  // brings up a fresh socket (a close on a dead link can dawdle in CLOSING,
  // so don't wait for onclose to do the restoring). Armed by every path that
  // fires a `send` frame.
  const armSendWatchdog = (text: string) => {
    acked.current = false;
    window.clearTimeout(sendWatchdog.current);
    sendWatchdog.current = window.setTimeout(() => {
      if (acked.current) return;
      acked.current = true;
      pendingText.current = '';
      setSending(false);
      setOptimisticUser(null);
      setInput((prev) => prev || text);
      setNotice({ text: 'Message not delivered — reconnecting. Try again.', tone: 'info' });
      try {
        wsRef.current?.close();
      } catch {
        // already closing
      }
    }, 6000);
  };

  // Queued messages: composed while the agent is busy, held here, and flushed
  // one at a time the moment a turn finishes (the effect below). Each keeps its
  // prose + attachment previews so it can be restored into the composer to edit
  // before it ever runs. The blob preview URLs are TRANSFERRED into the queued
  // item (not revoked) so the thumbnails survive the trip; revoked on send.
  const [queued, setQueued] = useState<
    { id: number; text: string; attachments: { path: string; name: string; previewUrl: string }[] }[]
  >([]);
  const queuedIdRef = useRef(0);
  const queuedRef = useRef(queued);
  queuedRef.current = queued;
  useEffect(
    () => () => {
      for (const q of queuedRef.current)
        for (const a of q.attachments) URL.revokeObjectURL(a.previewUrl);
    },
    [],
  );

  // Fire a composed message onto the live socket. Returns false (and leaves the
  // caller's draft intact) when the socket isn't open, so the queue flusher can
  // retry on reconnect. Shared by a direct send and a queued flush.
  const dispatchSend = (outgoing: string): boolean => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    pendingText.current = outgoing;
    setOptimisticUser(outgoing); // show it immediately, don't wait for the transcript
    ws.send(JSON.stringify({ t: 'send', text: outgoing }));
    setNotice(null);
    setSending(true);
    armSendWatchdog(outgoing);
    return true;
  };

  // Stash the composed message to auto-send when the current turn ends. Keeps
  // the prose + attachment previews; clears the composer WITHOUT revoking the
  // blob URLs (the queued item now owns them, so its thumbnail stays live).
  const queueMessage = () => {
    const text = input.trim();
    const attachments = chipsRef.current.map((c) => ({
      path: c.path,
      name: c.name,
      previewUrl: c.previewUrl,
    }));
    if (!text && attachments.length === 0) return;
    setQueued((q) => [...q, { id: (queuedIdRef.current += 1), text, attachments }]);
    setInput('');
    setChips([]); // ownership transferred to the queued item — do NOT revoke
  };

  // Pull a queued message back into the composer to edit before it runs.
  const restoreQueued = (id: number) => {
    const item = queuedRef.current.find((q) => q.id === id);
    if (!item) return;
    setQueued((q) => q.filter((x) => x.id !== id));
    setInput((cur) => (cur.trim() ? `${item.text}\n${cur}` : item.text));
    setChips((prev) => [
      ...prev,
      ...item.attachments.map((a) => ({ path: a.path, name: a.name, previewUrl: a.previewUrl })),
    ]);
    inputRef.current?.focus();
  };

  const sendMessage = () => {
    const text = input.trim();
    // Attachment paths ride along at the END of the message — Claude reads
    // the path, not the pixels. The draft box stays clean prose.
    const attachmentPaths = chips.map((c) => c.path);
    if (!text && attachmentPaths.length === 0) return;
    // While a question card is showing, the composer IS the free-text answer
    // — a normal send would silently queue behind the blocked turn and
    // vanish until it ends (the tool description promises typed answers).
    if (question) {
      if (!text) return;
      answerQuestion(
        question.qid,
        question.questions.map((q) => ({ question: q.question, answers: [text] })),
      );
      setInput('');
      return;
    }
    // Agent busy → queue it instead of blocking; the flusher sends it when the
    // turn ends. (Previously this was a silent no-op.)
    if (sending) {
      queueMessage();
      return;
    }
    const outgoing = [text, ...attachmentPaths].filter(Boolean).join(' ');
    if (!dispatchSend(outgoing)) {
      // Don't fire into a dead socket (the browser would drop it silently).
      // Keep the text (and chips) in the composer, kick a reconnect, retry.
      setNotice({ text: 'Reconnecting — try again in a moment.', tone: 'info' });
      reconnectNow.current();
      return;
    }
    setInput('');
    clearChips();
  };
  const stop = () => wsRef.current?.send(JSON.stringify({ t: 'stop' }));

  // Flush the queue one message per turn: when the socket is idle (not sending)
  // and connected, dequeue the oldest and send it. Sending flips `sending`
  // true, so the next flush waits for that turn's turn-done — the messages run
  // in order, never piling into one turn.
  useEffect(() => {
    if (sending || queued.length === 0 || !connected) return;
    const [next, ...rest] = queued;
    if (!next) return;
    const outgoing = [next.text, ...next.attachments.map((a) => a.path)].filter(Boolean).join(' ');
    if (dispatchSend(outgoing)) {
      setQueued(rest);
      for (const a of next.attachments) URL.revokeObjectURL(a.previewUrl);
    }
    // dispatchSend false (socket not open) → keep the queue; retry when
    // `connected` flips true again.
    // biome-ignore lint/correctness/useExhaustiveDependencies: dispatchSend is re-created each render; the send triggers are sending/queued/connected.
  }, [sending, queued, connected]);

  const answerQuestion = (qid: string, answers: Array<{ question: string; answers: string[] }>) => {
    wsRef.current?.send(JSON.stringify({ t: 'answer', qid, answers }));
    // Optimistic dismiss; the server's question-done broadcast confirms it
    // (and clears it on every other device's view too).
    setQuestion((q) => (q?.qid === qid ? null : q));
  };

  // Photo picker → upload via the same attachments endpoint the TUI composer
  // uses, then append the returned path(s) to the message so Claude reads the
  // image. accept="image/*" with no `capture` → the OS sheet offers library +
  // camera. Empty-type files (HEIC / some Android providers) are kept.
  const onPickImages = async (e: ChangeEvent<HTMLInputElement>) => {
    const el = e.target;
    // Accept exactly what the server upload route accepts: a renderable
    // MIME, or a renderable filename extension when the provider reports no
    // type (HEIC pickers / some Android providers hand over type='').
    // Dropping anything is LOUD — a silently-swallowed pick reads as "the
    // app is broken".
    const all = Array.from(el.files ?? []);
    const files = all.filter(
      (f) => imageExtForMime(f.type) !== null || imageExtFromName(f.name) !== null,
    );
    if (files.length < all.length) {
      setNotice({
        text: `some files were skipped — unsupported image type`,
        tone: 'danger',
      });
    }
    el.value = ''; // reset so re-picking the same file still fires onChange
    if (files.length === 0) return;
    setUploading(true);
    const paths: string[] = [];
    for (const f of files) {
      try {
        const { path } = await api.uploadAttachment(paneId, f, f.name || 'image.png');
        paths.push(path);
        addChip(path, f);
      } catch {
        // drop this one; the rest still upload
      }
    }
    setUploading(false);
    if (paths.length === 0) return;
    setInput((prev) => `${prev}${prev && !prev.endsWith(' ') ? ' ' : ''}${paths.join(' ')} `);
    inputRef.current?.focus();
  };

  // Pasting/picking an image uploads it to the pane's attachment dir and
  // appends the returned path to the message (Claude reads the path, not the
  // pixels). Each upload also leaves a persistent preview chip beside the
  // composer, so you can see the image that went in for as long as its path is
  // still in the draft. The blob URL gives an instant thumbnail without a
  // round-trip; it is revoked when the chip drops.
  const [chips, setChips] = useState<{ path: string; name: string; previewUrl: string }[]>([]);
  const chipsRef = useRef(chips);
  chipsRef.current = chips;
  const addChip = (path: string, blob: Blob) => {
    const name = path.split('/').pop() ?? path;
    setChips((prev) => [...prev, { path, name, previewUrl: URL.createObjectURL(blob) }]);
  };
  // Attachments are managed independently of the draft text now (their paths
  // are appended at send, not typed into the box): remove one via its × ,
  // clear all after a send. Both revoke the blob URL so previews don't leak.
  const removeChip = (path: string) => {
    setChips((prev) => {
      const ch = prev.find((c) => c.path === path);
      if (ch) URL.revokeObjectURL(ch.previewUrl);
      return prev.filter((c) => c.path !== path);
    });
  };
  const clearChips = () => {
    for (const ch of chipsRef.current) URL.revokeObjectURL(ch.previewUrl);
    setChips([]);
  };
  useEffect(
    () => () => {
      for (const ch of chipsRef.current) URL.revokeObjectURL(ch.previewUrl);
    },
    [],
  );


  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const data = e.clipboardData;
    if (!data) return;
    const { imageOnly, imageItems } = splitClipboard(data);
    if (imageItems.length === 0) return; // plain text — default paste
    // Swallow the event: the async upload finishes after the default paste
    // would have run, so we insert both path(s) and any companion text
    // ourselves for a deterministic order (macOS bundles a transient file://
    // URL with screenshots; companionTextForImagePaste drops it).
    e.preventDefault();
    const text = imageOnly ? '' : companionTextForImagePaste(data.getData('text/plain'));
    const blobs = imageItems.map((item) => item.getAsFile()).filter((b): b is File => b !== null);
    void (async () => {
      setUploading(true);
      const paths: string[] = [];
      for (const blob of blobs) {
        const ext = imageExtForMime(blob.type);
        if (!ext) {
          // A format the pipeline can't render end-to-end (e.g. image/heic) —
          // uploading it would leave a raw-path message and a 400ing GET.
          setNotice({ text: `unsupported image type: ${blob.type}`, tone: 'danger' });
          continue;
        }
        try {
          const { path } = await api.uploadAttachment(paneId, blob, `pasted${ext}`);
          paths.push(path);
          addChip(path, blob);
        } catch {
          setNotice({ text: 'image upload failed', tone: 'danger' });
        }
      }
      setUploading(false);
      // Only companion text goes into the draft — the image path is NOT
      // inserted. Attachments live as removable preview chips and are appended
      // to the message at send time, so the composer stays clean prose.
      if (text.trim()) {
        setInput((prev) => `${prev}${prev && !prev.endsWith(' ') ? ' ' : ''}${text.trim()} `);
      }
      inputRef.current?.focus();
    })();
  };

  // Keep pinned to the bottom as new events arrive, unless the user scrolled up.
  // `events` is a deliberate trigger dependency (we re-scroll on new events)
  // even though the body reads it only via the DOM.
  // The subagent trigger is the COUNT, not the map: progress ticks replace
  // the map object every ~500ms without changing content height, and each
  // firing costs a forced reflow (scrollHeight read). Rows appear/disappear
  // only when the count moves.
  // biome-ignore lint/correctness/useExhaustiveDependencies: events/streamingText/optimisticUser/question/subagent-count/queued-count are the scroll triggers
  useEffect(() => {
    const el = scrollRef.current;
    if (el && active && pinnedToBottom.current) el.scrollTop = el.scrollHeight;
  }, [
    events,
    streamingText,
    optimisticUser,
    question,
    Object.keys(subagents).length,
    queued.length,
    active,
  ]);

  // Auto-grow the composer like ChatGPT: reset to content height, capped by CSS
  // max-height (the textarea keeps scrolling past that). `input` is the trigger
  // (we measure the DOM, not read it), so keep it in the dep list.
  // biome-ignore lint/correctness/useExhaustiveDependencies: input is the resize trigger
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const max = Number.parseFloat(getComputedStyle(el).maxHeight) || Number.POSITIVE_INFINITY;
    el.style.height = `${el.scrollHeight}px`;
    // No scrollbar while growing; only reveal one once we hit the max height.
    el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden';
  }, [input]);

  // Track the floating composer's height so the scroll area can reserve exactly
  // that much bottom padding (see composerH usage on .chat-list). Re-attaches
  // when the composer mounts (session appears) and follows multi-line growth.
  // biome-ignore lint/correctness/useExhaustiveDependencies: current_sid gates when the composer (and its ref) mounts.
  useEffect(() => {
    const el = composerRef.current;
    if (!el) {
      setComposerH(0);
      return;
    }
    const measure = () => setComposerH(el.offsetHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [session?.current_sid]);

  // Type-to-focus: when this chat is the visible face and you start typing a
  // printable character with nothing else focused, jump focus to the composer so
  // the keystroke lands there (same as Slack/Discord). Skips modifier combos
  // (shortcuts), other inputs, and when the tool modal is open.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1) return;
      if (openTool || openImage) return;
      const input = inputRef.current;
      if (!input || document.activeElement === input) return;
      const ae = document.activeElement as HTMLElement | null;
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable))
        return;
      input.focus(); // the character then lands in the now-focused textarea
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, openTool, openImage]);

  // Restore & HOLD the remembered scroll on (re)activation. A ChatPane's
  // scroll height is NOT final when the first events render: the fill-viewport
  // pager keeps prepending older batches, image thumbnails load, and the sid
  // (staleness guard) may not be bound yet. A one-shot restore lands against a
  // partial height and drifts (the "doesn't always remember" bug). Instead,
  // re-apply the remembered RATIO each frame for a short settling window — it
  // converges as content arrives, and stops the instant the reader scrolls.
  const userScrolled = useRef(false);
  const lastProgrammaticTop = useRef(-1);
  useLayoutEffect(() => {
    if (!active) {
      userScrolled.current = false; // hidden panes lose scrollTop — re-restore on return
      return;
    }
    userScrolled.current = false;
    // Un-pin up front for a non-bottom memory so the follow-the-bottom effect
    // can't snap the reader down before the restore lands.
    const mem0 = recallChatScroll(paneId);
    if (mem0 && !mem0.pinned) pinnedToBottom.current = false;
    let raf = 0;
    const deadline = Date.now() + 1500;
    const apply = () => {
      raf = 0;
      const el = scrollRef.current;
      if (el && !userScrolled.current) {
        const mem = recallChatScroll(paneId);
        if (
          mem &&
          !mem.pinned &&
          mem.sid === renderedSid.current &&
          el.scrollHeight > el.clientHeight
        ) {
          pinnedToBottom.current = false;
          const target = Math.round(mem.ratio * (el.scrollHeight - el.clientHeight));
          if (Math.abs(el.scrollTop - target) > 1) {
            lastProgrammaticTop.current = target;
            el.scrollTop = target;
          }
        }
      }
      if (Date.now() < deadline && !userScrolled.current) raf = requestAnimationFrame(apply);
    };
    apply(); // first pass runs before paint — no flash
    return () => {
      if (raf) cancelAnimationFrame(raf);
    };
  }, [active, paneId]);

  // After an older-history batch prepends, content grew above the viewport;
  // restore the scroll so the messages the user was looking at stay put (runs
  // before paint, so there's no visible jump).
  // biome-ignore lint/correctness/useExhaustiveDependencies: events is the trigger — the effect fires after the prepend renders.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const a = olderAnchor.current;
    if (el && a) {
      el.scrollTop = el.scrollHeight - a.height + a.top;
      olderAnchor.current = null;
    }
  }, [events]);

  // Fill the viewport: the initial history window is a byte tail, and a few
  // huge records (base64 image pastes run to hundreds of KB per line) can
  // eat the whole window — rendering less than a screenful of chat. With no
  // overflow there are no scroll events, so the scroll-up pager could never
  // fire and the rest of the conversation was unreachable. Keep paging older
  // batches until the content overflows (or history is exhausted): requests
  // are single-flight, and every server call moves the byte cursor back, so
  // this terminates even when a batch renders nothing new.
  // biome-ignore lint/correctness/useExhaustiveDependencies: events/loadingOlder are the re-check triggers; requestOlder is stable enough per render
  useEffect(() => {
    if (!active || loadingOlder || !hasMoreOlder) return;
    if (!session?.current_sid) return; // history baseline not bound yet
    const el = scrollRef.current;
    if (!el || el.clientHeight < 40) return; // hidden/collapsed — don't page blind
    if (el.scrollHeight <= el.clientHeight + 1) requestOlder();
  }, [active, events, loadingOlder, hasMoreOlder, session?.current_sid]);

  const requestOlder = () => {
    if (loadingOlderRef.current || !hasMoreOlder) return;
    const ws = wsRef.current;
    if (ws?.readyState !== WebSocket.OPEN) return;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    ws.send(JSON.stringify({ t: 'load-older' }));
    // Safety net: if no `older-done` comes back (a dropped message, or a server
    // build without the handler), clear the spinner instead of hanging on it.
    window.clearTimeout(olderTimeout.current);
    olderTimeout.current = window.setTimeout(() => {
      olderTimeout.current = undefined;
      if (loadingOlderRef.current) {
        loadingOlderRef.current = false;
        setLoadingOlder(false);
      }
    }, 4000);
  };

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    // The settling restore above fires this too; a scroll AWAY from its last
    // programmatic target is the reader taking control — stop re-restoring.
    if (Math.abs(el.scrollTop - lastProgrammaticTop.current) > 1) userScrolled.current = true;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    pinnedToBottom.current = nearBottom;
    rememberChatScroll(paneId, {
      ratio: el.scrollTop / Math.max(1, el.scrollHeight - el.clientHeight),
      pinned: nearBottom,
      sid: renderedSid.current,
    });
    // Hysteresis: only reveal the arrow once meaningfully scrolled up, so it
    // doesn't flicker on tiny nudges near the bottom.
    setShowScrollDown(el.scrollHeight - el.scrollTop - el.clientHeight > 120);
    // Near the top → page in earlier messages (once events exist, so we don't
    // fire during the initial empty/loading state).
    if (el.scrollTop < 240 && events.length > 0) requestOlder();
  };

  const scrollToBottom = () => {
    const el = scrollRef.current;
    if (!el) return;
    pinnedToBottom.current = true;
    setShowScrollDown(false);
    // Record the re-pin immediately — the smooth scroll's own onScroll
    // events lag, and switching away mid-glide must not save a stale spot.
    rememberChatScroll(paneId, { ratio: 1, pinned: true, sid: renderedSid.current });
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  };

  // Grace timer: connected but still nothing to show after a while — either a
  // session with no transcript (likely ended) or no session at all (nothing
  // running here). Until it fires, show a spinner: an agent tab's runner
  // takes a few seconds to boot and register, and flashing "no session"
  // during that window reads as broken.
  useEffect(() => {
    setStale(false);
    if (!connected || session === undefined || events.length > 0) return;
    const t = setTimeout(() => setStale(true), 8000);
    return () => clearTimeout(t);
  }, [connected, session, events.length]);

  // Drop the optimistic user bubble once the real one lands from the transcript.
  useEffect(() => {
    if (optimisticUser && events.some((e) => e.kind === 'user' && e.text === optimisticUser)) {
      setOptimisticUser(null);
    }
  }, [events, optimisticUser]);

  // ONE tool-resolution index for everything below (and one place for the
  // "a tool_use is resolved when a tool_result shares its toolUseId" rule).
  // resultFor pairs each call with its result (the collapsed row opens both
  // in one modal; the standalone result row is then suppressed via
  // `consumed`). unresolvedTools is in event order, so its head is the
  // OLDEST still-running call — with parallel tool calls the last event is
  // often a sibling's result, which used to blank the working label.
  const toolIndex = useMemo(() => {
    const resultFor = new Map<string, ToolResultEvent>();
    for (const e of events) if (e.kind === 'tool_result') resultFor.set(e.toolUseId, e);
    const consumed = new Set<string>();
    const unresolvedTools: ToolUseEvent[] = [];
    const taskDescriptions = new Map<string, string>();
    for (const e of events) {
      if (e.kind !== 'tool_use') continue;
      const r = resultFor.get(e.toolUseId);
      if (r) consumed.add(r.id);
      else unresolvedTools.push(e);
      const input = e.input as { description?: string } | null;
      if (input?.description) taskDescriptions.set(e.toolUseId, input.description);
    }
    return { resultFor, consumed, unresolvedTools, taskDescriptions };
  }, [events]);

  const body = useMemo(() => {
    if (session === undefined)
      return (
        <div className="chat-empty">
          <div className="chat-empty-spinner" aria-hidden="true" />
          <p>{connected ? 'Loading conversation…' : 'Connecting…'}</p>
        </div>
      );
    if (session === null || !session.current_sid) {
      // Grace: a just-created agent tab has no session row until its runner
      // boots and hellos (a few seconds) — spin briefly before declaring
      // there's nothing here.
      if (!stale)
        return (
          <div className="chat-empty">
            <div className="chat-empty-spinner" aria-hidden="true" />
            <p>Starting…</p>
          </div>
        );
      return (
        <div className="chat-empty">
          <div className="chat-empty-mark" aria-hidden="true">
            ✳
          </div>
          <p className="chat-empty-title">No agent session here yet</p>
          <p className="chat-empty-hint">
            Start one with <code>muxpad agent</code> (chat-native) or <code>muxpad claude</code> in
            the terminal.
          </p>
        </div>
      );
    }
    if (events.length === 0 && !optimisticUser && !sending) {
      // A live agent runner with no transcript yet is a FRESH session (the
      // transcript file only appears on the first message) — greet, don't
      // spin for 8s and then claim the session "may have ended".
      if (session.writer === 'sdk')
        return (
          <div className="chat-empty">
            <div className="chat-empty-mark" aria-hidden="true">
              ✳
            </div>
            <p className="chat-empty-title">Ready when you are</p>
            <p className="chat-empty-hint">Send a message below to start this session.</p>
          </div>
        );
      return (
        <div className="chat-empty">
          {stale ? (
            <>
              <div className="chat-empty-mark" aria-hidden="true">
                ✳
              </div>
              <p className="chat-empty-title">No messages here</p>
              <p className="chat-empty-hint">
                This session may have ended. Switch to Terminal, or start a new one with{' '}
                <code>muxpad agent</code> (chat) or <code>muxpad claude</code> (terminal).
              </p>
            </>
          ) : (
            <>
              <div className="chat-empty-spinner" aria-hidden="true" />
              <p>Waiting for the first message…</p>
            </>
          )}
        </div>
      );
    }
    const { resultFor, consumed } = toolIndex;
    const renderEvent = (e: ChatEvent) => {
      if (e.kind === 'tool_use') {
        // A subagent launch reads as an event ("agent X launched"), not a
        // tool call — its own bubble, mirroring the finish notice.
        if (isAgentLaunch(e))
          return <AgentLaunchCard key={e.id} description={agentLaunchDescription(e)} />;
        return (
          <ToolRow key={e.id} use={e} result={resultFor.get(e.toolUseId)} onOpen={setOpenTool} />
        );
      }
      if (e.kind === 'tool_result') return <ToolRow key={e.id} result={e} onOpen={setOpenTool} />;
      return <ChatRow key={e.id} event={e} onOpenImage={setOpenImage} />;
    };

    // A long agentic stretch renders as ONE collapsed block instead of a
    // wall of per-action rows: consecutive tool/thinking events (an
    // "action run") fold behind a count + tool summary, expandable in
    // place. Real prose — user and assistant text — always breaks a run
    // and renders as normal messages. The in-flight run folds too (the
    // count ticks live; the working label names the running tool) —
    // rendering it unfolded made blocks visibly "merge" when the turn
    // closed, which read as a glitch.
    const renderable = events.filter((e) => !(e.kind === 'tool_result' && consumed.has(e.id)));
    // Agent launches break runs (like prose) so each renders as its own
    // launch bubble — never buried inside a "5 actions · Agent ×5" fold.
    const isAction = (e: ChatEvent) =>
      !isAgentLaunch(e) &&
      (e.kind === 'tool_use' || e.kind === 'tool_result' || e.kind === 'thinking');
    // Fold from TWO actions up — real transcripts are full of 2-3 action
    // stretches between prose, and leaving those inline read as "folding
    // doesn't work". A lone action stays inline.
    const MIN_GROUP = 2;
    const items: React.ReactNode[] = [];
    for (let i = 0; i < renderable.length; ) {
      const e = renderable[i] as ChatEvent;
      if (!isAction(e)) {
        items.push(renderEvent(e));
        i++;
        continue;
      }
      let j = i;
      while (j < renderable.length && isAction(renderable[j] as ChatEvent)) j++;
      const run = renderable.slice(i, j) as ChatEvent[];
      if (run.length < MIN_GROUP) {
        items.push(...run.map(renderEvent));
      } else {
        // Key stability differs by position: a CLOSED run never grows at
        // its tail but older-history prepends can extend its head — key by
        // LAST event. The TRAILING (possibly still growing) run gains
        // events at its tail but its head is fixed — key by FIRST event,
        // or every new action would reset the expansion.
        const trailing = j === renderable.length;
        const id = (run[trailing ? 0 : run.length - 1] as ChatEvent).id;
        items.push(
          <ActionGroup
            key={`group-${id}`}
            events={run}
            expanded={expandedGroups.has(id)}
            onToggle={() =>
              setExpandedGroups((prev) => {
                const next = new Set(prev);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next;
              })
            }
            renderEvent={renderEvent}
          />,
        );
      }
      i = j;
    }

    return (
      <>
        {loadingOlder ? (
          <div className="chat-load-earlier-spinner" aria-hidden="true">
            <div className="chat-empty-spinner" />
          </div>
        ) : null}
        {items}
      </>
    );
  }, [
    session,
    connected,
    events,
    stale,
    optimisticUser,
    sending,
    loadingOlder,
    expandedGroups,
    toolIndex,
  ]);

  // The agent is working when: we're driving a turn (`sending`), tokens are
  // streaming, OR — for sessions WITHOUT a runner (legacy/TUI views) — the
  // newest event is a tool_use still awaiting its result. That transcript
  // heuristic must never apply to agent panes: their turn frames are
  // authoritative, and a BACKGROUND subagent's dispatch legitimately leaves
  // its tool_result pending for minutes after the turn ended. Gated on the
  // DURABLE startup_cmd marker (agentNative), not the session writer — the
  // writer flips to 'none' whenever the runner is briefly detached, which
  // used to re-arm the heuristic on exactly the panes it was disabled for.
  const lastEvent = events[events.length - 1];
  const pendingTool =
    !agentNative && lastEvent?.kind === 'tool_use' && !toolIndex.resultFor.has(lastEvent.toolUseId);
  const agentWorking = Boolean((sending || streamingText || pendingTool) && session?.current_sid);

  // What the working row says. Bare dots read as "maybe stuck" during a long
  // silent tool call — name the OLDEST still-unresolved tool.
  const unresolvedTool = agentWorking ? (toolIndex.unresolvedTools[0] ?? null) : null;
  const workingLabel = unresolvedTool ? `Running ${unresolvedTool.name}…` : 'Working…';

  // The live roster is TRANSCRIPT-driven: every Agent/Task LAUNCH, minus the
  // ones whose FINISH task-notification has landed (matched by tool-use-id).
  // A background agent's own tool_result is only the IMMEDIATE launch ack, so
  // it cannot gate "running" (that dropped every agent seconds after launch);
  // the finish notice is the reliable end signal, and being transcript-based
  // this survives reconnects. The `subagents` map only supplies live detail
  // (steps / last tool) and the busy dot.
  const now = Date.now();
  // Collect FINISH task-notifications. Prefer the exact tool-use-id, but fall
  // back to the description embedded in the summary (`Agent "<desc>" finished`)
  // — the SERVER parses notices, and a server process predating the
  // tool-use-id change sends notices WITHOUT it, so id-only matching would
  // silently never remove anything (the roster accretes across rounds).
  // Description matches are counted so repeated names across rounds pair
  // launch↔finish FIFO.
  const finishedIds = new Set<string>();
  const finishByDesc = new Map<string, number>();
  for (const e of events) {
    if (e.kind !== 'notice' || e.variant !== 'task') continue;
    if (e.toolUseId) {
      finishedIds.add(e.toolUseId);
    } else {
      const m = /"([^"]+)"/.exec(e.text);
      if (m?.[1]) finishByDesc.set(m[1], (finishByDesc.get(m[1]) ?? 0) + 1);
    }
  }
  const seenAgentIds = new Set<string>();
  const rosterAgents: RosterAgent[] = [];
  for (const e of events) {
    if (e.kind !== 'tool_use' || !isAgentLaunch(e)) continue;
    const id = e.toolUseId;
    if (!id || seenAgentIds.has(id)) continue;
    // Finished if its FINISH notice landed (background), OR it has a real
    // (non-launch-ack) result (foreground). A background launch-ack does not
    // count — that was the bug that dropped every agent right after launch.
    const result = toolIndex.resultFor.get(id);
    const finishedByResult = !!result && !LAUNCH_ACK_RE.test(result.text ?? '');
    if (finishedIds.has(id) || finishedByResult) continue;
    const desc = agentLaunchDescription(e);
    // Consume a description-matched finish (only when no tool-use-id was sent).
    const descFinishes = finishByDesc.get(desc) ?? 0;
    if (descFinishes > 0) {
      finishByDesc.set(desc, descFinishes - 1);
      continue;
    }
    // Backstop against roster accretion: drop a launch that's gone quiet with
    // no parent turn driving it (see STALE_ROSTER_MS). During a turn we keep it
    // — a just-launched or long-silent-tool subagent legitimately has no recent
    // frame — and finish notices above still clear the clean case immediately.
    const seenAt = subagentSeenAt.current.get(id) ?? 0;
    if (!agentWorking && now - seenAt > STALE_ROSTER_MS) continue;
    seenAgentIds.add(id);
    const p = subagents[id];
    rosterAgents.push({
      id,
      label: desc,
      steps: p?.steps ?? 0,
      busy: now - (subagentSeenAt.current.get(id) ?? 0) < 6_000,
    });
  }
  // Each agent's busy/quiet dot is evaluated at render time — with a silent
  // background task nothing else triggers a re-render, so tick a few seconds
  // apart while any rows show to keep the dots honest.
  const [, forceStaleCheck] = useState(0);
  useEffect(() => {
    if (rosterAgents.length === 0) return;
    const t = window.setTimeout(() => forceStaleCheck((n) => n + 1), 3_000);
    return () => window.clearTimeout(t);
  });
  // Minimized by default: the header (count + spinner) already says "subagents
  // are working"; expand to see per-agent detail. Tap toggles.
  const [rosterOpen, setRosterOpen] = useState(false);

  // Harness pick: a `--pick` pane shows the picker here (not the tab bar);
  // choosing one sets the backend + respawns the runner, which flips the pane's
  // startup_cmd so pendingPick clears and the real session renders.
  const [pickBusy, setPickBusy] = useState<string | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);
  const choosePick = useCallback(
    async (backend: AgentBackendId) => {
      setPickBusy(backend);
      setPickError(null);
      try {
        await api.setAgentBackend(paneId, backend);
        // The pane.updated (new startup_cmd) clears pendingPick; keep the spinner
        // until this unmounts/re-renders without it.
      } catch (e) {
        setPickBusy(null);
        setPickError(e instanceof Error ? e.message : 'could not start the agent');
      }
    },
    [paneId],
  );

  if (pendingPick) {
    return (
      <div className="chat-pane">
        <div className="chat-empty chat-harness-pick">
          <p className="chat-empty-title">Choose an agent</p>
          <p className="chat-empty-hint">Which harness should drive this chat?</p>
          <div className="chat-harness-choices">
            {AGENT_BACKENDS.map((b) => (
              <button
                key={b.id}
                type="button"
                className="chat-harness-btn"
                disabled={pickBusy !== null}
                aria-busy={pickBusy === b.id}
                onClick={() => void choosePick(b.id)}
              >
                <AgentBackendLogo backend={b.id} size={22} />
                <span>{b.label}</span>
                {pickBusy === b.id ? <span className="chat-harness-spin" aria-hidden="true" /> : null}
              </button>
            ))}
          </div>
          {pickError ? <p className="chat-harness-error">{pickError}</p> : null}
        </div>
      </div>
    );
  }

  return (
    <div className="chat-pane">
      <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
        <div
          className="chat-list"
          style={composerH ? { paddingBottom: `${composerH + 14}px` } : undefined}
        >
          {body}
          {optimisticUser ? (
            <div className="chat-turn chat-turn-user">
              <div className="chat-bubble" dir="auto">
                <UserText text={optimisticUser} onOpenImage={setOpenImage} />
              </div>
            </div>
          ) : null}
          {agentWorking && !question ? (
            <div className="chat-turn chat-turn-assistant">
              {streamingText ? (
                <div className="chat-msg">
                  <Markdown text={streamingText} />
                  <span className="chat-cursor" aria-hidden="true" />
                </div>
              ) : (
                <div
                  className="chat-msg chat-working"
                  aria-label={`${assistantLabel(session?.assistant)} is working`}
                >
                  <span className="chat-typing" aria-hidden="true">
                    <i />
                    <i />
                    <i />
                  </span>
                  <span className="chat-working-label">{workingLabel}</span>
                </div>
              )}
            </div>
          ) : null}
          {question ? (
            <QuestionCard
              key={question.qid}
              pending={question}
              onAnswer={(answers) => answerQuestion(question.qid, answers)}
            />
          ) : null}
          {/* Queued messages ride at the BOTTOM of the chat — pending user
              bubbles under the latest message + working indicator, scrolling
              with the log (not pinned to the composer). Dashed + muted = "not
              sent yet"; the restore button pulls it back to edit. */}
          {queued.map((q) => (
            <div key={q.id} className="chat-turn chat-turn-user chat-turn-queued">
              <button
                type="button"
                className="chat-queued-edit"
                onClick={() => restoreQueued(q.id)}
                aria-label="Edit — restore to the composer"
                title="Queued — tap to edit before it sends"
              >
                <SvgRestore />
              </button>
              <div className="chat-bubble chat-bubble-queued" dir="auto">
                {q.attachments.length > 0 ? (
                  <div className="chat-queued-atts">
                    {q.attachments.map((a) => (
                      <img
                        key={a.path}
                        className="chat-queued-thumb"
                        src={a.previewUrl}
                        alt={a.name}
                      />
                    ))}
                  </div>
                ) : null}
                {q.text ? <div className="chat-queued-text">{q.text}</div> : null}
              </div>
            </div>
          ))}
        </div>
      </div>
      {showScrollDown ? (
        <button
          type="button"
          className="chat-scroll-down"
          style={composerH ? { bottom: `${composerH + 12}px` } : undefined}
          onClick={scrollToBottom}
          aria-label="Jump to latest"
          title="Jump to latest"
        >
          ↓
        </button>
      ) : null}
      {openTool ? <ToolModal detail={openTool} onClose={() => setOpenTool(null)} /> : null}
      {openImage ? (
        <ImageModal
          url={openImage.url}
          name={openImage.name}
          video={openImage.video}
          onClose={() => setOpenImage(null)}
        />
      ) : null}
      {session?.current_sid ? (
        <div className="chat-composer-wrap" ref={composerRef}>
          {notice ? (
            <div className={`chat-notice${notice.tone === 'danger' ? ' -danger' : ''}`}>
              {notice.text}
            </div>
          ) : null}
          {/* Live subagent roster — persistent, composer-adjacent, NEVER in
              the scroll. History is a timeline of things that happened (agent
              launched / finished boxes); what's running right now lives here
              and self-removes as agents finish. Its OWN right-aligned, width-
              capped block — kept out of the session-chip's width-linked column
              so a long "last tool" string truncates instead of ballooning the
              row off-screen. */}
          <SubagentRoster
            agents={rosterAgents}
            open={rosterOpen}
            onToggle={() => setRosterOpen((o) => !o)}
          />
          {agentStatus || folder ? (
            <div className="chat-session-row">
              {folder ? (
                <FolderChip cwd={folder.cwd} hasProject={folder.hasProject} paneId={paneId} />
              ) : null}
              {agentStatus ? (
              <SessionMenu
                status={agentStatus}
                {...(session?.assistant ? { assistant: session.assistant } : {})}
                send={(obj) => {
                  // Same guard as the composer: during the reconnect window
                  // wsRef can hold a CONNECTING socket (send throws) or a
                  // CLOSED one (silent drop) — fail loudly instead.
                  const sock = wsRef.current;
                  if (!sock || sock.readyState !== WebSocket.OPEN) {
                    setNotice({ text: 'Not connected — try again in a moment.', tone: 'info' });
                    return;
                  }
                  sock.send(JSON.stringify(obj));
                }}
              />
              ) : null}
            </div>
          ) : null}
          <div className="chat-composer">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={onPickImages}
            />
            <div className="chat-composer-main">
              <button
                type="button"
                className="chat-attach"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                aria-label="Add photo"
                title="Add photo"
              >
                {uploading ? (
                  <span className="chat-attach-spin" aria-hidden="true" />
                ) : (
                  <SvgCamera />
                )}
              </button>
              <textarea
                ref={inputRef}
                className="chat-input"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onPaste={onPaste}
                onKeyDown={(e) => {
                  // Desktop: Enter sends, Shift+Enter = newline. Mobile: the
                  // on-screen Return key inserts a newline (send is the button) —
                  // otherwise every line break fires off a message.
                  if (e.key === 'Enter' && !e.shiftKey && !isMobileLayout()) {
                    e.preventDefault();
                    sendMessage();
                  }
                }}
                placeholder={
                  question
                    ? 'Type an answer, or tap an option…'
                    : `Message ${assistantLabel(session?.assistant)}…`
                }
                rows={1}
              />
              {sending && !question ? (
                <>
                  {/* Busy + composed text → offer Queue (sends when the turn
                      ends) alongside Stop, instead of the old dead-end where a
                      typed message just wouldn't send. */}
                  {input.trim() || chips.length > 0 ? (
                    <button
                      type="button"
                      className="chat-send is-queue"
                      onClick={queueMessage}
                      aria-label="Queue message — sends when the agent is free"
                      title="Queue — sends when the agent is free"
                    >
                      <SvgQueue />
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="chat-send is-stop"
                    onClick={stop}
                    aria-label="Stop"
                    title="Stop"
                  >
                    <span className="chat-send-glyph" aria-hidden="true" />
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="chat-send"
                  onClick={sendMessage}
                  disabled={!input.trim() && chips.length === 0}
                  aria-label="Send"
                  title="Send"
                >
                  <span className="chat-send-glyph" aria-hidden="true">
                    ↑
                  </span>
                </button>
              )}
            </div>
            {/* Attachment previews live INSIDE the composer pill, as a row
                under the input — not a floating strip above it. */}
            {chips.length > 0 ? (
              <div className="chat-chips">
                {chips.map((ch) => (
                  <div key={ch.path} className="chat-chip" title={ch.name}>
                    <img className="chat-chip-thumb" src={ch.previewUrl} alt={ch.name} />
                    <button
                      type="button"
                      className="chat-chip-remove"
                      onClick={() => removeChip(ch.path)}
                      aria-label={`Remove ${ch.name}`}
                      title="Remove"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * A folded run of consecutive actions (tool calls + thinking) — long
 * agentic stretches read as one summarizable step, not a wall of rows.
 * The header names the mix ("14 actions · Bash ×6 · Edit ×4"), flags
 * failures, and expands in place to the ordinary per-action rows.
 */
function ActionGroup({
  events,
  expanded,
  onToggle,
  renderEvent,
}: {
  events: ChatEvent[];
  expanded: boolean;
  onToggle: () => void;
  renderEvent: (e: ChatEvent) => React.ReactNode;
}) {
  const counts = new Map<string, number>();
  let failed = 0;
  for (const e of events) {
    // Orphan tool_results (their tool_use never reached this pane) count as
    // actions too — a run of only results must not label itself '0 actions'.
    const name =
      e.kind === 'tool_use' ? e.name : e.kind === 'thinking' ? 'thinking' : 'result';
    counts.set(name, (counts.get(name) ?? 0) + 1);
    if (e.kind === 'tool_result' && !e.ok) failed++;
  }
  // Paired results ride their tool_use row, so only orphans reach this run —
  // but a tool_use + its paired result never co-occur here (consumed results
  // are filtered before grouping), making every event one visible action.
  const actions = events.length;
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  const summary = top.map(([name, n]) => (n > 1 ? `${name} ×${n}` : name)).join(' · ');
  return (
    <div className="chat-turn chat-turn-assistant">
      <div className="chat-msg chat-action-group">
        <button
          type="button"
          className="chat-action-group-head"
          aria-expanded={expanded}
          onClick={onToggle}
        >
          <span className={`chat-action-group-chevron${expanded ? ' is-open' : ''}`} aria-hidden="true">
            ›
          </span>
          <span className="chat-action-group-count">
            {actions} action{actions === 1 ? '' : 's'}
          </span>
          <span className="chat-action-group-summary">{summary}</span>
          {failed > 0 ? (
            <span className="chat-action-group-failed">
              {failed} failed
            </span>
          ) : null}
        </button>
        {expanded ? <div className="chat-action-group-body">{events.map(renderEvent)}</div> : null}
      </div>
    </div>
  );
}

/** Memoized: the chat body rebuilds its element list on every subagent
 *  progress frame (~2/s during turns); stable props must skip re-rendering
 *  (and re-parsing Markdown for) the entire transcript. */
const ChatRow = memo(function ChatRow({
  event,
  onOpenImage,
}: {
  event: ChatEvent;
  onOpenImage?: OpenMedia | undefined;
}) {
  switch (event.kind) {
    case 'user':
      return (
        <div className="chat-turn chat-turn-user">
          <div className="chat-bubble" dir="auto">
            <UserText text={event.text} onOpenImage={onOpenImage} />
          </div>
        </div>
      );
    case 'assistant':
      return (
        <div className="chat-turn chat-turn-assistant">
          <div className="chat-msg">
            <AssistantText text={event.text} onOpenImage={onOpenImage} />
          </div>
        </div>
      );
    case 'thinking':
      return (
        <div className="chat-turn chat-turn-assistant">
          <div className="chat-thinking" dir="auto">{event.text}</div>
        </div>
      );
    case 'notice':
      return <NoticeCard event={event} />;
    // tool_use / tool_result are rendered as collapsed ToolRows in the body map
    // (paired into one row), never through ChatRow.
    default:
      return null;
  }
});

// A user message may embed absolute paths to pasted/picked images. Render each
// as a clickable thumbnail (loaded over HTTP so it works from any device) while
// keeping the surrounding prose; the raw path stays in the title for reference.
function UserText({
  text,
  onOpenImage,
}: {
  text: string;
  onOpenImage?: OpenMedia | undefined;
}) {
  const parts = splitMessageAttachments(text);
  if (parts.length === 1 && parts[0]?.kind === 'text') return <>{text}</>;
  return (
    <>
      {renderMessageParts(
        parts,
        (t, key) => <span key={key}>{t}</span>,
        (m) => onOpenImage?.(m),
      )}
    </>
  );
}

// Assistant messages render as markdown, but the agent can SHOW files by
// including attachment paths (from the `show_files` tool) — same host-served
// bytes as pasted user images. Images/videos become an inline gallery, other
// files a click-to-open chip; prose runs render as markdown around them.
function AssistantText({
  text,
  onOpenImage,
}: {
  text: string;
  onOpenImage?: OpenMedia | undefined;
}) {
  const parts = splitMessageAttachments(text);
  if (parts.length === 1 && parts[0]?.kind === 'text') return <Markdown text={text} />;
  return (
    <>
      {renderMessageParts(
        parts,
        (t, key) => <Markdown key={key} text={t} />,
        (m) => onOpenImage?.(m),
      )}
    </>
  );
}

// Full-size pasted image in a lightbox; mirrors ToolModal's dismiss behaviour
// (Escape, backdrop scrim, close button).
function ImageModal({
  url,
  name,
  video,
  onClose,
}: {
  url: string;
  name: string;
  video: boolean;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="chat-modal-backdrop chat-img-backdrop">
      <button type="button" className="chat-modal-scrim" aria-label="Close" onClick={onClose} />
      {video ? (
        // biome-ignore lint/a11y/useMediaCaption: user-shared clip, no track available
        <video className="chat-img-full" src={url} controls autoPlay playsInline />
      ) : (
        <ZoomableImage url={url} name={name} />
      )}
      <button type="button" className="chat-img-close" onClick={onClose} aria-label="Close" title="Close">
        ×
      </button>
    </div>
  );
}

/**
 * The lightbox image with self-contained zoom — pinch + double-tap + drag on
 * touch, double-click + drag on desktop. Needed because muxpad's viewport meta
 * disables native page zoom (user-scalable=no) app-wide, so the OS pinch never
 * reaches the image. `touch-action: none` (CSS) hands every touch to us.
 *
 * Zoom is driven by the image's RENDERED SIZE (width/height), not a CSS
 * transform: a transform scales the already-downscaled bitmap on the GPU (soft
 * when you zoom in), whereas resizing the element makes the browser
 * re-rasterize from the full-resolution source — sharp up to the image's real
 * pixels. Pan still rides `transform: translate` (translation never blurs).
 */
function ZoomableImage({ url, name }: { url: string; name: string }) {
  const [scale, setScale] = useState(1);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  // The contained fit size at scale 1 (px), computed from the natural size and
  // the viewport — the base the zoom multiplies. null until the image loads.
  const [fit, setFit] = useState<{ w: number; h: number } | null>(null);
  const sRef = useRef(scale);
  sRef.current = scale;
  const pRef = useRef(pos);
  pRef.current = pos;
  const fitRef = useRef(fit);
  fitRef.current = fit;
  const imgRef = useRef<HTMLImageElement>(null);
  const g = useRef({
    mode: 'none' as 'none' | 'pan' | 'pinch',
    startDist: 0,
    startScale: 1,
    startX: 0,
    startY: 0,
    startCX: 0,
    startCY: 0,
    lastTap: 0,
  });
  const MAX = 5;

  const computeFit = () => {
    const img = imgRef.current;
    if (!img || !img.naturalWidth) return;
    const pad = 48;
    const r = Math.min(
      (window.innerWidth - pad) / img.naturalWidth,
      (window.innerHeight - pad) / img.naturalHeight,
      1,
    );
    setFit({ w: Math.round(img.naturalWidth * r), h: Math.round(img.naturalHeight * r) });
  };
  useEffect(() => {
    computeFit();
    window.addEventListener('resize', computeFit);
    return () => window.removeEventListener('resize', computeFit);
    // biome-ignore lint/correctness/useExhaustiveDependencies: one-time listener; reads live refs
  }, []);

  const clampScale = (s: number) => Math.min(MAX, Math.max(1, s));
  // Pan bound: how far the (scaled) image can move before its edge enters the
  // viewport — i.e. the overflow beyond the viewport, per axis.
  const clampXY = (x: number, y: number, s: number) => {
    const f = fitRef.current;
    if (!f) return { x: 0, y: 0 };
    const maxX = Math.max(0, (f.w * s - window.innerWidth) / 2);
    const maxY = Math.max(0, (f.h * s - window.innerHeight) / 2);
    return { x: Math.max(-maxX, Math.min(maxX, x)), y: Math.max(-maxY, Math.min(maxY, y)) };
  };
  const apply = (s: number, x: number, y: number) => {
    const c = clampXY(x, y, s);
    setScale(s);
    setPos(c);
  };
  // Toggle 1x ⇄ 2.5x, keeping the tapped/clicked point under the finger.
  const toggleZoom = (clientX: number, clientY: number) => {
    if (sRef.current > 1) {
      setScale(1);
      setPos({ x: 0, y: 0 });
      return;
    }
    const img = imgRef.current;
    if (!img) return;
    const r = img.getBoundingClientRect();
    const s = 2.5;
    const ox = clientX - (r.left + r.width / 2);
    const oy = clientY - (r.top + r.height / 2);
    apply(s, ox * (1 - s), oy * (1 - s));
  };

  const dist = (a: React.Touch, b: React.Touch) =>
    Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);

  const onTouchStart = (e: React.TouchEvent) => {
    const gs = g.current;
    if (e.touches.length === 2) {
      const [a, b] = [e.touches[0], e.touches[1]];
      if (!a || !b) return;
      gs.mode = 'pinch';
      gs.startDist = dist(a, b) || 1;
      gs.startScale = sRef.current;
      gs.startX = pRef.current.x;
      gs.startY = pRef.current.y;
      gs.startCX = (a.clientX + b.clientX) / 2;
      gs.startCY = (a.clientY + b.clientY) / 2;
    } else if (e.touches.length === 1) {
      const a = e.touches[0];
      if (!a) return;
      const now = Date.now();
      if (now - gs.lastTap < 300) {
        gs.lastTap = 0;
        gs.mode = 'none';
        toggleZoom(a.clientX, a.clientY);
        return;
      }
      gs.lastTap = now;
      gs.mode = sRef.current > 1 ? 'pan' : 'none';
      gs.startX = pRef.current.x;
      gs.startY = pRef.current.y;
      gs.startCX = a.clientX;
      gs.startCY = a.clientY;
    }
  };
  const onTouchMove = (e: React.TouchEvent) => {
    const gs = g.current;
    if (gs.mode === 'pinch' && e.touches.length === 2) {
      const [a, b] = [e.touches[0], e.touches[1]];
      if (!a || !b) return;
      const scale = clampScale(gs.startScale * (dist(a, b) / gs.startDist));
      const cx = (a.clientX + b.clientX) / 2;
      const cy = (a.clientY + b.clientY) / 2;
      apply(scale, gs.startX + (cx - gs.startCX), gs.startY + (cy - gs.startCY));
    } else if (gs.mode === 'pan' && e.touches.length === 1) {
      const a = e.touches[0];
      if (!a) return;
      apply(sRef.current, gs.startX + (a.clientX - gs.startCX), gs.startY + (a.clientY - gs.startCY));
    }
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    if (e.touches.length === 0) g.current.mode = 'none';
    // Pinched back to 1 → snap the pan to center.
    if (sRef.current <= 1 && (pRef.current.x !== 0 || pRef.current.y !== 0)) {
      setPos({ x: 0, y: 0 });
    }
  };

  // Desktop: drag to pan when zoomed.
  const drag = useRef<{ on: boolean; sx: number; sy: number; ox: number; oy: number }>({
    on: false,
    sx: 0,
    sy: 0,
    ox: 0,
    oy: 0,
  });
  const onMouseDown = (e: React.MouseEvent) => {
    if (sRef.current <= 1) return;
    e.preventDefault();
    drag.current = { on: true, sx: e.clientX, sy: e.clientY, ox: pRef.current.x, oy: pRef.current.y };
  };
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!drag.current.on) return;
      apply(
        sRef.current,
        drag.current.ox + (e.clientX - drag.current.sx),
        drag.current.oy + (e.clientY - drag.current.sy),
      );
    };
    const onUp = () => {
      drag.current.on = false;
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    // biome-ignore lint/correctness/useExhaustiveDependencies: stable listeners driven by refs
  }, []);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: image zoom surface; keyboard users close via Escape/× and don't need pan/zoom
    <img
      ref={imgRef}
      className={`chat-img-full chat-img-zoom${scale > 1 ? ' -zoomed' : ''}`}
      src={url}
      alt={name}
      draggable={false}
      onLoad={computeFit}
      // Size drives the zoom (browser re-rasterizes from source = sharp);
      // translate only pans. Before the image loads, fall back to the CSS
      // fit (max 100%). transform-origin stays center so pan math holds.
      style={
        fit
          ? {
              width: `${fit.w * scale}px`,
              height: `${fit.h * scale}px`,
              maxWidth: 'none',
              maxHeight: 'none',
              transform: `translate(${pos.x}px, ${pos.y}px)`,
            }
          : { transform: `translate(${pos.x}px, ${pos.y}px)` }
      }
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onDoubleClick={(e) => toggleZoom(e.clientX, e.clientY)}
      onMouseDown={onMouseDown}
    />
  );
}

/** Media (image/video) attachments rendered inline. One shows large; several
 *  collapse into a thumbnail grid (click → lightbox) so the chat doesn't grow a
 *  screenful per artifact. */
function MediaGallery({
  items,
  onOpen,
}: {
  items: { media: 'image' | 'video'; url: string; name: string }[];
  onOpen: (m: { url: string; name: string; video: boolean }) => void;
}) {
  if (items.length === 1) {
    const it = items[0];
    if (!it) return null;
    const video = it.media === 'video';
    return (
      <button
        type="button"
        className={`chat-img-thumb${video ? ' -video' : ''}`}
        title={it.name}
        onClick={() => onOpen({ url: it.url, name: it.name, video })}
      >
        {video ? (
          // biome-ignore lint/a11y/useMediaCaption: user-shared clip
          <video src={it.url} preload="metadata" muted playsInline />
        ) : (
          <img src={it.url} alt={it.name} loading="lazy" />
        )}
        {video ? <span className="chat-media-play" aria-hidden="true" /> : null}
      </button>
    );
  }
  return (
    <div className="chat-gallery" style={{ '--n': Math.min(items.length, 3) } as React.CSSProperties}>
      {items.map((it, i) => {
        const video = it.media === 'video';
        return (
          <button
            // Index-suffixed: the same attachment can legitimately appear twice
            // in one message, so the url alone isn't a unique key.
            // biome-ignore lint/suspicious/noArrayIndexKey: order is stable within a message
            key={`${it.url}-${i}`}
            type="button"
            className={`chat-gallery-item${video ? ' -video' : ''}`}
            title={it.name}
            onClick={() => onOpen({ url: it.url, name: it.name, video })}
          >
            {video ? (
              // biome-ignore lint/a11y/useMediaCaption: user-shared clip
              <video src={it.url} preload="metadata" muted playsInline />
            ) : (
              <img src={it.url} alt={it.name} loading="lazy" />
            )}
            {video ? <span className="chat-media-play" aria-hidden="true" /> : null}
          </button>
        );
      })}
    </div>
  );
}

/** Non-visual attachment (pdf/csv/txt/…) — a compact click-to-open chip. */
function FileChip({ name, url }: { name: string; url: string }) {
  const ext = name.slice(name.lastIndexOf('.') + 1).toUpperCase();
  return (
    <a className="chat-filechip" href={url} target="_blank" rel="noreferrer noopener" title={name}>
      <span className="chat-filechip-ext" aria-hidden="true">
        {ext.slice(0, 4) || 'FILE'}
      </span>
      <span className="chat-filechip-name">{name}</span>
    </a>
  );
}

/** Render message parts: prose via `renderText`, consecutive image/video parts
 *  grouped into one gallery, other files as chips. */
function renderMessageParts(
  parts: MessagePart[],
  renderText: (text: string, key: string) => React.ReactNode,
  onOpen: (m: { url: string; name: string; video: boolean }) => void,
): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let media: { media: 'image' | 'video'; url: string; name: string }[] = [];
  const flush = () => {
    if (media.length === 0) return;
    out.push(<MediaGallery key={`gal-${out.length}`} items={media} onOpen={onOpen} />);
    media = [];
  };
  for (const [i, part] of parts.entries()) {
    if (part.kind === 'media') {
      media.push({ media: part.media, url: part.url, name: part.name });
    } else {
      flush();
      if (part.kind === 'file') out.push(<FileChip key={`f-${i}`} name={part.name} url={part.url} />);
      else out.push(renderText(part.text, `t-${i}`));
    }
  }
  flush();
  return out;
}

// Icon per notice variant — a task update vs a session reminder.
const NOTICE_ICON: Record<NoticeEvent['variant'], string> = {
  task: '⚙',
  reminder: 'ⓘ',
};

/** Harness control message (background-task update / session reminder). */
function NoticeCard({ event }: { event: NoticeEvent }) {
  return (
    <div className="chat-turn chat-turn-notice">
      <div className={`chat-sysnote chat-sysnote-${event.variant}`} title={event.text}>
        <span className="chat-sysnote-icon" aria-hidden="true">
          {NOTICE_ICON[event.variant]}
        </span>
        <span className="chat-sysnote-text">{event.text}</span>
        {event.detail ? <span className="chat-sysnote-detail">{event.detail}</span> : null}
      </div>
    </div>
  );
}

/** Subagent LAUNCH bubble — the counterpart to the harness "…finished"
 *  notice, so a dispatch reads as one discrete event instead of folding into
 *  a "5 actions · Agent ×5" run. Same pill family as NoticeCard. */
function AgentLaunchCard({ description }: { description: string }) {
  const text = `Agent "${description}" launched`;
  return (
    <div className="chat-turn chat-turn-notice">
      <div className="chat-sysnote chat-sysnote-task chat-sysnote-launch" title={text}>
        <span className="chat-sysnote-icon" aria-hidden="true">
          <SvgAgentGlyph />
        </span>
        <span className="chat-sysnote-text">{text}</span>
        <span className="chat-sysnote-detail">started</span>
      </div>
    </div>
  );
}

// A collapsed tool call + its result, opened together in the ToolModal.
type ToolDetail = { use?: ToolUseEvent | undefined; result?: ToolResultEvent | undefined };

// Human verb per tool name for the collapsed row ("Ran npm build", "Edited x.ts").
const TOOL_VERB: Record<string, string> = {
  Bash: 'Ran',
  Edit: 'Edited',
  Write: 'Wrote',
  MultiEdit: 'Edited',
  NotebookEdit: 'Edited',
  Read: 'Read',
  Grep: 'Searched',
  Glob: 'Searched',
  Task: 'Delegated',
  WebFetch: 'Fetched',
  WebSearch: 'Searched',
};

function commandText(use: ToolUseEvent): string {
  const o =
    use.input && typeof use.input === 'object' ? (use.input as Record<string, unknown>) : {};
  if (typeof o.command === 'string') return o.command;
  try {
    return JSON.stringify(use.input, null, 2);
  } catch {
    return String(use.input);
  }
}

function diffStat(diff?: ToolResultEvent['diff']): { add: number; del: number } | null {
  if (!diff) return null;
  let add = 0;
  let del = 0;
  for (const h of diff.patch)
    for (const l of h.lines) {
      if (l[0] === '+') add++;
      else if (l[0] === '-') del++;
    }
  return { add, del };
}

/** Collapsed one-line tool call — muted, taps open the ToolModal. */
/** Memoized for the same reason as ChatRow — see there. */
const ToolRow = memo(function ToolRow({
  use,
  result,
  onOpen,
}: {
  use?: ToolUseEvent | undefined;
  result?: ToolResultEvent | undefined;
  onOpen: (d: ToolDetail) => void;
}) {
  const verb = use
    ? (TOOL_VERB[use.name] ?? use.name ?? 'Tool')
    : result?.ok === false
      ? 'Failed'
      : 'Result';
  const arg = use ? summarizeToolInput(use.name, use.input) : '';
  const err = result?.ok === false;
  const stat = diffStat(result?.diff);
  return (
    <div className="chat-turn chat-turn-assistant">
      <button
        type="button"
        className={`chat-toolrow${err ? ' error' : ''}`}
        onClick={() => onOpen({ use, result })}
      >
        <span className="chat-toolrow-verb">{verb}</span>
        {arg ? <span className="chat-toolrow-arg">{arg}</span> : null}
        {stat && (stat.add || stat.del) ? (
          <span className="chat-toolrow-stat">
            <span className="add">+{stat.add}</span> <span className="del">-{stat.del}</span>
          </span>
        ) : null}
        <span className="chat-toolrow-chevron" aria-hidden="true">
          ›
        </span>
      </button>
    </div>
  );
});

interface RosterAgent {
  id: string;
  label: string;
  steps: number;
  busy: boolean;
}

/** Small ring spinner for the subagent roster (CSS spins the wrapper). */
function RosterSpinner() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" fill="none" opacity="0.25" />
      <path
        d="M8 2 a6 6 0 0 1 6 6"
        stroke="currentColor"
        strokeWidth="2"
        fill="none"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * Persistent live roster of the subagents running RIGHT NOW — pinned by the
 * composer's session chip, never in the transcript. The scroll is a timeline
 * of what happened; this is ephemeral live state, so it self-removes as
 * agents finish (their launch/finish boxes stay behind in history). The
 * header count is always visible; the list expands to per-agent name, a
 * busy/quiet dot, and cheap detail (steps · last tool).
 */
function SubagentRoster({
  agents,
  open,
  onToggle,
}: {
  agents: RosterAgent[];
  open: boolean;
  onToggle: () => void;
}) {
  if (agents.length === 0) return null;
  return (
    <div className="chat-roster" data-open={open || undefined}>
      <button
        type="button"
        className="chat-roster-head"
        onClick={onToggle}
        aria-expanded={open}
        aria-label={`${agents.length} subagent${agents.length === 1 ? '' : 's'} running`}
      >
        <span className="chat-roster-glyph" aria-hidden="true">
          <SvgAgentGlyph />
        </span>
        <span className="chat-roster-count">
          {agents.length} subagent{agents.length === 1 ? '' : 's'}
        </span>
        {/* Header spinner: keeps "work is happening" visible even collapsed,
            without expanding the list. */}
        <span className="chat-roster-spin -head" aria-hidden="true">
          <RosterSpinner />
        </span>
        <span className="chat-roster-chevron" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
      </button>
      {open ? (
        <ul className="chat-roster-list">
          {agents.map((a) => (
            <li key={a.id} className="chat-roster-item" data-busy={a.busy || undefined}>
              {/* A spinner, not a dot: a row only exists while the subagent is
                  running (it self-removes on finish), so "present = working" —
                  a spinner says that unambiguously and kills the "is it stuck?"
                  doubt. data-busy just brightens it when progress is fresh. */}
              <span className="chat-roster-spin" aria-hidden="true">
                <RosterSpinner />
              </span>
              <span className="chat-roster-name">{a.label}</span>
              {/* Name + a compact step count once it has any (steps only
                  increase, so this stays put — gating on `busy` made it flicker
                  in and out). The dot alone shows busy/quiet. Never the
                  command — it blows the row wide. */}
              {a.steps > 0 ? (
                <span className="chat-roster-meta">
                  {a.steps} step{a.steps === 1 ? '' : 's'}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * An agent question (the runner's ask_user tool) rendered as tappable option
 * chips. A single single-select question answers on tap; multi-select or
 * multi-question forms collect selections and submit once every question has
 * an answer. "Other…" opens a free-text input per question.
 */
function QuestionCard({
  pending,
  onAnswer,
}: {
  pending: PendingQuestion;
  onAnswer: (answers: Array<{ question: string; answers: string[] }>) => void;
}) {
  const qs = pending.questions;
  const [sel, setSel] = useState<Record<number, string[]>>({});
  const [otherOpen, setOtherOpen] = useState<Record<number, boolean>>({});
  const [otherText, setOtherText] = useState<Record<number, string>>({});
  const instant = qs.length === 1 && !qs[0]?.multiSelect;

  const buildAnswers = (s: Record<number, string[]>) =>
    qs.map((q, i) => ({ question: q.question, answers: s[i] ?? [] }));

  const pick = (i: number, label: string) => {
    const q = qs[i];
    if (!q) return;
    let next: Record<number, string[]>;
    if (q.multiSelect) {
      const cur = sel[i] ?? [];
      next = {
        ...sel,
        [i]: cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label],
      };
      setSel(next);
      return;
    }
    next = { ...sel, [i]: [label] };
    setSel(next);
    if (instant) onAnswer(buildAnswers(next));
  };

  const commitOther = (i: number) => {
    const text = (otherText[i] ?? '').trim();
    if (!text) return;
    // Multi-select: the custom answer joins the picked options; single-select
    // it replaces them.
    const cur = qs[i]?.multiSelect ? (sel[i] ?? []) : [];
    const next = { ...sel, [i]: cur.includes(text) ? cur : [...cur, text] };
    setSel(next);
    setOtherOpen((o) => ({ ...o, [i]: false }));
    if (instant) onAnswer(buildAnswers(next));
  };

  // Fold any still-open "Other…" text into the selections — typed-but-not-
  // Entered text must not be silently dropped by the submit button.
  const withPendingOther = () => {
    let s = sel;
    qs.forEach((q, i) => {
      const text = (otherText[i] ?? '').trim();
      if (!otherOpen[i] || !text) return;
      const cur = q.multiSelect ? (s[i] ?? []) : [];
      if (!cur.includes(text)) s = { ...s, [i]: [...cur, text] };
    });
    return s;
  };

  const complete = qs.every(
    (_, i) => (sel[i] ?? []).length > 0 || (otherOpen[i] && !!(otherText[i] ?? '').trim()),
  );

  return (
    <div className="chat-turn chat-turn-assistant">
      <div className="chat-question">
        {qs.map((q, i) => (
          <div className="chat-question-block" key={q.question}>
            <div className="chat-question-head">
              <span className="chat-question-tag">{q.header}</span>
              <span className="chat-question-text">{q.question}</span>
            </div>
            <div className="chat-question-options">
              {q.options.map((o) => {
                const on = (sel[i] ?? []).includes(o.label);
                return (
                  <button
                    key={o.label}
                    type="button"
                    className={`chat-question-option${on ? ' selected' : ''}`}
                    onClick={() => pick(i, o.label)}
                    title={o.description ?? o.label}
                  >
                    <span className="chat-question-option-label">{o.label}</span>
                    {o.description ? (
                      <span className="chat-question-option-desc">{o.description}</span>
                    ) : null}
                  </button>
                );
              })}
              {otherOpen[i] ? (
                <input
                  className="chat-question-other-input"
                  // biome-ignore lint/a11y/noAutofocus: opened by an explicit tap on "Other…"
                  autoFocus
                  placeholder="Type your answer…"
                  value={otherText[i] ?? ''}
                  onChange={(e) => setOtherText((t) => ({ ...t, [i]: e.target.value }))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitOther(i);
                    if (e.key === 'Escape') setOtherOpen((o) => ({ ...o, [i]: false }));
                  }}
                />
              ) : (
                <button
                  type="button"
                  className="chat-question-option chat-question-other"
                  onClick={() => setOtherOpen((o) => ({ ...o, [i]: true }))}
                >
                  <span className="chat-question-option-label">Other…</span>
                </button>
              )}
            </div>
          </div>
        ))}
        {instant ? null : (
          <button
            type="button"
            className="chat-question-submit"
            disabled={!complete}
            onClick={() => onAnswer(buildAnswers(withPendingOther()))}
          >
            Send answers
          </button>
        )}
      </div>
    </div>
  );
}

/** Bottom-sheet detail for a tool call: Command + Output (or a diff). */
function ToolModal({ detail, onClose }: { detail: ToolDetail; onClose: () => void }) {
  const { use, result } = detail;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="chat-modal-backdrop">
      {/* Semantic button scrim: click or keyboard-activate to dismiss. Sits
          behind the sheet so sheet clicks never reach it. */}
      <button type="button" className="chat-modal-scrim" aria-label="Close" onClick={onClose} />
      <div className="chat-modal">
        <div className="chat-modal-head">
          <button type="button" className="chat-modal-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
          <span className="chat-modal-title">{use?.name || 'Output'}</span>
        </div>
        <div className="chat-modal-body">
          {use ? (
            <>
              <div className="chat-modal-label">Command</div>
              <pre className="chat-modal-block">{commandText(use)}</pre>
            </>
          ) : null}
          {result?.diff ? (
            <>
              <div className="chat-modal-label">Changes</div>
              <DiffView diff={result.diff} />
            </>
          ) : result?.text ? (
            <>
              <div className="chat-modal-label">Output</div>
              <pre className="chat-modal-block">{result.text.slice(0, 20000)}</pre>
            </>
          ) : result ? (
            <div className="chat-modal-empty">
              {result.ok ? 'Completed with no output.' : 'Failed with no output.'}
            </div>
          ) : (
            <div className="chat-modal-empty">No output captured yet.</div>
          )}
        </div>
      </div>
    </div>
  );
}

function DiffView({ diff }: { diff: NonNullable<ToolResultEvent['diff']> }) {
  return (
    <div className="chat-diff">
      {diff.filePath ? <div className="chat-diff-file">{diff.filePath}</div> : null}
      {diff.patch.map((hunk, hi) => (
        // hunks are positional and stable within a result render
        // biome-ignore lint/suspicious/noArrayIndexKey: patch hunks have no id
        <div className="chat-diff-hunk" key={hi}>
          {hunk.lines.map((line, li) => {
            const sign = line[0];
            const cls = sign === '+' ? 'add' : sign === '-' ? 'del' : 'ctx';
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: diff lines are positional
              <div className={`chat-diff-line ${cls}`} key={li}>
                {line}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
