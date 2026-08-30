import {
  type AgentMode,
  type AgentQuestion,
  type AgentSessionStatus,
  type ChatEvent,
  IMAGE_MIME_BY_EXT,
  LAUNCH_ACK_RE,
  type NoticeEvent,
  type SubagentProgress,
  type ToolResultEvent,
  type ToolUseEvent,
  imageExtForMime,
  isAgentLaunchTool,
  subagentLabel,
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
import { ApiError, api } from '../api';
import { AGENT_BACKENDS, type AgentBackendId } from '../lib/agent-backend';
import {
  type MessagePart,
  composeOutgoingMessage,
  splitMessageAttachments,
} from '../lib/attachments';
import { showFolderChip } from '../lib/nav-row-affordances';
import { AgentBackendLogo, backendFromAssistant } from './AgentLogos';
import { SvgAgentGlyph, SvgGlobe, SvgTerminalGlyph } from './PaneWebSwitch';

/** Open a media item in the lightbox (image or video). */
type OpenMedia = (m: { url: string; name: string; video: boolean }) => void;
import {
  SHOW_SETTLE_MS,
  SMOOTH_SCROLL_SETTLE_MS,
  maxScrollTop,
  pinnedFromMemory,
  recallChatScroll,
  rememberChatScroll,
  scrollEventIsTrustworthy,
  scrollMemorySidMatches,
  scrollTopAfterOlderPrepend,
  shouldPersistChatScroll,
} from '../lib/chat-scroll';
import { companionTextForImagePaste, splitClipboard } from '../lib/clipboard-detect';
import { useDictationCleanup } from '../lib/dictation-cleanup';
import { liveStatusLabel } from '../lib/live-status';
import { MOBILE_BREAKPOINT, isMobileLayout } from '../lib/mobile-layout';
import { useDismissable } from '../lib/use-dismissable';
import { useMediaQuery } from '../use-media-query';
import { CleanupButton, CleanupHint } from './DictationCleanup';
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
const RTL_CHAR =
  /[\u0590-\u05FF\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB1D-\uFB4F\uFB50-\uFDFF\uFE70-\uFEFF]/; // Hebrew, Arabic (+ presentation forms)
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

type StatusPanel = 'folder' | 'model' | 'live' | null;

interface RosterAgent {
  id: string;
  label: string;
  steps: number;
  busy: boolean;
}

/**
 * "or open instead" — the alternatives to the house chat, shown in the empty
 * state directly under the greeting.
 *
 * This replaced a full-screen "What do you want to open?" chooser. That
 * screen made every new tab a question before it was a place, and the answer
 * was almost always "the chat" — so the chat is now the default and the
 * question became a secondary offer. It first shipped as a tiny text strip
 * above the composer, which was too timid to find; it now sits where the eye
 * already is, with real tappable buttons.
 *
 * Still deliberately quiet — muted until touched, no accent fills — because
 * it IS the secondary path. And it exists only while the chat is empty: the
 * moment you say something, this is not a decision you're making any more.
 *
 * The three harnesses open a RAW session (the harness as it ships, no house
 * contract). Terminal and Web view convert the pane to those plain surfaces.
 * All five are the same server-side respawn, which refuses (cleanly) on any
 * chat that already has messages.
 */
function OpenInsteadStrip({
  busy,
  error,
  onBackend,
  onTerminal,
  onWeb,
}: {
  busy: AgentBackendId | 'terminal' | 'web' | null;
  error: string | null;
  onBackend: (b: AgentBackendId) => void;
  onTerminal: () => void;
  onWeb: () => void;
}) {
  return (
    <div className="chat-open-instead">
      <div className="chat-open-instead-lbl">or open instead</div>
      <div className="chat-open-instead-row">
        {AGENT_BACKENDS.map((b) => (
          <button
            key={b.id}
            type="button"
            className="chat-open-instead-btn"
            disabled={busy !== null}
            aria-busy={busy === b.id}
            title={`Open a raw ${b.label} session in this pane`}
            onClick={() => onBackend(b.id)}
          >
            <AgentBackendLogo backend={b.id} size={18} />
            <span>{b.label}</span>
          </button>
        ))}
        <button
          type="button"
          className="chat-open-instead-btn"
          disabled={busy !== null}
          aria-busy={busy === 'terminal'}
          title="Turn this pane into a plain terminal"
          onClick={onTerminal}
        >
          <SvgTerminalGlyph />
          <span>Terminal</span>
        </button>
        <button
          type="button"
          className="chat-open-instead-btn"
          disabled={busy !== null}
          aria-busy={busy === 'web'}
          title="Turn this pane into a web view"
          onClick={onWeb}
        >
          <SvgGlobe />
          <span>Web view</span>
        </button>
      </div>
      {/* <output> is the semantic live region for "result of the thing you
          just pressed" — it announces without stealing focus. */}
      {error ? <output className="chat-open-instead-error">{error}</output> : null}
    </div>
  );
}

/**
 * Status bar: one segmented strip above the composer —
 * folder | model · ctx | agents (when any). Each segment opens its own
 * upward panel; only one panel at a time. Parent-turn busy state stays in
 * the transcript Working… row; this agents cell is subagents only.
 */
function SessionBar({
  paneId,
  folder,
  status,
  assistant,
  send,
  liveLabel,
  agents,
}: {
  paneId: string;
  folder: { cwd: string; hasProject: boolean } | null;
  status: AgentStatus | null;
  assistant?: string;
  send: (obj: unknown) => void;
  liveLabel: string | null;
  agents: RosterAgent[];
}) {
  const [panel, setPanel] = useState<StatusPanel>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  useDismissable(panel !== null, wrapRef, () => setPanel(null));
  const toggle = (p: Exclude<StatusPanel, null>) => setPanel((cur) => (cur === p ? null : p));
  // If the open segment's data goes away (turn ends, status drop, folder
  // cleared), close the panel — otherwise it auto-reopens next time that
  // segment remounts with stale panel === 'live'|'model'|'folder'.
  useEffect(() => {
    if (panel === 'live' && !liveLabel) setPanel(null);
    else if (panel === 'model' && !status) setPanel(null);
    else if (panel === 'folder' && !folder) setPanel(null);
  }, [panel, liveLabel, status, folder]);

  // ── Folder switcher state ────────────────────────────────────────────
  const [draft, setDraft] = useState(folder?.cwd ?? '');
  const [folderBusy, setFolderBusy] = useState(false);
  const [folderErr, setFolderErr] = useState<string | null>(null);
  useEffect(() => {
    if (panel === 'folder' && folder) {
      setDraft(folder.cwd);
      setFolderErr(null);
    }
  }, [panel, folder]);
  const norm = (s: string) => s.replace(/\/+$/, '');
  const folderBase = folder ? norm(folder.cwd).split('/').pop() || folder.cwd : '';
  const submitFolder = async () => {
    if (!folder || folderBusy) return;
    const next = draft.trim();
    if (!next || norm(next) === norm(folder.cwd)) {
      setPanel(null);
      return;
    }
    setFolderBusy(true);
    setFolderErr(null);
    try {
      await api.setPaneCwd(paneId, next);
      setPanel(null);
    } catch (e) {
      setFolderErr(e instanceof Error ? e.message : 'could not switch folder');
    } finally {
      setFolderBusy(false);
    }
  };

  // ── Model / session menu ─────────────────────────────────────────────
  const supportsSlash = assistant !== 'codex' && assistant !== 'cursor';
  const [confirmClear, setConfirmClear] = useState(false);
  useEffect(() => {
    if (panel !== 'model') setConfirmClear(false);
  }, [panel]);
  const list = status?.models ?? [];
  const modelLc = status?.model.toLowerCase() ?? '';
  const current = status
    ? (list.find((m) => m.value === status.model) ??
      list.find((m) => m.value !== 'default' && m.resolvedModel === status.model) ??
      list.find((m) => m.resolvedModel === status.model) ??
      list.find((m) => m.value.toLowerCase() === modelLc))
    : undefined;
  const modelLabel = current?.displayName ?? status?.model ?? '';
  const ctx = status?.context;
  const kTokens = (n: number) => `${Math.round(n / 1000)}k`;

  // Does the folder deserve a cell in the header at all?
  //
  // ONLY when the pane actually sits in a project (git repo / AGENTS.md /
  // .mcp.json up the tree — the same hasProjectContext the server computes).
  // For a plain conversation the working directory is an implementation
  // detail: showing "~" next to a red "!" told the user their chat was
  // BROKEN, when nothing was wrong — you just weren't coding. So a
  // non-project chat shows no path and no warning at all.
  //
  // The folder is not lost: it moves into the session menu (the model chip),
  // which still lists the full path and opens the same switcher.
  const folderChipVisible = showFolderChip(folder);
  const folderPanel =
    folder && panel === 'folder' ? (
      <div className="chat-status-menu chat-folder-menu" role="dialog">
        <div className="chat-folder-path">{folder.cwd}</div>
        {!folder.hasProject ? (
          <div className="chat-folder-nocontext">
            No project context here — no git repo, AGENTS.md, or .mcp.json up the tree. Fine for a
            plain conversation; switch to a project folder to give the agent its rules and MCP.
          </div>
        ) : null}
        <label className="chat-folder-lbl" htmlFor={`fld-${paneId}`}>
          Switch folder — starts a fresh agent here
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
              void submitFolder();
            } else if (e.key === 'Escape') {
              setPanel(null);
            }
          }}
        />
        {folderErr ? <div className="chat-folder-error">{folderErr}</div> : null}
        <button
          type="button"
          className="chat-folder-go"
          disabled={folderBusy}
          onClick={() => void submitFolder()}
        >
          {folderBusy ? 'Switching…' : 'Switch & start fresh'}
        </button>
      </div>
    ) : null;

  return (
    <div className="chat-status-bar" ref={wrapRef}>
      {folderChipVisible && folder ? (
        <div className="chat-status-seg-wrap">
          <button
            type="button"
            className={`chat-status-seg${panel === 'folder' ? ' is-open' : ''}`}
            onClick={() => toggle('folder')}
            aria-expanded={panel === 'folder'}
            title={folder.cwd}
          >
            <SvgFolder />
            <span className="chat-status-seg-label">{folderBase}</span>
          </button>
          {folderPanel}
        </div>
      ) : null}

      {status || assistant ? (
        <div className="chat-status-seg-wrap">
          <button
            type="button"
            className={`chat-status-seg${panel === 'model' ? ' is-open' : ''}`}
            onClick={() => (status ? toggle('model') : undefined)}
            aria-haspopup={status ? 'menu' : undefined}
            aria-expanded={status ? panel === 'model' : undefined}
            title={
              status
                ? `${assistantLabel(assistant)}${status.activeModel || status.model ? ` · ${status.activeModel ?? status.model}` : ''} — model, context, compact, clear`
                : assistantLabel(assistant)
            }
          >
            <AgentBackendLogo backend={backendFromAssistant(assistant)} size={12} />
            <span className="chat-status-seg-label">
              {status ? `${modelLabel}${ctx ? ` · ${ctx.pct}%` : ''}` : assistantLabel(assistant)}
            </span>
          </button>
          {/* When the folder chip is hidden (a plain, non-project chat) the
              switcher still has to be reachable — it opens from the session
              menu's "Working folder" row instead, anchored here. */}
          {!folderChipVisible ? folderPanel : null}
          {panel === 'model' && status ? (
            <div className="chat-status-menu chat-session-menu" role="menu">
              {/* Working folder — only listed when it isn't already its own
                  cell in the bar, so the two never both show the path. */}
              {folder && !folderChipVisible ? (
                <>
                  <div className="chat-session-head">Folder</div>
                  <button
                    type="button"
                    role="menuitem"
                    className="chat-session-item"
                    onClick={() => setPanel('folder')}
                  >
                    <span className="chat-session-item-label">Working folder…</span>
                    <span className="chat-session-item-desc chat-model-id">{folder.cwd}</span>
                  </button>
                </>
              ) : null}
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
              {status.models?.map((m) => {
                // Show the CONCRETE id an alias resolves to (e.g. Opus →
                // claude-opus-4-8) so "which model exactly" is unambiguous. For
                // the active row prefer the live model the last turn actually ran
                // (status.model) over the alias's advertised resolution.
                const concrete =
                  m === current ? (status.activeModel ?? m.resolvedModel) : m.resolvedModel;
                const showConcrete = concrete && concrete !== m.value && concrete !== m.displayName;
                return (
                  <button
                    key={m.value}
                    type="button"
                    role="menuitem"
                    className={`chat-session-item${m === current ? ' is-active' : ''}`}
                    onClick={() => {
                      if (m !== current) send({ t: 'set-model', model: m.value });
                      setPanel(null);
                    }}
                  >
                    <span className="chat-session-item-label">{m.displayName}</span>
                    {showConcrete ? (
                      <span className="chat-session-item-desc chat-model-id">{concrete}</span>
                    ) : null}
                  </button>
                );
              })}
              {supportsSlash ? (
                <>
                  <div className="chat-session-head">Session</div>
                  <button
                    type="button"
                    role="menuitem"
                    className="chat-session-item"
                    onClick={() => {
                      send({ t: 'slash', cmd: 'compact' });
                      setPanel(null);
                    }}
                  >
                    <span className="chat-session-item-label">Compact conversation</span>
                    <span className="chat-session-item-desc">
                      Summarize history to free context
                    </span>
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
                      setPanel(null);
                    }}
                  >
                    <span className="chat-session-item-label">
                      {confirmClear ? 'Tap again to clear everything' : 'Clear conversation'}
                    </span>
                    {!confirmClear ? (
                      <span className="chat-session-item-desc">
                        Wipes the conversation — starts fresh
                      </span>
                    ) : null}
                  </button>
                </>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {liveLabel ? (
        <div className="chat-status-seg-wrap">
          <button
            type="button"
            className={`chat-status-seg -live${panel === 'live' ? ' is-open' : ''}`}
            onClick={() => toggle('live')}
            aria-expanded={panel === 'live'}
            aria-label={liveLabel}
            title={liveLabel}
          >
            <span className="chat-roster-spin -head" aria-hidden="true">
              <RosterSpinner />
            </span>
            <span className="chat-status-seg-label">{liveLabel}</span>
          </button>
          {panel === 'live' && agents.length > 0 ? (
            <div className="chat-status-menu chat-live-menu" role="dialog">
              <div className="chat-session-head">Subagent{agents.length === 1 ? '' : 's'}</div>
              <ul className="chat-roster-list">
                {agents.map((a) => (
                  <li key={a.id} className="chat-roster-item" data-busy={a.busy || undefined}>
                    <span className="chat-roster-spin" aria-hidden="true">
                      <RosterSpinner />
                    </span>
                    <span className="chat-roster-name">{a.label}</span>
                    {a.steps > 0 ? (
                      <span className="chat-roster-meta">
                        {a.steps} step{a.steps === 1 ? '' : 's'}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
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

/** One entry of the server-owned pending send queue. `text` is the full
 *  message (prose + any attachment paths appended), same as a delivered send. */
interface QueuedItem {
  id: string;
  text: string;
}

type ServerMsg =
  | {
      t: 'session';
      session: (SessionMeta & Record<string, unknown>) | null;
      /** The PANE's agent mode — pane-level, not session-level, so it
       *  survives a session being re-minted. Internal plumbing. */
      mode?: AgentMode;
      /** Server's authoritative "has anything been said here?". The empty
       *  state must NOT infer this from `events.length`: history replays
       *  asynchronously, so a real conversation reads as empty for a beat on
       *  every reconnect. */
      hasMessages?: boolean;
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
      /** Server-owned pending send queue (messages waiting for a busy agent). */
      queue?: QueuedItem[];
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
  // Server-owned queue: the full pending list broadcast on every change, plus a
  // per-socket ack that THIS send was parked (so it drops its optimistic state).
  | { t: 'queue'; items: QueuedItem[] }
  | { t: 'queued'; id: string; text: string }
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
 *  into an action run and never rendered as a plain tool row.
 *
 *  The name test and the description extraction come from @muxpad/shared,
 *  which is also what the RUNNER uses to build the durable roster. That is the
 *  point: the two roster sources are merged into one list, so if they disagreed
 *  about what a launch is — or truncated its label differently — the same
 *  subagent could appear twice, under two names. */
function isAgentLaunch(e: ChatEvent): boolean {
  return e.kind === 'tool_use' && isAgentLaunchTool(e.name);
}
function agentLaunchDescription(e: ToolUseEvent): string {
  return subagentLabel(e.input) || 'subagent';
}

/** How long a rostered subagent may go without a progress frame before its
 *  per-row dot reads "quiet" rather than "busy". Presentation only — it can no
 *  longer evict anyone. Membership is the SERVER's durable roster (see
 *  SubagentProgress), which has real launch/finish edges; the old 30s eviction
 *  gate here was measurably wrong (P1, 2026-08: a live background subagent goes
 *  44s+ without a frame inside one long tool call) and, because it was disabled
 *  whenever `agentWorking` was true — which `setSending(true)` makes so
 *  synchronously on keypress — every evicted agent popped back the instant you
 *  hit send. */
const SUBAGENT_QUIET_MS = 15_000;

/** How long a conversion request may hang before the strip re-enables itself.
 *  Generous — the route kills a pty and spawns a runner before it answers —
 *  and deliberately NOT an error claim: it only gives the user their button
 *  back when neither fetch nor the ptyd RPC layer has a timeout of its own. */
const CONVERT_STALL_MS = 60_000;

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
  // Programmatic scrollTop writes stamp this BEFORE assigning so onScroll
  // can tell reader-driven motion from restore / pin / older-prepend adjusts.
  const lastProgrammaticTop = useRef(-1);
  // Settling restore stops the moment the reader scrolls; reset on hide.
  const userScrolled = useRef(false);
  // Monotonic deadline (performance.now) until which scroll events are OUR
  // doing — a show transition relaying out, or a smooth jump-to-bottom — and
  // so must not touch pin state or scroll memory. 0 = nothing in flight. A
  // real gesture clears it (see the wheel/touch listener): distrusting events
  // for a moment is right; distrusting the reader never is.
  const suppressPinUntil = useRef(0);
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
  // ── Dictation cleanup (mobile only) ──────────────────────────────────────
  // Phone dictation can't learn muxpad's vocabulary, so a dictated message
  // arrives as "check the crown schedule on Max pad". The button repairs it
  // IN THE COMPOSER — this pane's messages drive an agent that runs tool
  // calls, so the human reads the corrected text before it goes anywhere.
  //
  // Gated on the live viewport rather than `isMobileLayout()`: this composer
  // renders on desktop too, and the desktop composer deliberately does not get
  // the affordance (desktop input is typed, not dictated). A media-query hook
  // rather than a one-shot read so rotating or resizing doesn't strand it.
  const isMobile = useMediaQuery(MOBILE_BREAKPOINT);
  const cleanup = useDictationCleanup({
    read: () => inputRef.current?.value ?? '',
    write: (text) => setInput(text),
  });
  const { reset: resetCleanup } = cleanup;
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
  /**
   * Scroll geometry captured just before an older-history prepend, so the
   * layout effect below can restore the reader's position after the content
   * grows above the viewport.
   *
   * `forEvents` KEYS IT TO ONE EVENTS COMMIT. The apply used to sit inside a
   * `clientHeight >= 40` guard, and so did the null-reset — so a batch that
   * prepended while the pane was hidden left a live anchor behind, and the next
   * unrelated commit (a plain incoming message) applied that stale geometry and
   * teleported the reader. An anchor is only ever valid for the exact commit it
   * was measured against; anything else drops it and lets the ratio-restore
   * loop do its job.
   */
  const olderAnchor = useRef<{ height: number; top: number; forEvents: ChatEvent[] } | null>(null);
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
  // Bumped whenever the document becomes visible again. `active` only tracks
  // muxpad's own hiding (tab/pane/face switches); a browser-tab switch, an
  // iOS app backgrounding or a bfcache restore hide the pane just as
  // thoroughly and must re-anchor the same way.
  const [showEpoch, setShowEpoch] = useState(0);
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
  // Authoritative emptiness, from the server (see the session frame). Starts
  // TRUE — "assume there is history until told otherwise" — so a slow first
  // frame can never flash the alternatives over someone's conversation.
  const [hasMessages, setHasMessages] = useState(true);
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
        // Absent (older server) → assume history: never flash the offer.
        setHasMessages(msg.hasMessages !== false);
        // Server-owned pending queue: authoritative on every (re)connect.
        setQueue(msg.queue ?? []);
        // The session frame is a FULL SNAPSHOT of the server's durable roster,
        // and an EMPTY roster is a meaningful value — the server omits the key
        // when nothing is running. Guarding on presence (`if (msg.subagents)`)
        // meant an emptied roster never overwrote a stale map, so the last
        // subagent of a session could never be cleared by a resync. Assign
        // unconditionally, and rebuild the seen-at map alongside it so it can't
        // leak entries for tasks the snapshot no longer carries.
        {
          const now = Date.now();
          const live = msg.subagents ?? [];
          subagentSeenAt.current = new Map(live.map((p) => [p.toolUseId, p.seenAt ?? now]));
          setSubagents(Object.fromEntries(live.map((p) => [p.toolUseId, p])));
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
            const measured = el ? { height: el.scrollHeight, top: el.scrollTop } : null;
            ordered.current = [...fresh, ...ordered.current];
            // Keyed to THIS array identity — the very commit setEvents is about
            // to publish. See olderAnchor's note.
            olderAnchor.current = measured ? { ...measured, forEvents: ordered.current } : null;
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
        // BACKGROUND subagents outlive the turn — keep their progress; the
        // server keeps them rostered too, and each entry leaves on its own
        // finish notice. A failed/STOPPED turn is the exception: it kills
        // background tasks with it (live-verified), and no finish notice will
        // ever arrive for them, so clear the live detail here.
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
      } else if (msg.t === 'queue') {
        // The server-owned pending queue changed (a send parked, drained, or was
        // cancelled — possibly from another device). Render it verbatim.
        setQueue(msg.items);
        // A queued send is a message: the server counts it in
        // agentPaneHasMessages, so a chat with a pending bubble WILL 409 any
        // conversion. Only the session frame used to set this, so a send that
        // arrived from another device left the strip on offer here — inviting
        // a click that could only fail.
        if (msg.items.length > 0) setHasMessages(true);
      } else if (msg.t === 'queued') {
        // Our just-sent message was parked (agent busy / reconnecting). It's now
        // a pending bubble via the `queue` broadcast, so drop only the optimistic
        // echo we showed for the idle-send race — NOT `sending`: the server
        // queued it because a turn is running (or about to, from the drain), so
        // the working state stays honest. The normal busy path set no optimism,
        // so the guard skips it there.
        // Was this the send we optimistically echoed (idle-send race)? Capture
        // before clearing the recovery slot below.
        const wasOurOptimistic = pendingText.current === msg.text;
        acked.current = true;
        window.clearTimeout(sendWatchdog.current);
        // The server has this message persisted now, so it must NOT be restored
        // into the composer on a later socket close — clear the recovery slot
        // unconditionally (safe: acked is already true, so onclose won't restore
        // anyway). Only drop the OPTIMISTIC bubble when it's ours, so we never
        // wipe a still-running turn's echo — NOT `sending` either (the server
        // queued this because a turn is running/about to drain).
        pendingText.current = '';
        if (wasOurOptimistic) setOptimisticUser(null);
      } else if (msg.t === 'subagent') {
        const { toolUseId, done } = msg.progress;
        if (done) {
          // A TERMINAL frame. The server has already dropped it from its own
          // roster; inserting it here (which is what happened before this
          // branch existed) left a permanent phantom row per foreground Task —
          // those complete via a tool_result, so the transcript's
          // finish-notice path never covers them either.
          subagentSeenAt.current.delete(toolUseId);
          setSubagents((m) => {
            if (!(toolUseId in m)) return m;
            const next = { ...m };
            delete next[toolUseId];
            return next;
          });
        } else {
          subagentSeenAt.current.set(toolUseId, msg.progress.seenAt ?? Date.now());
          setSubagents((m) => ({ ...m, [toolUseId]: msg.progress }));
        }
      } else if (msg.t === 'status') {
        setAgentStatus((prev) => {
          const next: AgentStatus = {
            model: msg.model,
            ...(msg.activeModel ? { activeModel: msg.activeModel } : {}),
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

  // The pending send queue is owned by the SERVER now, not this component: the
  // server persists it, drains it one message per turn (even with no browser
  // open), and broadcasts the full list on every change. We just render what it
  // sends — so the queue survives a reload, follows the user across devices, and
  // can never be dropped in transit. Populated from `session`/`queue` frames.
  const [queue, setQueue] = useState<QueuedItem[]>([]);

  // Fire a composed message onto the live socket with optimistic echo. The
  // server decides whether it runs now or is queued; a `queued` frame comes
  // back for the latter and clears this optimism (the pending bubble takes
  // over). Returns false (leaving the draft intact) if the socket isn't open.
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

  // Cancel a still-pending message before it runs. Only acts on a live socket:
  // the server owns the queue, so optimistically hiding a bubble whose cancel
  // never reached the server would show it as gone while it still runs. Returns
  // whether the cancel was actually sent. The server's `queue` broadcast is the
  // authoritative confirmation (and re-adds the bubble if we were wrong).
  const cancelQueued = (id: string): boolean => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      setNotice({ text: 'Reconnecting — try again in a moment.', tone: 'info' });
      reconnectNow.current();
      return false;
    }
    ws.send(JSON.stringify({ t: 'queue-cancel', id }));
    setQueue((q) => q.filter((x) => x.id !== id));
    return true;
  };

  // Edit a queued message: cancel it and pull its text + attachments back into
  // the composer. Attachment thumbnails are re-derived from their served URLs
  // (the bytes live on the server), so this works even on a fresh reload where
  // no local blob preview exists. Only repopulate the composer if the cancel
  // actually went out — otherwise the item still runs server-side AND sits in
  // the composer, inviting a duplicate send.
  const editQueued = (item: QueuedItem) => {
    if (!cancelQueued(item.id)) return;
    const parts = splitMessageAttachments(item.text);
    const prose = parts
      .filter((p): p is Extract<MessagePart, { kind: 'text' }> => p.kind === 'text')
      .map((p) => p.text)
      .join('')
      .trim();
    const atts = parts
      .filter((p): p is Exclude<MessagePart, { kind: 'text' }> => p.kind !== 'text')
      .map((p) => ({ path: p.path, name: p.name, previewUrl: p.url }));
    setInput((cur) => (cur.trim() ? `${prose}\n${cur}` : prose));
    if (atts.length) setChips((prev) => [...prev, ...atts]);
    inputRef.current?.focus();
  };

  const sendMessage = () => {
    const text = input.trim();
    // Whatever happens below, the composed text is leaving (or being answered
    // with) — a lingering "undo cleanup" would offer to restore it afterwards.
    resetCleanup();
    // Attachment paths ride along at the END of the message — the agent reads
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
    const outgoing = composeOutgoingMessage(text, attachmentPaths);
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      // Don't fire into a dead socket (the browser would drop it silently).
      // Keep the text (and chips) in the composer, kick a reconnect, retry.
      setNotice({ text: 'Reconnecting — try again in a moment.', tone: 'info' });
      reconnectNow.current();
      return;
    }
    if (sending) {
      // Agent busy → hand it to the server to queue. No optimistic turn state;
      // the server's `queue` broadcast renders the pending bubble. The message
      // is persisted server-side, so it's safe even if we close the tab now.
      // Track it as the pending send so BOTH the watchdog and a hard `onclose`
      // can restore it if no ack comes back — without this, a socket that closes
      // before `send-ack` drops the message silently (onclose reads pendingText).
      // send-ack (fired for queued sends too) clears both on a live socket.
      pendingText.current = outgoing;
      ws.send(JSON.stringify({ t: 'send', text: outgoing }));
      armSendWatchdog(outgoing);
    } else {
      // Idle → optimistic send (instant echo + working state). If the server
      // turns out to be busy (reconnect race), its `queued` frame reconciles.
      dispatchSend(outgoing);
    }
    setInput('');
    clearChips();
  };
  const stop = () => wsRef.current?.send(JSON.stringify({ t: 'stop' }));

  const answerQuestion = (qid: string, answers: Array<{ question: string; answers: string[] }>) => {
    wsRef.current?.send(JSON.stringify({ t: 'answer', qid, answers }));
    // Optimistic dismiss; the server's question-done broadcast confirms it
    // (and clears it on every other device's view too).
    setQuestion((q) => (q?.qid === qid ? null : q));
  };

  // Photo picker → upload via the same attachments endpoint the TUI composer
  // uses; each upload becomes a composer chip whose path is appended at send
  // (exactly like paste — the path is NEVER spliced into the draft, or it would
  // ride out twice and render the image twice). accept="image/*" with no
  // `capture` → the OS sheet offers library + camera. Empty-type files
  // (HEIC / some Android providers) are kept.
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
    for (const f of files) {
      try {
        const { path } = await api.uploadAttachment(paneId, f, f.name || 'image.png');
        addChip(path, f);
      } catch {
        // drop this one; the rest still upload
      }
    }
    setUploading(false);
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
  // Set lastProgrammaticTop BEFORE scrollTop so the synchronous onScroll
  // doesn't treat this as the reader taking control.
  // biome-ignore lint/correctness/useExhaustiveDependencies: events/streamingText/optimisticUser/question/subagent-count/queued-count are the scroll triggers
  useEffect(() => {
    const el = scrollRef.current;
    // clientHeight < 40 means no real box (mid-relayout, or a pane hidden by
    // an ancestor we haven't been told about): measuring it yields target 0,
    // which stamps a bogus lastProgrammaticTop and parks the reader at the
    // top. Same threshold the persistence and re-pin guards use.
    if (el && active && el.clientHeight >= 40 && pinnedToBottom.current) {
      const target = maxScrollTop(el.scrollHeight, el.clientHeight);
      lastProgrammaticTop.current = target;
      el.scrollTop = target;
    }
  }, [
    events,
    streamingText,
    optimisticUser,
    question,
    Object.keys(subagents).length,
    queue.length,
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
    // A display:none ancestor collapses offsetHeight to 0. Publishing that
    // shrinks .chat-list's bottom padding by the composer's whole height
    // (~86px) while hidden, and it regrows a frame AFTER the pane is shown —
    // landing the reader about one message off even when the re-anchor
    // works. So: measure only a element that actually has a box. Same shape
    // as the MobileInputBar fix, for the same reason.
    const measure = () => {
      const h = el.offsetHeight;
      if (h > 0) setComposerH(h);
    };
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
  //
  // Sid matching is soft: memory may be saved before the hello binds
  // renderedSid (or remount starts with sid=null). Requiring equality then
  // skipped every restore for the whole window and left unpinned readers at
  // scrollTop 0 — "scroll is totally not remembered". Only skip on a REAL
  // mismatch (both set, different) for /clear / resume rotation.
  //
  // `showEpoch` re-runs it for the visibility transitions that never touch
  // `active`: a browser-tab switch, an iOS app backgrounding, a bfcache
  // restore. Those hide the pane just as thoroughly as display:none does.
  // biome-ignore lint/correctness/useExhaustiveDependencies: showEpoch is a re-run trigger — becoming visible again must re-anchor.
  useLayoutEffect(() => {
    if (!active) {
      userScrolled.current = false; // hidden panes lose scrollTop — re-restore on return
      suppressPinUntil.current = 0;
      return;
    }
    userScrolled.current = false;
    // Becoming visible starts the settling window (C) and invalidates the
    // last programmatic target: while hidden, the follow-bottom effect ran
    // against a zero-height element and stamped 0. Leaving that in place
    // makes the first real scroll event look like a 0→N reader jump.
    suppressPinUntil.current = performance.now() + SHOW_SETTLE_MS;
    lastProgrammaticTop.current = -1;
    const sidOk = (mem: NonNullable<ReturnType<typeof recallChatScroll>>) =>
      scrollMemorySidMatches(mem.sid, renderedSid.current);
    // Memory whose sid REALLY disagrees with what's rendered (/clear, a resume
    // rotation) describes a conversation that no longer exists: treat it as no
    // memory at all, i.e. follow the bottom. Reading `pinned` off it while
    // refusing to apply its ratio was the worst of both — an unpinned pane
    // that anchored to nothing and then didn't follow new messages either.
    const usable = (mem: ReturnType<typeof recallChatScroll>) => (mem && sidOk(mem) ? mem : null);
    pinnedToBottom.current = pinnedFromMemory(usable(recallChatScroll(paneId)));
    let raf = 0;
    const deadline = performance.now() + 2500;
    const apply = () => {
      raf = 0;
      const el = scrollRef.current;
      // clientHeight < 40: no real box yet (the un-hide hasn't laid out, or
      // the pane is collapsed). Every measurement taken from it is wrong;
      // skip this frame and try the next one.
      if (el && !userScrolled.current && el.clientHeight >= 40) {
        const mem = usable(recallChatScroll(paneId));
        if (el.scrollHeight > el.clientHeight) {
          if (!mem || mem.pinned) {
            // Pinned / no memory → hold the bottom while content streams in
            // (follow-bottom effect also does this; settle covers the gap
            // before the first events commit).
            pinnedToBottom.current = true;
            const target = maxScrollTop(el.scrollHeight, el.clientHeight);
            if (Math.abs(el.scrollTop - target) > 1) {
              lastProgrammaticTop.current = target;
              el.scrollTop = target;
            }
          } else {
            pinnedToBottom.current = false;
            // Clamped: iOS rubber-band can persist a slightly negative ratio,
            // and an out-of-range target never equals the scrollTop the
            // browser clamps it to — so the loop would re-assign (and force a
            // reflow) every frame for the full window.
            const range = maxScrollTop(el.scrollHeight, el.clientHeight);
            const target = Math.min(Math.max(0, Math.round(mem.ratio * range)), range);
            if (Math.abs(el.scrollTop - target) > 1) {
              lastProgrammaticTop.current = target;
              el.scrollTop = target;
            }
          }
        }
      }
      if (performance.now() < deadline && !userScrolled.current) raf = requestAnimationFrame(apply);
    };
    apply(); // first pass runs before paint — no flash
    return () => {
      if (raf) cancelAnimationFrame(raf);
    };
  }, [active, paneId, showEpoch]);

  // After an older-history batch prepends, content grew above the viewport.
  // Pinned readers stay at the bottom (fill-viewport paging must not yank
  // them into older history). Unpinned readers keep the messages they were
  // looking at. Always stamp lastProgrammaticTop first so onScroll doesn't
  // treat the adjust as a user scroll and corrupt pin/memory.
  // `events` is both the trigger AND a real read (the anchor is keyed to one
  // commit) — no suppression needed here any more.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const a = olderAnchor.current;
    // An anchor belongs to ONE commit. If `events` has moved on since it was
    // measured (the prepend landed while hidden, and this render is some later,
    // unrelated message), the geometry describes a document that no longer
    // exists — applying it would yank the reader to a position computed from a
    // stale height. Drop it; the ratio-restore loop covers the hidden case.
    if (a && a.forEvents !== events) {
      olderAnchor.current = null;
      return;
    }
    // A prepend that lands while the pane is HIDDEN has no geometry to
    // anchor against: every measurement is 0, so the adjust would stamp
    // lastProgrammaticTop = 0 and throw the anchor away. Leave both alone —
    // the restore loop re-applies the remembered ratio on return, and a ratio
    // degrades proportionally when the document grows (which is exactly why
    // the memory is a ratio and not an offset).
    if (el && a && el.clientHeight >= 40) {
      const target = scrollTopAfterOlderPrepend({
        pinned: pinnedToBottom.current,
        newScrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
        anchorHeight: a.height,
        anchorTop: a.top,
      });
      lastProgrammaticTop.current = target;
      el.scrollTop = target;
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

  // Coming back from a browser-tab switch / app background / bfcache restore
  // is a show transition too — the pane's `active` never moved, but its
  // layout (and, on some engines, its scrollTop) may have. Bumping this
  // re-runs the restore + settling loop above.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') setShowEpoch((n) => n + 1);
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('pageshow', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('pageshow', onVisible);
    };
  }, []);

  // ── The reader always wins ────────────────────────────────────────────────
  // The suppression window exists to ignore layout-driven scroll EVENTS, but
  // a wheel spin or a finger drag is not layout: it is the reader taking
  // control, and it must land even one frame after a show. Without this, a
  // flick inside the window was silently undone by the settling loop (which
  // only stops on `userScrolled`) and, worse, the re-pin observer could still
  // see a stale `pinnedToBottom` and throw them back to the bottom.
  // biome-ignore lint/correctness/useExhaustiveDependencies: pendingPick gates when the scroll container exists (the picker renders a different tree).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !active) return;
    const taken = () => {
      suppressPinUntil.current = 0; // the next scroll event is theirs, and counts
      userScrolled.current = true; // stop the settling restore
    };
    el.addEventListener('wheel', taken, { passive: true });
    el.addEventListener('touchmove', taken, { passive: true });
    return () => {
      el.removeEventListener('wheel', taken);
      el.removeEventListener('touchmove', taken);
    };
  }, [active, pendingPick]);

  // ── D. Hold the bottom through ANY height change, not just React commits ──
  // The follow-bottom effect only fires on state the component knows about
  // (events, streaming text, …). Plenty of height arrives outside that:
  // image and gallery thumbnails decoding late (they're lazy and have no
  // intrinsic size), the composer regrowing after a show, fonts settling,
  // the viewport changing. Each grows content BELOW the reader's anchor with
  // no re-pin, which is the "comes back a little bit off" half of the bug —
  // and the settling loop can't cover it because that loop has a 2500ms fuse.
  //
  // A ResizeObserver has no fuse. While the pane is VISIBLE and the reader is
  // PINNED, any height change re-asserts the bottom. It deliberately does
  // nothing for an unpinned reader: someone parked in history must never be
  // yanked down by a thumbnail loading.
  // `pendingPick` is a dependency because the harness picker renders a
  // DIFFERENT tree with no .chat-scroll in it: an active pane that starts on
  // the picker has a null ref here, and without re-running when the real
  // chat mounts, the observer would never attach for that pane's whole life.
  // biome-ignore lint/correctness/useExhaustiveDependencies: pendingPick gates when the scroll container exists.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !active) return;
    let last = '';
    const reassert = () => {
      // A zero/absurdly-short box is a hidden or mid-relayout pane; measuring
      // it produces a target of 0 and would park the reader at the top.
      if (el.clientHeight < 40) return;
      // Both dimensions matter: content growing (scrollHeight) and the
      // viewport shrinking (clientHeight — composer regrowth, window resize)
      // each move the bottom. Keying on scrollHeight alone made a pinned
      // reader miss every pure-viewport change.
      const key = `${el.scrollHeight}x${el.clientHeight}`;
      if (key === last) return;
      last = key;
      // `pinnedToBottom` is the ONE authority on whether we may move the
      // reader; deliberately NOT also gated on `userScrolled`. That flag stays
      // true for the rest of the visit once the reader touches the wheel, so
      // gating on it meant a reader who scrolled up and then came back to the
      // bottom silently lost late-content re-pinning — while the events
      // effect (which checks only the pin) kept following. One rule, one flag.
      if (!pinnedToBottom.current) return;
      const target = maxScrollTop(el.scrollHeight, el.clientHeight);
      if (Math.abs(el.scrollTop - target) <= 1) return;
      lastProgrammaticTop.current = target;
      el.scrollTop = target;
    };
    const ro = new ResizeObserver(reassert);
    ro.observe(el);
    // The scroll container's own box often doesn't change when its CONTENT
    // grows, so watch the list too — that's the element images live in.
    //
    // BORDER-BOX, not the default content-box: the floating composer is
    // absolutely positioned, so its height reaches the log only as the list's
    // bottom PADDING. A content-box observer never sees that change, which
    // means the composer regrowing after a show — one of the exact cases this
    // observer exists for — would leave the last message hidden behind it.
    const list = el.querySelector('.chat-list');
    if (list) ro.observe(list, { box: 'border-box' });
    return () => ro.disconnect();
  }, [active, pendingPick]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    // display:none (face/tab hide) zeroes clientHeight/scrollTop — persisting
    // that writes ratio 0 / unpinned and the next open lands in older history.
    if (!shouldPersistChatScroll({ active, clientHeight: el.clientHeight })) return;
    // Movement WE started — a just-un-hidden pane relaying out (clientHeight
    // is back but scrollTop and the composer height are not), or a smooth
    // jump-to-bottom mid-glide. Acting on those is what used to unpin a
    // visible chat and persist it, which is what made the bug stick. Still
    // update the scroll-down arrow (it derives from current geometry and is
    // self-correcting); just don't touch pin or memory. A real gesture has
    // already cleared the window by the time its scroll event arrives.
    const trustworthy = scrollEventIsTrustworthy({
      suppressedUntil: suppressPinUntil.current,
      now: performance.now(),
    });
    if (trustworthy) {
      // The settling restore above fires this too; a scroll AWAY from its last
      // programmatic target is the reader taking control — stop re-restoring.
      // Programmatic paths stamp lastProgrammaticTop BEFORE assigning scrollTop
      // so this check sees them as non-user.
      if (Math.abs(el.scrollTop - lastProgrammaticTop.current) > 1) userScrolled.current = true;
      const range = Math.max(1, el.scrollHeight - el.clientHeight);
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      pinnedToBottom.current = nearBottom;
      rememberChatScroll(paneId, {
        // Clamped: overscroll (iOS rubber-band) reports a scrollTop outside
        // the range, and a stored ratio outside [0,1] restores to a position
        // the browser then clamps — leaving the restore loop re-assigning a
        // target it can never reach.
        ratio: Math.min(Math.max(0, el.scrollTop / range), 1),
        pinned: nearBottom,
        sid: renderedSid.current,
      });
    }
    // Hysteresis: only reveal the arrow once meaningfully scrolled up, so it
    // doesn't flicker on tiny nudges near the bottom.
    setShowScrollDown(el.scrollHeight - el.scrollTop - el.clientHeight > 120);
    // Near the top → page in earlier messages (once events exist, so we don't
    // fire during the initial empty/loading state). Untrusted events are
    // excluded: a just-shown pane can report scrollTop 0 while its layout
    // settles, and paging on that would prepend a batch of history on every
    // single tab visit to a chat the reader is pinned to the bottom of. The
    // genuine "not enough content to scroll" case has its own effect.
    if (trustworthy && el.scrollTop < 240 && events.length > 0) requestOlder();
  };

  const scrollToBottom = () => {
    const el = scrollRef.current;
    if (!el) return;
    pinnedToBottom.current = true;
    setShowScrollDown(false);
    // Record the re-pin immediately — the smooth scroll's own onScroll
    // events lag, and switching away mid-glide must not save a stale spot.
    rememberChatScroll(paneId, { ratio: 1, pinned: true, sid: renderedSid.current });
    // …and suppress the glide itself. A smooth scroll emits an event per
    // frame, none of them the reader: each one used to read as "scrolled away
    // from the programmatic target", unpinning the chat this button just
    // pinned and persisting a mid-glide ratio if the pane was hidden before
    // the animation finished. Grabbing the wheel mid-glide still wins — the
    // gesture listener clears this.
    suppressPinUntil.current = performance.now() + SMOOTH_SCROLL_SETTLE_MS;
    const target = maxScrollTop(el.scrollHeight, el.clientHeight);
    lastProgrammaticTop.current = target;
    el.scrollTo({ top: target, behavior: 'smooth' });
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

  // ── Converting this pane into something else ─────────────────────────
  // Shared by the legacy full-screen harness picker (below) and the empty
  // state's "or open instead" offer, so both drive the identical routes.
  // Declared above `body` because that memo renders the offer.
  const [pickBusy, setPickBusy] = useState<AgentBackendId | 'terminal' | 'web' | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);
  /**
   * One helper for all three conversions, because they all got the same two
   * things wrong.
   *
   * 1. THE WATCHDOG FIRED ON SUCCESS. Each of these used to arm a 12s timer
   *    after a SUCCESSFUL call that set an error ("still starting — tap … to
   *    retry") and re-enabled the strip. That was written for the old
   *    full-screen picker, which unmounted the moment `pendingPick` cleared —
   *    the timer was then a no-op. The empty-chat "open instead:" strip does
   *    NOT unmount (same ChatPane, same mount), so every successful conversion
   *    showed a false error 12 seconds later. Worse, after as-terminal /
   *    as-web the ChatPane is merely HIDDEN, so the timer fired into a pane
   *    the user had already left. The route now returns only once the new
   *    runtime actually exists (see /agent-backend, /as-terminal), so a
   *    resolved call IS the confirmation — clear busy on success, show no
   *    error, and never contradict a conversion that worked.
   *
   *    A watchdog still exists, but a DIFFERENT one: neither `fetch` nor the
   *    ptyd RPC layer sets a timeout, so a control socket that stays OPEN and
   *    stops answering leaves the request pending forever and the strip
   *    disabled with no error and no escape but a reload. This timer only
   *    RE-ENABLES the strip (and says so plainly) — it never claims failure,
   *    and it is cleared on settle and on unmount.
   *
   * 2. A 409 REFUSAL WAS TREATED AS A TRANSIENT ERROR. "this chat already has
   *    messages" is the server telling us our empty-looking view is wrong;
   *    believe it and flip hasMessages, which retires the strip instead of
   *    leaving it armed to 409 again on the next click.
   */
  const pickStall = useRef<number | undefined>(undefined);
  useEffect(
    () => () => {
      window.clearTimeout(pickStall.current);
    },
    [],
  );
  const runConversion = useCallback(
    async (
      busyKey: AgentBackendId | 'terminal' | 'web',
      fallback: string,
      go: () => Promise<void>,
    ) => {
      setPickBusy(busyKey);
      setPickError(null);
      window.clearTimeout(pickStall.current);
      pickStall.current = window.setTimeout(() => {
        setPickBusy(null);
        setPickError('still working — tap again to retry');
      }, CONVERT_STALL_MS);
      try {
        await go();
        window.clearTimeout(pickStall.current);
        setPickBusy(null);
        setPickError(null);
      } catch (e) {
        window.clearTimeout(pickStall.current);
        setPickBusy(null);
        if (e instanceof ApiError && e.status === 409) {
          // The server's answer beats our render state — see hasMessages.
          setHasMessages(true);
        }
        setPickError(e instanceof Error ? e.message : fallback);
      }
    },
    [],
  );
  const choosePick = useCallback(
    (backend: AgentBackendId) =>
      // 'deep' = NO house overlay. Choosing a harness by name means you
      // want that harness as it ships — capabilities injection only.
      runConversion(backend, 'could not start the agent', () =>
        api.setAgentBackend(paneId, backend, 'deep'),
      ),
    [paneId, runConversion],
  );
  const chooseTerminal = useCallback(
    () =>
      runConversion('terminal', 'could not open the terminal', () =>
        api.convertPaneToTerminal(paneId),
      ),
    [paneId, runConversion],
  );
  const chooseWeb = useCallback(
    () => runConversion('web', 'could not open the web view', () => api.convertPaneToWeb(paneId)),
    [paneId, runConversion],
  );

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
      // The server SAYS there is history, we just haven't rendered it yet —
      // history replays asynchronously, so this window opens on every
      // reconnect. Spin; do NOT greet, and above all do not offer to convert
      // the pane out from under a real conversation.
      if (hasMessages)
        return (
          <div className="chat-empty">
            <div className="chat-empty-spinner" aria-hidden="true" />
            <p>Loading conversation…</p>
          </div>
        );
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
            {/* No "send a message below" line: the composer is right there
                with the cursor already in it, so saying so was noise that
                pushed the one thing worth reading — the alternatives — out
                of the eye's path. */}
            <OpenInsteadStrip
              busy={pickBusy}
              error={pickError}
              onBackend={(b) => void choosePick(b)}
              onTerminal={() => void chooseTerminal()}
              onWeb={() => void chooseWeb()}
            />
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
    hasMessages,
    optimisticUser,
    sending,
    loadingOlder,
    expandedGroups,
    toolIndex,
    pickBusy,
    pickError,
    choosePick,
    chooseTerminal,
    chooseWeb,
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

  // The live roster is the union of two sources, and they cover each other's
  // blind spot:
  //
  //  1. The SERVER's durable roster (`subagents`) — authoritative. It is held
  //     from the launching tool_use to an explicit finish, survives turn-done
  //     and reconnects, and is re-announced by the runner on every reconnect.
  //     This is the one that used to be missing entirely.
  //  2. The TRANSCRIPT — every Agent/Task launch minus the ones whose finish
  //     landed. Still needed: it covers launches from BEFORE this server
  //     process (or this runner) started, which the server's roster cannot
  //     know about.
  //
  // Nothing is evicted on a clock any more. The old 30s stale gate is gone —
  // see SUBAGENT_QUIET_MS.
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
    seenAgentIds.add(id);
    const p = subagents[id];
    rosterAgents.push({
      id,
      label: desc,
      steps: p?.steps ?? 0,
      busy: now - (p?.seenAt ?? subagentSeenAt.current.get(id) ?? 0) < SUBAGENT_QUIET_MS,
    });
  }
  // …then anything the SERVER holds that the transcript didn't yield. That is
  // the launch whose message scrolled out of the 128 KB history window (P2), or
  // one this socket connected too late to replay — cases where the transcript
  // simply cannot know, and the server can.
  for (const [id, p] of Object.entries(subagents)) {
    if (p.done || seenAgentIds.has(id) || finishedIds.has(id)) continue;
    // A launch the TRANSCRIPT has already resolved must not be resurrected
    // here. The foreground case is the one that bites: its completion is a
    // tool_result, so `finishedIds` (which only collects task-notifications)
    // says nothing about it — loop 1 correctly skipped it via finishedByResult,
    // which also means it isn't in seenAgentIds.
    const settled = toolIndex.resultFor.get(id);
    if (settled && !LAUNCH_ACK_RE.test(settled.text ?? '')) continue;
    seenAgentIds.add(id);
    rosterAgents.push({
      id,
      label: p.label ?? 'subagent',
      steps: p.steps,
      busy: now - (p.seenAt ?? subagentSeenAt.current.get(id) ?? 0) < SUBAGENT_QUIET_MS,
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

  const liveLabel = liveStatusLabel({ agentCount: rosterAgents.length });

  // Harness pick: a `--pick` pane shows the picker here (not the tab bar).
  // Agents start a runner; Terminal / Web view convert the pane (URL chrome
  // auto-focuses when url is null).
  if (pendingPick) {
    return (
      <div className="chat-pane">
        <div className="chat-empty chat-harness-pick">
          <p className="chat-empty-title">What do you want to open?</p>
          <p className="chat-empty-hint">Pick an agent, or open a terminal / web view</p>
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
                {pickBusy === b.id ? (
                  <span className="chat-harness-spin" aria-hidden="true" />
                ) : null}
              </button>
            ))}
          </div>
          <div className="chat-harness-or">
            <button
              type="button"
              className="chat-harness-quiet"
              disabled={pickBusy !== null}
              aria-busy={pickBusy === 'terminal'}
              onClick={() => void chooseTerminal()}
            >
              {pickBusy === 'terminal' ? (
                <span className="chat-harness-spin" aria-hidden="true" />
              ) : (
                <SvgTerminalGlyph />
              )}
              <span>Terminal</span>
            </button>
            <button
              type="button"
              className="chat-harness-quiet"
              disabled={pickBusy !== null}
              aria-busy={pickBusy === 'web'}
              onClick={() => void chooseWeb()}
            >
              {pickBusy === 'web' ? (
                <span className="chat-harness-spin" aria-hidden="true" />
              ) : (
                <SvgGlobe />
              )}
              <span>Web view</span>
            </button>
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
          {/* Server-owned pending queue rides at the BOTTOM of the chat —
              pending user bubbles under the latest message + working indicator,
              scrolling with the log. Dashed + muted = "waiting its turn"; edit
              pulls it back to the composer, cancel drops it before it runs. Both
              act on the server, so the change follows you across devices. */}
          {queue.map((q) => (
            <div key={q.id} className="chat-turn chat-turn-user chat-turn-queued">
              <div className="chat-queued-actions">
                <button
                  type="button"
                  className="chat-queued-edit"
                  onClick={() => editQueued(q)}
                  aria-label="Edit — restore to the composer"
                  title="Queued — tap to edit before it sends"
                >
                  <SvgRestore />
                </button>
                <button
                  type="button"
                  className="chat-queued-cancel"
                  onClick={() => cancelQueued(q.id)}
                  aria-label="Cancel this queued message"
                  title="Cancel — remove before it sends"
                >
                  ✕
                </button>
              </div>
              <div className="chat-bubble chat-bubble-queued" dir="auto">
                <UserText text={q.text} onOpenImage={setOpenImage} />
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
          <SessionBar
            paneId={paneId}
            folder={folder}
            status={agentStatus}
            {...(session?.assistant ? { assistant: session.assistant } : {})}
            liveLabel={liveLabel}
            agents={rosterAgents}
            send={(obj) => {
              const sock = wsRef.current;
              if (!sock || sock.readyState !== WebSocket.OPEN) {
                setNotice({ text: 'Not connected — try again in a moment.', tone: 'info' });
                return;
              }
              sock.send(JSON.stringify(obj));
            }}
          />
          <div className="chat-composer">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={onPickImages}
            />
            {/* Inside the pill, above the input line — the correction belongs to
                the text it changed, not to the conversation behind it. */}
            {isMobile ? <CleanupHint cleanup={cleanup} variant="chat" /> : null}
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
                onChange={(e) => {
                  setInput(e.target.value);
                  // Editing retires the undo — the stashed original no longer
                  // matches what's in the box.
                  resetCleanup();
                }}
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
              {/* Mobile only, by explicit instruction: dictation is a phone
                  problem. Left of Send because it is the step BEFORE sending. */}
              {isMobile ? (
                <CleanupButton cleanup={cleanup} variant="chat" hasText={input.trim().length > 0} />
              ) : null}
              {sending && !question ? (
                <>
                  {/* Busy + composed text → Queue it (the server holds it and
                      feeds it when the agent frees up) alongside Stop, instead
                      of the old dead-end where a typed message wouldn't send. */}
                  {input.trim() || chips.length > 0 ? (
                    <button
                      type="button"
                      className="chat-send is-queue"
                      onClick={sendMessage}
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
    const name = e.kind === 'tool_use' ? e.name : e.kind === 'thinking' ? 'thinking' : 'result';
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
          <span
            className={`chat-action-group-chevron${expanded ? ' is-open' : ''}`}
            aria-hidden="true"
          >
            ›
          </span>
          <span className="chat-action-group-count">
            {actions} action{actions === 1 ? '' : 's'}
          </span>
          <span className="chat-action-group-summary">{summary}</span>
          {failed > 0 ? <span className="chat-action-group-failed">{failed} failed</span> : null}
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
          <div className="chat-thinking" dir="auto">
            {event.text}
          </div>
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
        (t, key) => (
          <span key={key}>{t}</span>
        ),
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
        (t, key) => (
          <Markdown key={key} text={t} />
        ),
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
      <button
        type="button"
        className="chat-img-close"
        onClick={onClose}
        aria-label="Close"
        title="Close"
      >
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
      apply(
        sRef.current,
        gs.startX + (a.clientX - gs.startCX),
        gs.startY + (a.clientY - gs.startCY),
      );
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
    drag.current = {
      on: true,
      sx: e.clientX,
      sy: e.clientY,
      ox: pRef.current.x,
      oy: pRef.current.y,
    };
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
    <div
      className="chat-gallery"
      style={{ '--n': Math.min(items.length, 3) } as React.CSSProperties}
    >
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
      if (part.kind === 'file')
        out.push(<FileChip key={`f-${i}`} name={part.name} url={part.url} />);
      else out.push(renderText(part.text, `t-${i}`));
    }
  }
  flush();
  return out;
}

// Icon per notice variant — a task update, a session reminder, or a muxpad
// cron fire. The clock is deliberately the SAME glyph the nav uses for "this
// chat has a schedule", so the mark you see on the sidebar row and the mark in
// the transcript read as one thing.
const NOTICE_ICON: Record<NoticeEvent['variant'], string> = {
  task: '⚙',
  reminder: 'ⓘ',
  cron: '⏱',
};

/** Time-of-day for a cron chip, in the VIEWER's zone. The cron's own zone is
 *  the scheduling truth, but this line answers "when did this land for me". */
function fireTime(ts: number | null): string {
  if (ts === null) return '';
  return new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** Harness control message (background-task update / session reminder), or a
 *  muxpad cron fire — "⏱ pr-sweep · 09:00" ahead of the prompt it delivered. */
function NoticeCard({ event }: { event: NoticeEvent }) {
  const at = event.variant === 'cron' ? fireTime(event.ts) : '';
  const detail = event.detail ?? (at || undefined);
  return (
    <div className="chat-turn chat-turn-notice">
      <div className={`chat-sysnote chat-sysnote-${event.variant}`} title={event.text}>
        <span className="chat-sysnote-icon" aria-hidden="true">
          {NOTICE_ICON[event.variant]}
        </span>
        <span className="chat-sysnote-text">{event.text}</span>
        {detail ? <span className="chat-sysnote-detail">{detail}</span> : null}
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

/** Small ring spinner for the subagent roster (CSS spins the wrapper). */
function RosterSpinner() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" aria-hidden="true">
      <circle
        cx="8"
        cy="8"
        r="6"
        stroke="currentColor"
        strokeWidth="2"
        fill="none"
        opacity="0.25"
      />
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
