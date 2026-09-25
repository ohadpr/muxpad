import {
  AGENT_MODE_LABELS,
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
  type ComponentProps,
  Fragment,
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
import { type AgentLaunchOptions, type RecentFolder, api } from '../api';
import {
  AGENT_BACKENDS,
  type AgentBackendId,
  backendLabel,
  conversionFailure,
} from '../lib/agent-backend';
import {
  type MessagePart,
  composeOutgoingMessage,
  splitMessageAttachments,
} from '../lib/attachments';
import {
  actionRunExpanded,
  applyChatVoice,
  chatVoiceActive,
  foldsAsActionRun,
  isPrivateReasoning,
  lastTurnStartId,
  toggleActionRun,
} from '../lib/chat-voice';
import { showFolderChip } from '../lib/nav-row-affordances';
import {
  type HighlightRun,
  highlightRuns,
  queryTerms,
  rehypeSearchHighlight,
} from '../lib/search-highlight';
import {
  SEARCH_JUMP_EVENT,
  type SearchJump,
  jumpMayBeOlder,
  pickSearchTarget,
  takeSearchJump,
} from '../lib/search-jump';
import type { AgentLink } from '../lib/voice/session';
import { useVoice } from '../lib/voice/use-voice';
import { AgentBackendLogo, backendFromAssistant } from './AgentLogos';
import { CopyablePre } from './CopyablePre';
import { SvgAgentGlyph, SvgGlobe, SvgTerminalGlyph } from './PaneWebSwitch';
import { VoiceBar, VoiceControl } from './VoiceControl';

/** Open a media item in the lightbox (image or video). */
type OpenMedia = (m: { url: string; name: string; video: boolean }) => void;
import {
  SEARCH_JUMP_DEADLINE_MS,
  flushChatScrollNow,
  recallChatScroll,
  recallExpandedRuns,
  rememberChatScroll,
  rememberExpandedRuns,
  scrollMemorySidMatches,
  shouldPersistChatScroll,
} from '../lib/chat-scroll';
import { ChatScrollController, FOLLOW_THRESHOLD_PX } from '../lib/chat-scroll-controller';
import { ANCHOR_ATTR, domScrollSurface } from '../lib/chat-scroll-dom';
import { TOP_PAGE_ZONE_PX, shouldPageOlder } from '../lib/chat-scroll-intent';
import { companionTextForImagePaste, splitClipboard } from '../lib/clipboard-detect';
import { liveStatusLabel } from '../lib/live-status';
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
  pre: ({ node: _node, ...props }) => <CopyablePre {...props} />,
};

/**
 * Renders (possibly partial/streaming) markdown for assistant messages.
 *
 * `hl`, when present, is the search terms this message was landed on for. It
 * becomes a rehype pass rather than anything done to `text`: see
 * lib/search-highlight for why the highlight has to happen after parsing.
 * Absent (the overwhelmingly common case) the plugin list is `undefined` and
 * the pipeline is byte-for-byte what it was.
 */
function Markdown({ text, hl }: { text: string; hl?: readonly string[] | undefined }) {
  // Rebuilt only when the TERMS change, not per render: handing react-markdown
  // a fresh plugin array each time re-runs the whole pipeline, and this
  // component renders on every streaming frame.
  const rehypePlugins = useMemo(
    () =>
      hl && hl.length > 0
        ? // The plugin walks a structurally-typed subset of hast (it only needs
          //  `children` and `value`); unified's own `Pluggable` is generic over
          //  the full node types, and the web package deliberately doesn't take
          //  a dependency on them to describe two fields. Cast at this one
          //  boundary rather than pulling in the type packages.
          ([rehypeSearchHighlight(hl)] as ComponentProps<typeof ReactMarkdown>['rehypePlugins'])
        : undefined,
    [hl],
  );
  return (
    <div className="chat-md" dir="auto">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={rehypePlugins}
        components={MD_COMPONENTS}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

/**
 * Plain (non-markdown) message text with the search terms marked.
 *
 * The `<mark>` is the same `.chat-hit` the markdown path emits, so a hit reads
 * identically whether it landed in a user bubble, a thinking block or an
 * assistant answer. No `dangerouslySetInnerHTML` anywhere on either route: the
 * runs are strings and React escapes them.
 */
function HighlightedText({ text, hl }: { text: string; hl?: readonly string[] | undefined }) {
  const runs = useMemo<HighlightRun[] | null>(
    () => (hl && hl.length > 0 ? highlightRuns(text, hl) : null),
    [text, hl],
  );
  if (!runs || !runs.some((r) => r.hit)) return <>{text}</>;
  return (
    <>
      {runs.map((run, i) =>
        run.hit ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: the runs have no identity of their own and the whole message is re-split whenever text or terms change.
          <mark className="chat-hit" key={i}>
            {run.text}
          </mark>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: see above.
          <Fragment key={i}>{run.text}</Fragment>
        ),
      )}
    </>
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

/** The mode chip's glyph. Two shapes, not one shape in two colours: Chat is a
 *  speech bubble (you are talking to muxpad's assistant), Agent is a bare
 *  terminal caret (the harness, as it ships). Colour alone would be invisible
 *  to anyone who can't see the hue difference at 12px. */
function SvgModeGlyph({ mode, size = 12 }: { mode: AgentMode; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" fill="none">
      {mode === 'chat' ? (
        <path
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinejoin="round"
          d="M2.5 4.2c0-.9.7-1.6 1.6-1.6h7.8c.9 0 1.6.7 1.6 1.6v4.9c0 .9-.7 1.6-1.6 1.6H6.9L3.7 13.2v-2.5h-1.2V4.2Z"
        />
      ) : (
        <>
          <path
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
            strokeLinejoin="round"
            d="m3.4 5.1 2.6 2.6-2.6 2.6M7.9 11.2h4.7"
          />
          <rect
            x="1.4"
            y="2.4"
            width="13.2"
            height="11.2"
            rx="1.6"
            stroke="currentColor"
            strokeWidth="1.2"
          />
        </>
      )}
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

/** Trim a trailing slash so `/a/b` and `/a/b/` compare equal. */
const normPath = (s: string) => s.replace(/\/+$/, '') || '/';

/**
 * Choose a folder: one-tap chips for the places you've recently worked, plus a
 * field for anywhere else.
 *
 * ONE implementation, two callers — the session menu's "Switch folder" panel
 * and the launch card. They differ only in what the commit button says and what
 * it does with the value, so the *choosing* is shared: a second folder UI would
 * be the same drift that gave four "+" buttons three different meanings.
 *
 * Chips SET the field rather than committing. Both callers restart a session on
 * commit, so a chip that fired immediately would be a destructive one-tap
 * target sitting under a thumb.
 */
export function FolderChoice({
  inputId,
  value,
  onChange,
  onSubmit,
  folders,
  current,
  disabled,
  autoFocus,
}: {
  inputId: string;
  value: string;
  onChange: (next: string) => void;
  /** Enter in the field. Omitted = Enter does nothing (card has its own button). */
  onSubmit?: (() => void) | undefined;
  folders: RecentFolder[];
  /** The pane's folder right now — always offered, even if it isn't "recent". */
  current: string | null;
  disabled?: boolean;
  /** Focus the field on mount. The session-menu "Switch folder" panel opens
   *  BECAUSE you asked to type a folder, so it should not cost another tap;
   *  the launch card does not set this, since its likely answer is a chip. */
  autoFocus?: boolean;
}) {
  // The current folder leads the row: keeping things where they are is the
  // most likely answer, and it must never be the one option you can't tap.
  const chips: RecentFolder[] = [];
  const seen = new Set<string>();
  const push = (f: RecentFolder) => {
    if (seen.has(normPath(f.path))) return;
    seen.add(normPath(f.path));
    chips.push(f);
  };
  if (current) {
    const known = folders.find((f) => normPath(f.path) === normPath(current));
    push(
      known ?? {
        path: current,
        name: current.split('/').filter(Boolean).pop() || current,
        short: current,
        hasProject: true,
      },
    );
  }
  for (const f of folders) push(f);
  const selected = normPath(value.trim());
  return (
    <div className="chat-folder-choice">
      {chips.length > 0 ? (
        <div className="chat-folder-chips">
          {chips.map((f) => (
            <button
              key={f.path}
              type="button"
              className="chat-folder-chip"
              aria-pressed={normPath(f.path) === selected}
              disabled={disabled}
              title={f.path}
              onClick={() => onChange(f.path)}
            >
              <span className="chat-folder-chip-name">{f.name}</span>
              {/* The bare basename is ambiguous across worktrees — the
                  `~`-relative path underneath is what tells them apart. */}
              <span className="chat-folder-chip-path">{f.short}</span>
            </button>
          ))}
        </div>
      ) : null}
      <input
        id={inputId}
        // biome-ignore lint/a11y/noAutofocus: the panel exists to be typed in
        autoFocus={autoFocus}
        className="chat-folder-input"
        value={value}
        spellCheck={false}
        disabled={disabled}
        aria-label="Working folder path"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && onSubmit) {
            e.preventDefault();
            onSubmit();
          }
        }}
      />
    </div>
  );
}

/**
 * "Start Claude here, on this model" — the setup step between tapping a harness
 * and it starting.
 *
 * WHY IT EXISTS. Tapping Claude/Codex/Cursor used to convert the pane in place
 * and instantly: same pane, same position, same greeting. Nothing visibly
 * happened, so it read as a dead button. And folder + model — the two things
 * you are obviously deciding at that exact moment — were deferred to a session
 * menu behind the model chip, discoverable only if you already knew.
 *
 * So the tap now opens this card instead of firing. It is still ONE TAP for
 * anyone who doesn't care: both fields arrive pre-answered (the pane's current
 * folder; the harness's own default model), so "Start" is immediately correct.
 */
export function HarnessLaunchCard({
  backend,
  folders,
  models,
  paneCwd,
  cwd,
  setCwd,
  model,
  setModel,
  busy,
  error,
  onCancel,
  onStart,
}: {
  backend: AgentBackendId;
  folders: RecentFolder[];
  models: Array<{ value: string; displayName: string; resolvedModel?: string }>;
  /** Where the pane is NOW — always a chip, even when it isn't "recent", so
   *  "leave it where it is" is never the one option you can't tap. */
  paneCwd: string | null;
  cwd: string;
  setCwd: (v: string) => void;
  model: string | null;
  setModel: (v: string | null) => void;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onStart: () => void;
}) {
  const label = backendLabel(backend);
  // Only warn about missing project context when we actually KNOW — i.e. the
  // chosen path is one the server described. A typed path we haven't asked
  // about gets no warning rather than a guessed one.
  const known = folders.find((f) => normPath(f.path) === normPath(cwd.trim()));
  // Claude's own model list contains a literal `default` entry, and this card
  // already HAS a Default pill that means "pass no --model at all". Showing
  // both drew two identical buttons, one of which would have pinned the
  // string 'default' as if it were a model id.
  const pinnable = models.filter((m) => m.value !== 'default');
  return (
    // A labelled SECTION, not a dialog: the card is inline and non-modal — it
    // traps nothing and simply replaces the strip it grew out of — so the
    // semantic element carries the label rather than an ARIA role.
    <section className="chat-launch-card" aria-label={`Start ${label}`}>
      <div className="chat-launch-head">
        <AgentBackendLogo backend={backend} size={18} />
        <span className="chat-launch-title">{label}</span>
        <span className="chat-launch-sub">Agent mode — no muxpad contract</span>
        <button
          type="button"
          className="chat-launch-cancel"
          onClick={onCancel}
          disabled={busy}
          aria-label="Cancel"
        >
          ✕
        </button>
      </div>

      <div className="chat-launch-section">
        <div className="chat-launch-lbl">Folder</div>
        <FolderChoice
          inputId={`launch-cwd-${backend}`}
          value={cwd}
          onChange={setCwd}
          onSubmit={onStart}
          folders={folders}
          current={paneCwd}
          disabled={busy}
        />
        {known && !known.hasProject ? (
          <div className="chat-launch-note">
            No project context here — no git repo, AGENTS.md, or .mcp.json up the tree.
          </div>
        ) : null}
      </div>

      <div className="chat-launch-section">
        <div className="chat-launch-lbl">Model</div>
        <div className="chat-launch-models">
          <button
            type="button"
            className="chat-launch-model"
            aria-pressed={model === null}
            disabled={busy}
            onClick={() => setModel(null)}
          >
            Default
          </button>
          {pinnable.map((m) => (
            <button
              key={m.value}
              type="button"
              className="chat-launch-model"
              aria-pressed={model === m.value}
              disabled={busy}
              title={m.resolvedModel ?? m.value}
              onClick={() => setModel(m.value)}
            >
              {m.displayName}
            </button>
          ))}
        </div>
      </div>

      <button type="button" className="chat-launch-go" disabled={busy} onClick={onStart}>
        {busy ? `Starting ${label}…` : `Start ${label}`}
      </button>
      {error ? <output className="chat-open-instead-error">{error}</output> : null}
    </section>
  );
}

/** What a conversion that LANDED says about itself. Held for CONVERT_CONFIRM_MS. */
export interface ConversionReceipt {
  backend: AgentBackendId;
  cwd: string;
  model: string | null;
}

/**
 * The empty chat's greeting — and the whole reason a conversion is visible.
 *
 * Converting a pane's harness changes nothing about WHERE it is: same pane,
 * same position, same size. So the only place the change can show is the one
 * thing the user is looking at, and this used to be a generic `✳ Ready when
 * you are` that was byte-identical before and after. It now carries the
 * harness's own mark and names it, with the folder underneath — so Claude → Codex
 * is legible at a glance, permanently, not just for the length of a toast.
 *
 * The toast is here too, because "permanently different" and "something just
 * happened" are different jobs: the identity line answers *what is this*, the
 * receipt answers *did my tap do anything*. Both are needed; neither replaces
 * the other.
 *
 * Exported for tests — this is the assertion surface for "a converted pane
 * looks different".
 */
export function ChatReadyGreeting({
  assistant,
  cwd,
  mode,
  converted,
  refusal,
}: {
  assistant: string | undefined;
  cwd: string | null;
  /** The pane's mode. Chat identifies as Chat, not as the harness under it. */
  mode: AgentMode | null;
  converted: ConversionReceipt | null;
  refusal: string | null;
}) {
  // CHAT DOES NOT NAME ITS HARNESS OR ITS FOLDER. Chat IS Claude — that is a
  // fact about the implementation, not a choice the user made, and printing
  // "Claude" here invited the reasonable question of why a thing called Chat
  // says Claude. The folder goes for the same reason: in Chat mode it is not
  // something you picked, and showing a path implies a control that isn't
  // there. Agent mode still names both, because there they ARE your choices.
  const isChat = mode === 'chat';
  return (
    <>
      <div className="chat-empty-mark -logo" aria-hidden="true">
        {isChat ? (
          <SvgModeGlyph mode="chat" />
        ) : (
          <AgentBackendLogo backend={backendFromAssistant(assistant)} size={26} />
        )}
      </div>
      <p className="chat-empty-title">Ready when you are</p>
      <p className="chat-empty-ident">
        <span className="chat-empty-ident-name">{isChat ? 'Chat' : assistantLabel(assistant)}</span>
        {!isChat && cwd ? <span className="chat-empty-ident-cwd">{cwd}</span> : null}
      </p>
      {converted ? (
        // <output> is the live region for "result of the thing you just
        // pressed" — announced without stealing focus from the composer.
        <output className="chat-convert-confirm">
          <AgentBackendLogo backend={converted.backend} size={14} />
          <span>
            Now running {backendLabel(converted.backend)}
            {converted.model ? ` · ${converted.model}` : ''}
            {converted.cwd ? ` · ${converted.cwd}` : ''}
          </span>
        </output>
      ) : null}
      {refusal ? <output className="chat-convert-refusal">{refusal}</output> : null}
    </>
  );
}

/**
 * "or open instead" — the alternatives to a new Chat, shown in the empty
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
 * The three harnesses open the pane in AGENT MODE (the harness as it ships,
 * no muxpad contract). Tapping one does NOT convert on the spot — it opens the launch
 * card (folder + model, both pre-answered), and the card's button converts.
 * Terminal and Web view have nothing to configure, so they still fire directly.
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
      {/* "Agent mode" NAMES THE THING, and that matters here more than
          anywhere: the first button is Claude, and a bare "Claude" sitting
          under a Chat that is already Claude reads as an inexplicable
          duplicate. Labelled as Agent mode it reads as what it is — the same
          harness, raw, with the folder and model yours to choose. */}
      <div className="chat-open-instead-lbl">or open in Agent mode</div>
      <div className="chat-open-instead-row">
        {AGENT_BACKENDS.map((b) => (
          <button
            key={b.id}
            type="button"
            className="chat-open-instead-btn"
            disabled={busy !== null}
            aria-busy={busy === b.id}
            title={`Open ${b.label} in Agent mode — the harness as it ships`}
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
 * The two modes, as the menu lists them. Description is the WHOLE pitch —
 * these two sentences are the only place the vocabulary is explained, so they
 * have to carry it.
 */
const MODE_CHOICES: ReadonlyArray<{ id: AgentMode; label: string; desc: string }> = [
  // Chat doesn't name a harness on purpose: it IS Claude, and which engine is
  // underneath is not a choice you make here (see modeForBackend). Agent is
  // where you pick one.
  {
    id: 'chat',
    label: 'Chat',
    desc: 'muxpad’s assistant — decisive, brief, speaks only when it has something.',
  },
  { id: 'agent', label: 'Agent', desc: 'Pick the harness — as it ships, no muxpad contract.' },
];

/**
 * Status bar: one segmented strip above the composer —
 * mode | folder | model · ctx | agents (when any). Each segment opens its own
 * upward panel; only one panel at a time. Parent-turn busy state stays in
 * the transcript Working… row; this agents cell is subagents only.
 *
 * WHY MODE LIVES HERE. It used to be deliberately hidden — internal plumbing
 * with no UI at all. Once the two modes got names a person can say (Chat /
 * Agent) that stopped being defensible: the pane's arrangement is part of its
 * identity, and identity already lives in this row. It is NOT in the sidebar
 * rail, which runs on a strict one-bit (status) budget; adding a second
 * channel there is how a rail becomes a dashboard.
 */
function SessionBar({
  paneId,
  folder,
  status,
  assistant,
  send,
  liveLabel,
  agents,
  mode,
}: {
  paneId: string;
  folder: { cwd: string; hasProject: boolean } | null;
  status: AgentStatus | null;
  assistant?: string;
  send: (obj: unknown) => void;
  liveLabel: string | null;
  agents: RosterAgent[];
  /** The pane's mode, or null when the server hasn't told us — no chip. */
  mode: AgentMode | null;
  /** Optimistic local echo + the "here is what actually just happened" notice.
   *  The authoritative value still arrives on the next session frame. */
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
    else if (panel === 'model' && (!status || mode === 'chat')) setPanel(null);
    else if (panel === 'folder' && !folder) setPanel(null);
  }, [panel, liveLabel, status, folder, mode]);

  // ── Folder switcher state ────────────────────────────────────────────
  const [draft, setDraft] = useState(folder?.cwd ?? '');
  const [folderBusy, setFolderBusy] = useState(false);
  const [folderErr, setFolderErr] = useState<string | null>(null);
  // Recent folders for the chips — the SAME list the launch card offers, from
  // the same endpoint. Fetched only when this panel is actually opened.
  const [recent, setRecent] = useState<RecentFolder[]>([]);
  const recentFetched = useRef(false);
  useEffect(() => {
    if (panel === 'folder' && folder) {
      setDraft(folder.cwd);
      setFolderErr(null);
    }
    if (panel !== 'folder' || recentFetched.current) return;
    recentFetched.current = true;
    void api
      .agentLaunchOptions()
      .then((o) => setRecent(o.folders))
      .catch(() => {
        // Chips are a shortcut; the path field is the guaranteed way in.
      });
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
  // Chat mode surfaces no folder control at all — see ChatReadyGreeting. The
  // path is still reachable (the session menu behind the model chip lists it),
  // it just isn't presented as a dial in the mode that doesn't have one.
  const folderChipVisible = mode !== 'chat' && showFolderChip(folder);
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
        {/* Same chooser as the launch card (see FolderChoice) — one folder UI,
            so "the places I work" are one tap from both. */}
        <FolderChoice
          inputId={`fld-${paneId}`}
          value={draft}
          onChange={setDraft}
          onSubmit={() => void submitFolder()}
          folders={recent}
          current={folder.cwd}
          disabled={folderBusy}
          autoFocus
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
      {/* INDICATOR, NOT A SWITCH. This reads which mode the pane is in and
          stops there — no menu, no toggle. Switching mid-session was built and
          then removed: no harness can rewrite a live session's system prompt
          (agent-modes.ts documents the evidence backend by backend), so the new
          contract could only ever arrive as a message the conversation drifts
          from. A control that under-delivers on its own label is worse than no
          control — a new pane in the mode you want gets the real thing, and
          that is the only honest way to change it. The mode is still settable
          at creation and over the API; it just isn't a button here. */}
      {mode ? (
        <div
          className="chat-status-seg -mode -static"
          title={`${AGENT_MODE_LABELS[mode]} mode — ${
            MODE_CHOICES.find((m) => m.id === mode)?.desc ?? ''
          }`}
        >
          <SvgModeGlyph mode={mode} />
          <span className="chat-status-seg-label">{AGENT_MODE_LABELS[mode]}</span>
        </div>
      ) : null}

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

      {/* CHAT SHOWS NO MODEL AND NO CONTEXT METER. Both are dials, and Chat
          has none: it runs the default model and compacts itself. A percentage
          is worse than merely redundant — it is a number that asks to be
          watched, in the one mode whose whole promise is that you do not have
          to. `/compact` and `/clear` are slash commands typed in the composer,
          so nothing here is the only way to reach them. Agent mode keeps the
          chip: there the model IS your choice and the meter is the budget you
          are spending. */}
      {mode !== 'chat' && (status || assistant) ? (
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
  // `text` is the message that started this turn, stamped by the server. This
  // component ignores it — the transcript already draws the user bubble — but
  // the voice layer needs it to tell WHOSE answer is coming when it has two
  // requests in flight at once. See session.ts's attribution.
  | { t: 'turn-start'; text?: string }
  | { t: 'stream'; delta: string }
  // ── Speech, and why nothing below handles it ──────────────────────────────
  // The agent's `reply` calls, relayed the instant they exist, for a consumer
  // that has to ACT on them — a voice layer that must start speaking before
  // the sentence is finished.
  //
  // THIS COMPONENT DELIBERATELY HAS NO BRANCH FOR EITHER KIND, and that is the
  // mechanism, not an omission. A reply reaches this UI exactly one way: it
  // lands in the transcript and arrives as an `events` batch. If these frames
  // also drew something, every reply would render twice — once from here,
  // racing, and once from the transcript. They are declared so the contract is
  // written down where a future reader of the message loop will look for it,
  // and so adding a handler is a visible decision rather than an accident.
  | { t: 'speak'; id: string; text: string; n: number }
  | { t: 'speak-delta'; id: string; delta: string }
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
 *
 * `inFlightUser` is the correction for the case where the turn's OWN user
 * message is not in `ordered` yet — an optimistic echo, or a queue drain whose
 * transcript line is still up to a tail-poll away. Without it the "last user
 * event" is the PREVIOUS turn's, so every assistant text of that finished turn
 * counts as "landed this turn" and gets used as the tail anchor against the new
 * turn's preview. Measured shapes: a previous `"a"` anchoring inside a fresh
 * `"a plan for the next step"` left the preview as `"n for the next step"`, and
 * a previous `"Done."` that appears nowhere in the new preview wiped it to ''.
 * A turn with no transcript user line has, by definition, landed nothing.
 */
export function landedThisTurn(ordered: readonly ChatEvent[], inFlightUser = false): string[] {
  if (inFlightUser) return [];
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
 *
 * ── PREFIX FIRST, tail-anchor second ────────────────────────────────────────
 * `lastIndexOf` alone eats the head of the block that is still streaming
 * whenever the landed text also occurs inside it: preview `"OKOK I will
 * continue"` with `["OK"]` landed anchored on the SECOND "OK" and returned
 * `" I will continue"`, so the in-progress block lost its own first two
 * characters — permanently, because later deltas only append to the damaged
 * remainder. When the preview genuinely begins with the concatenation of what
 * has landed — the ordinary case, because the preview IS those deltas — the
 * split point is known exactly and no search is needed. The tail-anchor stays
 * as the fallback for the normalization drift it was written for.
 */
export function consumeStreamedText(preview: string, landed: string[]): string {
  if (!landed.length) return preview;
  const joined = landed.join('');
  if (joined && preview.startsWith(joined)) return preview.slice(joined.length);
  const last = landed[landed.length - 1] as string;
  const idx = preview.lastIndexOf(last);
  return idx >= 0 ? preview.slice(idx + last.length) : '';
}

/**
 * What the reader should see previewed, DERIVED from the turn's raw stream
 * buffer and the transcript as it stands. Pure, and therefore idempotent — run
 * it twice on the same inputs and you get the same answer.
 *
 * ── WHY DERIVE RATHER THAN SUBTRACT ─────────────────────────────────────────
 * `consumeStreamedText` was applied TO THE PREVIEW STATE, destroying it each
 * time. That is only correct if it runs exactly once per landed block, and
 * three separate paths call it (the session hello, a history frame, a live
 * events frame) with the same cumulative `landedThisTurn` list. Two of them
 * firing for one block is not an edge case:
 *
 *  - A mid-turn socket reconnect: the hello consumes the landed block out of
 *    the restored buffer, correctly — and then the history replay that follows
 *    it consumes the SAME block again, out of the already-stripped remainder.
 *    Neither the prefix nor the tail anchor matches any more, so the function
 *    does what it is designed to do when it cannot find the anchor: returns ''.
 *    The paragraph the reader was watching vanished and never came back,
 *    because later deltas only append to the emptied string.
 *  - No socket death required: a tool_use row landing while the next text block
 *    is mid-stream is an ordinary events frame with the same cumulative list,
 *    and wiped the live preview exactly the same way.
 *
 * Keeping the buffer UNCONSUMED and recomputing the preview from it removes the
 * ordering question entirely: the answer depends only on what the server has
 * sent and what the transcript holds, never on how many frames it took to get
 * there. The buffer is the raw thing — deltas append to it, the hello replaces
 * it with the server's whole-turn buffer, and turn-start / turn-done / a dead
 * socket clear it.
 */
export function streamingPreview(
  buffer: string,
  ordered: readonly ChatEvent[],
  inFlightUser: boolean,
): string {
  if (!buffer) return '';
  return consumeStreamedText(buffer, landedThisTurn(ordered, inFlightUser));
}

/**
 * Has the optimistic user bubble's real transcript line landed?
 *
 * Only the NEWEST user event counts, and a SUFFIX match counts as the same
 * message. Two independent mismatches came out of testing every user line for
 * exact equality:
 *
 *  - Sending "yes" while an older "yes" is still in the loaded window retired
 *    the echo instantly, leaving a gap at the bottom of the chat until the real
 *    line arrived a tail-poll later.
 *  - The first send after a Chat/Agent mode switch is written to the transcript
 *    as `<muxpad-mode>…</muxpad-mode>\n\n` + what was typed, so exact equality
 *    never matched and the reader saw their message twice — once clean, once
 *    wearing the XML — until `turn-done`.
 */
export function optimisticEchoLanded(events: readonly ChatEvent[], optimistic: string): boolean {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e?.kind !== 'user') continue;
    return e.text === optimistic || e.text.endsWith(optimistic);
  }
  return false;
}

/**
 * Apply a `phase:'history'` batch, which is a SNAPSHOT of [historyStart, EOF]
 * — not a patch. Returns the new ordered list and whether everything the client
 * already held had to be discarded, or null for "nothing to do".
 *
 * ── WHY A SNAPSHOT ──────────────────────────────────────────────────────────
 * Every socket gets its own `TranscriptTail`, so a reconnect replays history,
 * and a `/compact` rewrite re-emits history for the shrunken file. Appending
 * those through the `byId` dedupe is only correct while the new tail OVERLAPS
 * what is already rendered. Two ways it doesn't:
 *
 *  - A phone backgrounded for minutes comes back to a tail that starts AFTER
 *    the last event it holds. Held `[e1..e10]` + history `[e21..e30]` appended
 *    is a log with a permanent hole, and paging the gap back in PREPENDS it —
 *    `[e11..e20, e1..e10, e21..e30]`, chronology destroyed. If the reader had
 *    already paged to the start, `hasMoreOlder` is false and they cannot even
 *    ask for it.
 *  - `/compact` rewrites the file smaller with NEW uuids. Nothing dedupes, so
 *    the whole pre-compact conversation stays on screen above the summary until
 *    the next remount.
 *
 * ── WHY NOT A BLIND REPLACE ─────────────────────────────────────────────────
 * `DocChat` replaces outright, which is right for a widget with no `load-older`
 * and wrong here: an ordinary reconnect (the overlapping case, and much the
 * commonest one — every mobile backgrounding) would throw away every older page
 * the reader had scrolled back through, collapsing the document under them and
 * dumping them at the tail. So the batch REPLACES FROM ITS OWN FIRST EVENT: the
 * rows before that point are older history the server isn't claiming anything
 * about, and the rows from it on are the server's word. Overlap → the reader
 * sees nothing at all. No overlap → the held list cannot be joined to the
 * snapshot without inventing an order, so it goes, and `load-older` brings the
 * gap back CHRONOLOGICALLY.
 *
 * (An empty batch is a no-op rather than a wipe: the server drops empty emits
 * entirely — `TranscriptTail.emit` only calls back `if (events.length)` — so an
 * empty frame never arrives, and treating a hypothetical one as "the file is
 * now empty" would be a guess.)
 */
/**
 * How far the software keyboard reaches up into the chat pane, in CSS px.
 *
 * ── WHY THE COMPOSER NEEDS THIS AND THE PAGE DOES NOT ───────────────────────
 * `.chat-composer-wrap` is `position: absolute; bottom: 0` of `.chat-pane`, and
 * the pane is sized in LAYOUT viewport units (`100svh`, see main.tsx). On iOS
 * the layout viewport does not shrink when the keyboard opens — only
 * `visualViewport` does — so the composer stays on the layout bottom, under the
 * keyboard, and the scroller's `clientHeight` never changes so the last turns
 * are not reserved above it either. `MobileInputBar` and the nav sheet already
 * special-case exactly this geometry (`sheet-viewport.ts`); chat never did.
 *
 * Returns 0 — i.e. today's behaviour, exactly — with no `visualViewport`, and
 * whenever the visual viewport still reaches the pane's own bottom. A chat pane
 * has no PTY, so unlike the terminal this cannot cascade into a SIGWINCH; that
 * is why main.tsx's ban on a GLOBAL visualViewport height mirror does not apply
 * here.
 */
export function chatKeyboardInset(opts: {
  /** The pane's bottom edge, in layout-viewport coordinates. */
  paneBottom: number;
  /** `visualViewport.offsetTop` — iOS adds this when it scrolls a focused
   *  field into view, and the pane is positioned against the LAYOUT viewport,
   *  so it has to be added back. */
  vvOffsetTop: number;
  /** `visualViewport.height` — the band NOT covered by the keyboard. */
  vvHeight: number;
}): number {
  return Math.max(0, Math.round(opts.paneBottom - (opts.vvOffsetTop + opts.vvHeight)));
}

export function mergeHistorySnapshot(
  prev: readonly ChatEvent[],
  batch: readonly ChatEvent[],
): { events: ChatEvent[]; reset: boolean } | null {
  const head = batch[0];
  if (!head) return null;
  const at = prev.findIndex((e) => e.id === head.id);
  if (at === -1) {
    // No overlap: a gap, or a rewrite that renumbered everything.
    if (prev.length === 0) return { events: [...batch], reset: false };
    return { events: [...batch], reset: true };
  }
  return { events: [...prev.slice(0, at), ...batch], reset: false };
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

/** How long the "now running X" confirmation stays up after a conversion.
 *  Long enough to read on a phone you were not staring at; short enough that
 *  it is gone by the time you have typed your first message. */
const CONVERT_CONFIRM_MS = 8_000;

/** '.ext' when the filename carries a renderable image extension — the
 *  picker's fallback for providers that report an empty MIME type (mirrors
 *  the server upload route's accept rule). */
function imageExtFromName(name: string): string | null {
  const m = /\.[a-z0-9]+$/i.exec(name);
  const ext = m ? m[0].toLowerCase() : '';
  return ext && ext in IMAGE_MIME_BY_EXT ? ext : null;
}

/** The "no search jump" terms list. A module-level constant so `jumpTerms` has
 *  a STABLE identity when there is no jump — `ChatRow` is memoised on it, and a
 *  fresh `[]` every render would defeat that for the whole transcript. */
const NO_TERMS: readonly string[] = [];

/*
 * The row-measuring helpers — `ANCHOR_ATTR`, `anchorRows`, `captureAnchor`,
 * `anchorAt`, `findAnchorRow`, `firstVisibleRow` — used to live here, and are now
 * in lib/chat-scroll-dom.ts behind the `ScrollSurface` port.
 *
 * Not a tidy-up: they were called from five places in this file, each of which
 * re-derived "is this box real?", "which row is the reader on?" and "what is the
 * viewport top?" for itself, and they did not all agree — one clamped an iOS
 * rubber-band scrollTop and the others did not, one treated a row whose bottom
 * sat exactly on the viewport top as past it and another as present. Measuring
 * in one place is what lets the deciding be tested without a browser.
 */

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
  // The pane box, which is what the software keyboard's inset is measured
  // against — see chatKeyboardInset.
  const paneRef = useRef<HTMLDivElement>(null);
  /**
   * THE SCROLL MECHANISM. One object, one writer.
   *
   * Everything this replaced is worth naming, because the shape is the finding:
   * thirteen refs coordinated scroll here (`pinnedToBottom`,
   * `lastProgrammaticTop`, `lastScrollHeight`, `lastScrollTop`, `userScrolled`,
   * `suppressPinUntil`, `holdRememberedAnchor`, `searchJumpHold`, `foldAnchor`,
   * `toggleAnchor`, `liveAnchor`, `jumpSeekPages`, `olderAnchor`) and eleven
   * places assigned `scrollTop`. Twelve of those refs existed to answer one
   * question — "was that scroll event us or the reader?" — which only existed
   * because there were eleven writers. With one writer the question is answered
   * by bookkeeping at the write site, and the refs have nothing to do.
   *
   * What survives is here: `hasMoreOlder` / `loadingOlder` (the pager, a real
   * requirement) and this controller. Nothing else.
   */
  // ── Search jump ───────────────────────────────────────────────────────────
  // The message-tier search hit this pane was opened for, or null. Component
  // state, never storage: a highlight is a property of one visit and must not
  // survive a reload (see lib/search-jump).
  const [jump, setJump] = useState<SearchJump | null>(null);
  // We looked, we paged, and the message is not in reach — say so instead of
  // navigating to a chat that looks like nothing happened.
  const [jumpMissed, setJumpMissed] = useState(false);
  /** Which conversation the controller was last reset for. See the effect below. */
  const enteredPane = useRef<string | null>(null);
  const scroll = useRef<ChatScrollController | null>(null);
  if (!scroll.current) {
    scroll.current = new ChatScrollController(
      domScrollSurface(
        () => scrollRef.current,
        // A search jump's target is the MARK, not the message: a hit two thousand
        // pixels down a long answer is not "brought into view" by showing the top
        // of that answer. Falls back to the ROW when the mark is not there — an
        // attachment-only message, or a match a re-render momentarily dropped —
        // because landing on the right message beats not moving at all.
        (el, id) => {
          const row = el.querySelector(`[${ANCHOR_ATTR}="${CSS.escape(id)}"][data-search-hit]`);
          return row ? (row.querySelector('.chat-hit') ?? row) : null;
        },
      ),
    );
  }
  /**
   * Write the reader's position through to the store.
   *
   * Called ONLY where the controller says the reader chose a position. The
   * previous design called `rememberChatScroll` from `onScroll`, which fires for
   * every writer's scrollTop as well as the reader's — so a restore's own
   * intermediate frames recorded themselves as reading positions, and it needed a
   * hold flag to protect the goal from the loop chasing it. `recordFor` makes the
   * flag unnecessary: a position we placed is not a position the reader chose, so
   * there is nothing to protect.
   */
  /** Reveal "jump to latest" only once meaningfully scrolled up, so it does not
   *  flicker on tiny nudges near the bottom. */
  const syncScrollDownArrow = useCallback(() => {
    const el = scrollRef.current;
    if (!el || el.clientHeight < 40) return;
    setShowScrollDown(el.scrollHeight - el.scrollTop - el.clientHeight > 120);
  }, []);

  const saveScroll = useCallback(() => {
    const c = scroll.current;
    if (!c) return;
    if (
      !shouldPersistChatScroll({
        active: activeRef.current,
        clientHeight: scrollRef.current?.clientHeight ?? 0,
        visible: document.visibilityState === 'visible',
      })
    )
      return;
    const rec = c.record(renderedSid.current);
    if (rec) rememberChatScroll(paneId, rec);
  }, [paneId]);

  /**
   * The reader tapped a run header. Capture where it sits BEFORE the commit that
   * changes its height, and make that the intent.
   */
  const onFoldToggled = useCallback((id: string) => {
    const c = scroll.current;
    const box = c?.rowBox(id);
    if (c && box) c.dispatch({ t: 'fold-toggled', id, offset: box.top });
  }, []);
  // Live mirror of `active` for the WS message handler's closures (which
  // capture it at subscription time) — see the turn-done seen-clear.
  const activeRef = useRef(active);
  activeRef.current = active;
  const wsRef = useRef<WebSocket | null>(null);
  // Voice mode's tap on the frame stream.
  //
  // Voice needs to SEE every server frame (it speaks `speak`/`question` and
  // narrates progress from the rest) without this component growing a second
  // renderer for them. A listener set is the smallest thing that does that:
  // the frames still flow through the same `if (msg.t === …)` chain untouched,
  // and the voice layer reads a copy. Note this is emphatically NOT a place to
  // render from — see the ServerMsg comment on `speak`.
  const frameTaps = useRef(new Set<(raw: unknown) => void>());
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
  // corrected by the server's `older-done`.
  const [hasMoreOlder, setHasMoreOlder] = useState(true);
  // Mirror for the closures that outlive a render: the restore effect re-runs
  // only on activation, so it would otherwise seek against whatever
  // `hasMoreOlder` was when the pane became visible and keep asking for pages
  // the server has already said don't exist.
  const hasMoreOlderRef = useRef(true);
  hasMoreOlderRef.current = hasMoreOlder;
  const [loadingOlder, setLoadingOlder] = useState(false);
  const loadingOlderRef = useRef(false);
  // The in-flight request's safety-net timer — cleared when `older-done` lands
  // (or on unmount/pane switch) so a stale timer can't fire into a LATER
  // request and clear its loading flag mid-flight.
  const olderTimeout = useRef<number | undefined>(undefined);
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
  /**
   * The turn's raw stream buffer — every delta of the CURRENT turn, or the
   * whole-turn buffer the session hello restores after a reconnect. Never
   * stripped: `streamingText` is always `streamingPreview(this, ordered, …)`,
   * recomputed whenever either side moves. See streamingPreview for why the
   * old subtract-in-place shape lost the live paragraph on a reconnect.
   */
  const streamBuffer = useRef('');
  // A session whose transcript never shows up (ended, or its file is gone):
  // after a grace period, say so instead of spinning "waiting" forever.
  const [stale, setStale] = useState(false);
  // The message you just sent, shown immediately as a user bubble until the
  // real one lands from the transcript tail (then deduped away).
  const [optimisticUser, setOptimisticUser] = useState<string | null>(null);
  // Live mirror for the WS handler's closures, which capture state at
  // subscription time. Its one reader is `landedThisTurn`: an echo on screen
  // means the running turn's user line is NOT in `ordered` yet, so nothing has
  // landed for this turn — see that function.
  const optimisticUserRef = useRef<string | null>(null);
  optimisticUserRef.current = optimisticUser;
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
  // Expanded action-run blocks, keyed by the run's first event id — PERSISTED,
  // because a run the reader had opened collapsing on remount is what made the
  // offset into it meaningless. See recallExpandedRuns.
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() =>
    recallExpandedRuns(paneId),
  );
  useEffect(() => {
    rememberExpandedRuns(paneId, expandedGroups);
  }, [paneId, expandedGroups]);
  // Runner-pushed session status: model, context fill, available models.
  // null = no runner status yet (TUI-view chats never get one).
  const [agentStatus, setAgentStatus] = useState<AgentStatus | null>(null);
  const [folder, setFolder] = useState<{ cwd: string; hasProject: boolean } | null>(null);
  // Authoritative emptiness, from the server (see the session frame). Starts
  // TRUE — "assume there is history until told otherwise" — so a slow first
  // frame can never flash the alternatives over someone's conversation.
  const [hasMessages, setHasMessages] = useState(true);
  // The pane's agent mode (Chat / Agent), from the session frame. NULL means
  // "not told yet" and is rendered as NO chip at all — an older server omits
  // the field, and drawing "Agent" for it would put a confident claim about
  // this pane's arrangement on screen with nothing behind it.
  const [mode, setMode] = useState<AgentMode | null>(null);
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
    acked.current = true;
    pendingText.current = '';
    streamBuffer.current = '';
    setStreamingText('');
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
      // Voice's read-only copy, before any branch below can mutate state. It
      // never renders; it decides what to SAY. A throwing tap must not take
      // the chat down with it.
      for (const tap of frameTaps.current) {
        try {
          tap(msg);
        } catch {
          // a broken voice session is not a broken chat
        }
      }
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
          streamBuffer.current = '';
          setStreamingText('');
          setHasMoreOlder(true);
          hasMoreOlderRef.current = true;
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
            // the preview is the buffer MINUS what has landed, or every text
            // segment of the turn shows twice. (On a fresh remount ordered is
            // still empty → landed is [] → the whole buffer shows, and the
            // history replay below re-derives block by block as it lands.)
            streamBuffer.current = msg.streamText;
            setStreamingText(
              streamingPreview(streamBuffer.current, ordered.current, !!optimisticUserRef.current),
            );
          }
        } else {
          // No turn is running, so there is nothing to preview — and a buffer
          // left over from a turn that finished while we were disconnected
          // would be re-derived into view by the very next events frame.
          streamBuffer.current = '';
          setStreamingText('');
        }
        setQuestion(msg.question ?? null);
        // Mirror the hello exactly: no status means no live runner status —
        // a stale chip would keep offering controls that go nowhere.
        setAgentStatus(msg.status ?? null);
        setFolder(msg.cwd ? { cwd: msg.cwd, hasProject: msg.hasProject ?? false } : null);
        // The pane's mode. Authoritative on every (re)connect and re-pushed
        // whenever it changes anywhere — another device, the CLI, automation
        // — so the chip follows a switch live instead of waiting for a
        // reload. Absent → stay null → no chip (see the state declaration).
        setMode(msg.mode ?? null);
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
        if (msg.phase === 'history') {
          // A snapshot of [historyStart, EOF], not a patch — see
          // mergeHistorySnapshot for the hole and the compaction ghosts that
          // appending through `byId` leaves behind.
          const merged = mergeHistorySnapshot(ordered.current, msg.events);
          if (!merged) return;
          ordered.current = merged.events;
          byId.current = new Set(merged.events.map((e) => e.id));
          if (merged.reset) {
            // Everything the reader had paged in is gone with the old list, so
            // the paging cursor has to go back to "there may be more".
            setHasMoreOlder(true);
            hasMoreOlderRef.current = true;
          }
          // The transcript moved, so re-derive the preview from the untouched
          // buffer. A reconnect's history replay is the case that matters: the
          // hello has already accounted for the turn's landed blocks, and this
          // frame is very largely the same events again — deriving gives the
          // same answer twice instead of consuming the same block twice and
          // emptying the live paragraph. See streamingPreview.
          setStreamingText(
            streamingPreview(streamBuffer.current, ordered.current, !!optimisticUserRef.current),
          );
          setEvents(ordered.current);
          return;
        }
        if (fresh.length) {
          for (const e of fresh) byId.current.add(e.id);
          if (msg.phase === 'older') {
            // The batch is chronological and entirely before the current head,
            // so prepend it wholesale. No geometry is captured: the reader's
            // place is held by their intent (a message id), which the commit
            // subscription re-satisfies against the document as it is AFTER the
            // prepend. Capturing heights across a commit is what made the old
            // compensation wrong whenever a live append landed in the same one.
            ordered.current = [...fresh, ...ordered.current];
          } else {
            ordered.current = [...ordered.current, ...fresh];
          }
          // Assistant text that just landed in the transcript leaves the
          // streaming preview, or it would render twice until turn end — so
          // re-derive it against the list we just published. Only 'older' pages
          // are excluded: back-scrolled ancient messages must never touch the
          // live preview, and with no user line in the loaded window
          // `landedThisTurn` would count every prepended assistant row as this
          // turn's.
          if (msg.phase !== 'older') {
            setStreamingText(
              streamingPreview(streamBuffer.current, ordered.current, !!optimisticUserRef.current),
            );
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
        streamBuffer.current = '';
        setStreamingText('');
        pendingText.current = '';
        // ── The queue drain's missing baton ──────────────────────────────────
        // A send that was PARKED (agent busy) is drawn from the server queue:
        // `drainQueue` removes the row and re-broadcasts the queue the instant
        // it relays the text, so the pending bubble disappears — and the user
        // line only appears once the runner has written it to the JSONL and the
        // ~250ms tail poll has picked it up. In between, the message the agent
        // is working on is nowhere on screen: just a working row above an empty
        // spot. The idle-send path is covered by its own optimistic echo; the
        // queued path never set one, and `turn-start.text` (the server's
        // correlation stamp for exactly this message) was being ignored.
        //
        // Setting it again for an idle send is a no-op — same string, same
        // slot — and a turn nobody started (a cron fire, a wakeup) carries no
        // text and sets nothing.
        if (msg.text) setOptimisticUser(msg.text);
      } else if (msg.t === 'stream') {
        // Append to the BUFFER and re-derive, rather than appending to the
        // preview. The two only differ when the transcript and the buffer have
        // drifted far enough that `consumeStreamedText` falls back to hiding
        // the preview — and there, appending would show a tail that the next
        // events frame re-derives away again, i.e. flicker. One rule, one
        // answer: the preview is a function of the buffer and the transcript.
        streamBuffer.current += msg.delta;
        setStreamingText(
          streamingPreview(streamBuffer.current, ordered.current, !!optimisticUserRef.current),
        );
      } else if (msg.t === 'turn-done') {
        setSending(false);
        streamBuffer.current = '';
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
        // The buffer goes with the preview: if the turn finished while we were
        // disconnected, the reconnect's hello carries no streamText, and a
        // stale buffer left here would be re-derived into view by the next
        // events frame. The hello restores it when the turn IS still running.
        streamBuffer.current = '';
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
    // Sending retires a search highlight: it is the clearest possible statement
    // that you are done reading the result you were brought here for. Covers
    // the paths `onChange` doesn't — dictation, and the mobile send button.
    clearJump();
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

  // ── THE DOCUMENT CHANGED: SATISFY THE INTENT ──────────────────────────────
  // This used to be "keep pinned to the bottom as new events arrive", one of
  // eleven places that assigned scrollTop. It is now one of two subscriptions
  // that ask the controller to re-satisfy whatever the reader's intent is —
  // which for a reader at the end IS the bottom, and for a parked reader is
  // holding their row against the commit that just landed.
  //
  // The subagent trigger is the COUNT, not the map: progress ticks replace the
  // map object every ~500ms without changing content height, and each firing
  // costs a forced reflow (a scrollHeight read). Rows appear and disappear only
  // when the count moves.
  // biome-ignore lint/correctness/useExhaustiveDependencies: events/streamingText/optimisticUser/question/subagent-count/queued-count are the triggers — the body reads the DOM, not them
  useLayoutEffect(() => {
    if (!active) return;
    scroll.current?.place();
    // …and the arrow follows the placement. It used to be derived ONLY inside
    // `onScroll`, so a pane that opened somewhere other than the bottom without
    // producing a scroll event — a restore that lands exactly where the document
    // already was, which is the common case for a tab switch — showed no way
    // back to the tail at all.
    syncScrollDownArrow();
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

  // ── Lift the composer off the software keyboard ───────────────────────────
  // MOBILE ONLY, and a no-op everywhere else: `--chat-keyboard-inset` defaults
  // to 0px in the stylesheet, so a pane whose effect never runs is byte for
  // byte the layout that shipped before it. See chatKeyboardInset for why the
  // composer needs this at all (the layout viewport does not shrink on iOS, so
  // `position: absolute; bottom: 0` lands it under the keyboard) and why the
  // global ban on a visualViewport mirror in main.tsx does not reach here (no
  // PTY in a chat pane, so nothing to SIGWINCH).
  // biome-ignore lint/correctness/useExhaustiveDependencies: pendingPick/current_sid gate when the pane box and its composer exist.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!active || !vv || !isMobileLayout()) return;
    const apply = () => {
      const el = paneRef.current;
      if (!el) return;
      el.style.setProperty(
        '--chat-keyboard-inset',
        `${chatKeyboardInset({
          paneBottom: el.getBoundingClientRect().bottom,
          vvOffsetTop: vv.offsetTop,
          vvHeight: vv.height,
        })}px`,
      );
    };
    // iOS Safari can fire `resize` only at the END of the keyboard animation,
    // so track through the slide for a beat on focus — the same shape (and the
    // same 600ms) MobileInputBar uses for the same reason.
    let frame: number | null = null;
    const trackUntil = (deadline: number) => {
      apply();
      frame =
        performance.now() < deadline ? requestAnimationFrame(() => trackUntil(deadline)) : null;
    };
    const onFocus = () => {
      if (frame !== null) cancelAnimationFrame(frame);
      trackUntil(performance.now() + 600);
    };
    vv.addEventListener('resize', apply);
    vv.addEventListener('scroll', apply);
    const pane = paneRef.current;
    pane?.addEventListener('focusin', onFocus);
    pane?.addEventListener('focusout', onFocus);
    apply();
    return () => {
      vv.removeEventListener('resize', apply);
      vv.removeEventListener('scroll', apply);
      pane?.removeEventListener('focusin', onFocus);
      pane?.removeEventListener('focusout', onFocus);
      if (frame !== null) cancelAnimationFrame(frame);
      pane?.style.removeProperty('--chat-keyboard-inset');
    };
  }, [active, pendingPick, session?.current_sid]);

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

  // ── RE-ENTRY ──────────────────────────────────────────────────────────────
  // Becoming visible is an INPUT, and the placement is one call. What was here
  // before was a 120-line animation-frame loop with a 2500ms fuse, extended
  // 1500ms per history page, capped at 15s, killed early by a sticky flag — all
  // of it polling for "has the document finished settling?" while the
  // ResizeObserver twenty lines down was already being told.
  //
  // `showEpoch` is a re-run trigger for the visibility transitions that never
  // touch `active`: a browser-tab switch, an iOS app backgrounding, a bfcache
  // restore. Those hide the pane as thoroughly as display:none does.
  //
  // Sid matching is soft: memory may be saved before the hello binds
  // `renderedSid` (or a remount starts with sid null). Requiring equality skipped
  // every restore for the whole window. Only a REAL mismatch — both set,
  // different — is a different conversation, and that is treated as no memory at
  // all rather than as a position to distrust, because "restore nothing but also
  // do not follow" was the worst of both.
  // ONE effect, because the ORDER of these two dispatches is load-bearing and a
  // second effect is a place to get it wrong. It was wrong: `mounted` was
  // declared after `shown`, React runs layout effects in declaration order, and
  // so every fresh mount read the memory, set the intent from it, and then
  // immediately reset that intent to "we do not know". The pane then opened at
  // the top of the conversation, paged its entire history because nothing said a
  // reader was following, and stored nothing — three headline failures from one
  // reordering, none of which a module test could see.
  //
  // Keyed on `paneId` for the reset, not on mount: the seek budget has to
  // survive every visibility flip of one visit (it used to be a local of the
  // restore effect, so three tab switches spent 24 `load-older` round trips
  // hunting the same unreachable message) and must not survive a different
  // conversation.
  //
  // biome-ignore lint/correctness/useExhaustiveDependencies: showEpoch is a re-run trigger — becoming visible again must re-place.
  useLayoutEffect(() => {
    const c = scroll.current;
    if (!c) return;
    if (enteredPane.current !== paneId) {
      enteredPane.current = paneId;
      c.dispatch({ t: 'mounted' });
    }
    if (!active) {
      c.dispatch({ t: 'hidden' });
      return;
    }
    const mem = recallChatScroll(paneId);
    c.dispatch({
      t: 'shown',
      mem: mem && scrollMemorySidMatches(mem.sid, renderedSid.current) ? mem : null,
    });
  }, [active, paneId, showEpoch]);

  /*
   * ── NO PREPEND COMPENSATION ───────────────────────────────────────────────
   * A layout effect used to live here, applying `scrollTopAfterOlderPrepend`:
   * capture `scrollHeight`/`scrollTop` before a prepend, and after it assign
   * `newHeight - oldHeight + oldTop`. It is gone, along with the `olderAnchor`
   * ref that carried the geometry across the commit and the `forEvents` identity
   * check that kept it from being applied to the wrong one.
   *
   * Two reasons, and the second is the one that makes this a deletion rather
   * than a move. First, the commit subscription above already re-satisfies the
   * intent on the very commit the prepend lands in, and an ANCHORED reader's
   * intent IS "hold this row" — so the work is done by the general mechanism.
   *
   * Second, the arithmetic was wrong in a way row-based compensation cannot be.
   * It measured the document's TOTAL height, so a live append batched into the
   * same React commit as an older prepend was counted as growth above the
   * reader: measured, it assigned 400 where 300 was right, with the
   * commit-identity check passing. `targetFor` never looks at the document's
   * height, so it cannot make that mistake — and it is asserted under a
   * prepend-and-append-in-one-commit case in chat-scroll-controller.test.ts,
   * on both engine settings.
   */

  // Fill the viewport: the initial history window is a byte tail, and a few
  // huge records (base64 image pastes run to hundreds of KB per line) can
  // eat the whole window — rendering less than a screenful of chat. With no
  // overflow there are no scroll events, so the scroll-up pager could never
  // fire and the rest of the conversation was unreachable. Keep paging older
  // batches until the content overflows (or history is exhausted): requests
  // are single-flight, and every server call moves the byte cursor back, so
  // this terminates even when a batch renders nothing new.
  //
  // ── AND THE SAME DEAFNESS AT scrollTop 0 ────────────────────────────────────
  // Overflow is not the only way to have no scroll events. `requestOlder` is
  // otherwise driven ONLY by `onScroll`, and a browser fires no scroll event
  // when scrollTop is already 0 and you wheel up. Two measured ways to be
  // parked there with more history to fetch, both of them "I came back and
  // scrolling up won't bring my conversation back":
  //
  //  - A no-overlap reconnect (a gap, a /compact) REPLACES the list under a
  //    reader who had paged to the start. 30 rows, scrollTop 0, hasMoreOlder
  //    back to true — and 84 wheel notches produced zero requests. Nudging
  //    DOWN 900px and wheeling up again unwedged it instantly.
  //  - An ordinary OVERLAPPING reconnect leaves the client's view ahead of the
  //    server's paging cursor: the new tail's `historyStart` is well after the
  //    oldest row still held, so the next page or two are pure duplicates that
  //    prepend nothing and move scrollTop not at all. Frozen at the top, same
  //    silence.
  //
  // So the top zone re-arms the pager too, off the same two triggers (a fresh
  // events commit, and `older-done` clearing `loadingOlder`). It terminates on
  // the same argument as the overflow case: a page that renders something
  // moves the reader out of the zone via the prepend anchor, one that renders
  // nothing still moved the server's cursor back, and `hasMoreOlder` ends it.
  //
  // The two guards are onScroll's, for its reasons. `pinnedToBottom` keeps a
  // reader at the BOTTOM out of this entirely, and the suppression window keeps
  // out a just-shown pane that reports scrollTop 0 while its layout settles —
  // paging on that would prepend history on every tab visit. Unlike a scroll
  // event, though, nothing re-delivers this check when the window expires, so a
  // suppressed pass re-checks itself once the settle is over.
  useEffect(() => {
    const c = scroll.current;
    const el = scrollRef.current;
    if (!active || !c || !el) return;
    // The whole decision is in `shouldPageOlder`, pure and tested — including
    // the loop it used to be able to enter, which rendered a 990-row
    // conversation at mount where the server serves a 126-row tail.
    const why = shouldPageOlder({
      phase: c.phase(hasMoreOlder),
      placed: c.hasPlaced(),
      geo: {
        scrollTop: el.scrollTop,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
      },
      measurable: el.clientHeight >= 40,
      hasMoreOlder,
      loadingOlder,
      haveEvents: events.length > 0,
      sessionBound: !!session?.current_sid,
    });
    if (why !== 'no') requestOlder();
  }, [active, events, loadingOlder, hasMoreOlder, session?.current_sid]);

  // ── THE SEEK ──────────────────────────────────────────────────────────────
  // The controller owns the budget and says when a page is worth asking for; the
  // socket owns whether one can be sent. Re-runs on every events commit, which is
  // what makes it self-driving: each answered page changes `events`, the row may
  // now be loaded, and `wantsOlder` says so.
  //
  // ONE budget for both callers. The restore's seek and the search jump's seek
  // used to be separate counters with separate loops and the same constant.
  useEffect(() => {
    if (!active || loadingOlder) return;
    if (!scroll.current?.wantsOlder(hasMoreOlder)) return;
    if (requestOlder()) scroll.current.dispatch({ t: 'sought' });
  }, [active, events, loadingOlder, hasMoreOlder]);

  /** @returns whether a request actually went out — the anchor seek spends its
   *  budget in REQUESTS, not attempts. */
  const requestOlder = (): boolean => {
    // The ref, not the state: the restore effect's seek holds this closure
    // across many renders and must see the server's latest answer.
    if (loadingOlderRef.current || !hasMoreOlderRef.current) return false;
    const ws = wsRef.current;
    if (ws?.readyState !== WebSocket.OPEN) return false;
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
    return true;
  };

  // ── Search jump ───────────────────────────────────────────────────────────
  // "When you take me to a search result, highlight the term on the page you
  // took me to." Everything below serves one sentence, in four parts: claim the
  // hit, find the message it names, put it on screen, and get out of the way.
  //
  // Only the MESSAGE tier ever gets here — an instant (name/headline/workspace)
  // hit carries nothing, because the term may not be in the transcript at all.
  // See lib/search-jump for that argument in full.

  /** The terms to light up. Stable per jump, because `ChatRow` is memoised on
   *  it and a fresh array every render would re-parse the message's markdown on
   *  every subagent progress frame. */
  const jumpTerms = useMemo(() => (jump ? queryTerms(jump.query) : NO_TERMS), [jump]);

  /**
   * Which loaded message the hit names — null while it is still off the end of
   * the loaded window (the seek below is what fixes that) or genuinely absent.
   *
   * A jump is dropped outright when the rendered sid disagrees with the one the
   * archive matched in: a `/clear` or a resume rotation makes this a different
   * conversation, and lighting up a coincidental occurrence in it would claim
   * the search found something it did not.
   */
  const jumpTargetId = useMemo(() => {
    if (!jump || jumpTerms.length === 0) return null;
    if (!scrollMemorySidMatches(jump.sid, renderedSid.current)) return null;
    return pickSearchTarget(events, { terms: jumpTerms, ts: jump.ts });
  }, [jump, jumpTerms, events]);

  const clearJump = useCallback(() => {
    // The reader owns the scroll again, and where they are now is what the
    // memory is for. `search-cleared` carries their position so the intent stops
    // being a destination and becomes a reading position in the same call.
    //
    // The other half used to be a `foldAnchor` ref: dismissing a highlight lets
    // the run it forced open snap shut, and the dismissal signal IS the hit
    // leaving the top of the screen — so the run is above the reader by
    // construction and its whole expanded height vanishes from above them
    // mid-read (measured: a 430px leap). That ref is gone. The reader's intent
    // is a row id, and the commit that closes the run re-satisfies it against
    // the collapsed document, which is the same work without the hand-off.
    const c = scroll.current;
    const el = scrollRef.current;
    if (c && el && el.clientHeight >= 40) {
      const geo = {
        scrollTop: el.scrollTop,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
      };
      c.dispatch({
        t: 'search-cleared',
        here: c.anchorHere(),
        atEnd: geo.scrollHeight - geo.scrollTop - geo.clientHeight < FOLLOW_THRESHOLD_PX,
      });
    }
    setJump(null);
    setJumpMissed(false);
  }, []);

  /*
   * ── NO FOLD COMPENSATION EFFECT ───────────────────────────────────────────
   * Two layout effects used to live here: one applying `scrollTopAfterFoldChange`
   * after a highlight dismissal closed a run, and one applying
   * `scrollTopForAnchor` after the reader toggled a run open or shut, each with
   * a ref carrying geometry across the commit (`foldAnchor`, `toggleAnchor`).
   *
   * Both are gone, and the second is the more interesting deletion. It existed
   * because the re-pin observer could not tell a height change the READER caused
   * from a thumbnail decoding, so for a reader at the bottom it answered an
   * expand by scrolling to the new bottom — measured, a 1500px expansion moved
   * the tapped header from +272 to -1228 while the reply below it did not move a
   * pixel, i.e. tapping "12 actions" visibly did nothing. With a fold toggle as a
   * named INPUT, the intent becomes "hold this header where it was" and the
   * commit subscription does the rest.
   */

  // Claim a pending jump. Both routes exist because the destination pane may or
  // may not be mounted when the result is clicked: the map covers "opened a
  // chat in a workspace I hadn't visited", the event covers "jumped inside the
  // tab I was already looking at".
  //
  // Claiming takes the scroll away from the restore loop deliberately —
  // `userScrolled` is what stops that loop, and a jump and a restore both
  // writing scrollTop would fight for the whole settling window. The jump wins:
  // it is the thing the user just asked for.
  useEffect(() => {
    if (!active) return;
    const claim = (j: SearchJump) => {
      // A jump is a destination the reader asked for from somewhere else, so it
      // takes the scroll: the intent becomes the hit, which `recordFor` refuses
      // to store and `shown` refuses to overwrite. Three coordinating booleans
      // used to say that (`searchJumpHold`, `shouldRememberPosition`,
      // `shouldRestorePosition`) and they existed only to stop OTHER owners of
      // the scroll from fighting it.
      setJumpMissed(false);
      setJump(j);
    };
    const claimed = takeSearchJump(paneId);
    if (claimed) claim(claimed);
    const onJump = (e: Event) => {
      const detail = (e as CustomEvent<SearchJump>).detail;
      if (!detail || detail.paneId !== paneId) return;
      // Consume the mailbox copy too, so a remount can't replay it.
      takeSearchJump(paneId);
      claim(detail);
    };
    window.addEventListener(SEARCH_JUMP_EVENT, onJump);
    return () => window.removeEventListener(SEARCH_JUMP_EVENT, onJump);
  }, [active, paneId]);

  // ── Dismissal ─────────────────────────────────────────────────────────────
  // A highlight answers a question ("where is it?"). It has to go when the
  // question has been answered, and the honest signals for that are all things
  // the READER does — not a timer, which would either blink out while they are
  // still reading or leave the chat lit up long after they stopped caring.
  //
  //   · leaving the pane (here) — the visit the search started is over;
  //   · Escape — the universal "I'm done with this";
  //   · typing or sending — you are using the chat now, not reading a result;
  //   · scrolling the hit off screen — you have moved on within the chat;
  //   · a new jump — it supersedes;
  //   · a reload — it was never persisted anywhere.
  //
  // Leaving covers the long tail: nothing here can still be lit an hour later,
  // because an hour later you have looked at something else.
  const jumpWasActive = useRef(active);
  useEffect(() => {
    if (jumpWasActive.current && !active) clearJump();
    jumpWasActive.current = active;
  }, [active, clearJump]);

  useEffect(() => {
    if (!jump || !active) return;
    const onKey = (e: KeyboardEvent) => {
      // A modal owns Escape while it is up — closing the lightbox should not
      // also throw away the highlight underneath it.
      if (e.key === 'Escape' && !openTool && !openImage) clearJump();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [jump, active, openTool, openImage, clearJump]);

  // Scrolled away. An IntersectionObserver rather than a scroll handler so the
  // rule is "the hit left the screen", not "the reader scrolled N pixels" —
  // and armed only AFTER the row has actually been seen, so the placement's own
  // motion (which starts with the row off screen) can't dismiss the highlight
  // before it has been shown.
  useEffect(() => {
    const el = scrollRef.current;
    if (!jump || !jumpTargetId || !active || !el) return;
    const row = el.querySelector('[data-search-hit]');
    if (!row) return;
    let seen = false;
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) seen = true;
          else if (seen) clearJump();
        }
      },
      { root: el },
    );
    io.observe(row);
    return () => io.disconnect();
  }, [jump, jumpTargetId, active, clearJump]);

  // ── Placement ─────────────────────────────────────────────────────────────
  // A jump's destination is an intent like any other, so "put the mark on screen
  // and keep it there" is: set the intent when the target binds, and let the
  // commit subscription satisfy it as the document settles. What was here was a
  // second animation-frame loop with its own 1200ms fuse, re-asserting a target
  // every frame — the restore loop's twin, for the same reason and with the same
  // answer.
  //
  // `showEpoch` is a trigger for the same reason the re-entry effect has one: a
  // hide can cost the pane its scrollTop, and the reader who comes back must find
  // the hit where they left it rather than at the top of the document.
  // biome-ignore lint/correctness/useExhaustiveDependencies: showEpoch is a re-run trigger — a jump that owns the scroll must re-place itself when the pane becomes visible again.
  useLayoutEffect(() => {
    if (!active || !jumpTargetId) return;
    scroll.current?.dispatch({ t: 'search-jump', id: jumpTargetId });
  }, [active, jumpTargetId, showEpoch]);

  /*
   * ── NO SEPARATE JUMP SEEK ─────────────────────────────────────────────────
   * An effect here used to page older history hunting the jump's message, with
   * its own counter (`jumpSeekPages`) against the same constant the restore's
   * seek used. There is one seek now, driven by `wantsOlder` — the controller
   * does not care whether the row it cannot find is a remembered position or a
   * search hit, because in both cases the honest move is the same: ask for a
   * page, count it, and stop at the budget.
   *
   * What remains jump-specific is knowing when to give up and SAY so, which is
   * below: `jumpMayBeOlder` is the "it is inside the loaded range and still not
   * there" case (a subagent sidechain, which the archive indexes and the chat
   * view does not render), and the deadline is the backstop for a socket that
   * never opens.
   */
  useEffect(() => {
    if (!jump || !active || jumpTargetId || jumpMissed || loadingOlder) return;
    if (
      !hasMoreOlder ||
      !jumpMayBeOlder(events, jump.ts) ||
      !scroll.current?.wantsOlder(hasMoreOlder)
    ) {
      setJumpMissed(true);
    }
  }, [jump, active, jumpTargetId, jumpMissed, loadingOlder, hasMoreOlder, events]);

  // Backstop for the seek stalling silently — a socket that never opened, or a
  // server build with no `load-older`. Without it the reader is left on a chat
  // that looks like the search did nothing.
  useEffect(() => {
    if (!jump || jumpTargetId || jumpMissed) return;
    const t = window.setTimeout(() => setJumpMissed(true), SEARCH_JUMP_DEADLINE_MS);
    return () => window.clearTimeout(t);
  }, [jump, jumpTargetId, jumpMissed]);

  // Coming back from a browser-tab switch / app background / bfcache restore
  // is a show transition too — the pane's `active` never moved, but its
  // layout (and, on some engines, its scrollTop) may have. Bumping this
  // re-runs the restore + settling loop above.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      // iOS resets overflow scroll on resume — that is what `showEpoch` exists
      // for — and the native `scroll` event from that reset can run in this same
      // turn, while the layout effect reacting to the bump is still queued behind
      // a render. Nothing has to be armed for it: the controller believes no
      // scroll event until it has placed something since becoming visible, which
      // is a causal gate rather than a 250ms window, and `hidden` is what opened
      // it. This used to be a wall-clock deadline stamped here AND re-stamped in
      // the effect, because a state update cannot cover the half-frame in
      // between.
      scroll.current?.dispatch({ t: 'hidden' });
      setShowEpoch((n) => n + 1);
    };
    // `pageshow` ONLY when it is a bfcache restore. It also fires on an ordinary
    // first load — after `load`, which waits for subresources, so a chat full of
    // pasted screenshots delays it a long way past mount: measured 13ms to mount
    // and 1661ms to pageshow behind one slow image. That bump re-ran the restore
    // on every cold open, 1.6s in, resetting `userScrolled` to false and
    // re-asserting the frozen goal — yanking back a reader who had scrolled away
    // in the meantime, including one who had scrolled with the wheel, whose
    // `taken()` flag this reset unconditionally. A `persisted` pageshow is the
    // real case this listener was added for: the document comes back with its
    // layout restored from cache and nothing else tells us.
    const onPageShow = (e: PageTransitionEvent) => {
      if (e.persisted) onVisible();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('pageshow', onPageShow);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('pageshow', onPageShow);
    };
  }, []);

  /*
   * ── NO GESTURE LISTENERS ──────────────────────────────────────────────────
   * An effect here attached `wheel`, `touchmove`, `keydown` and `pointerdown` to
   * the scroller, to set a flag saying the reader had taken control. It is gone,
   * and its absence is a correctness improvement rather than a saving.
   *
   * The set was never exhaustive and could not be. It started as wheel and touch;
   * keyboard paging, scrollbar-thumb drags and drag-select autoscroll reached
   * none of them (measured: 7128px of real drag-select motion producing ZERO
   * reader verdicts across 158 scroll events, and 0 across 244 for PageDown),
   * so `keydown` and `pointerdown` were added — and two movers still had no
   * listener at all, because they are not gestures on the scroller: sequential
   * focus navigation onto an off-screen button inside the log (the log has
   * several) and find-in-page.
   *
   * The controller answers the question geometrically instead: a scroll event
   * that leaves the reader's ROW where it was is the document moving under a
   * stationary reader, and anything else is the reader — whatever device they
   * used, and including the two nobody had counted. One rule, no per-device
   * enumeration, and nothing sticky to disarm.
   */

  // ── THE OTHER SUBSCRIPTION: the document changed outside a React commit ───
  // Plenty of height arrives with no state change behind it: image and gallery
  // thumbnails decoding late (they are lazy and have no intrinsic size), the
  // composer regrowing after a show, fonts settling, the viewport changing. This
  // is the notification for all of them — and it is the notification the old
  // settling loop was polling for with a 2500ms fuse.
  //
  // It used to carry two branches and three stand-downs: re-assert the bottom if
  // pinned, else re-anchor a row from a snapshot ref, unless a search jump or a
  // seeking restore owned the scroll. All of that is now one `place()`, because
  // "what should be true" is the intent and this only has to say "it may have
  // stopped being true".
  //
  // `pendingPick` is a dependency because the harness picker renders a DIFFERENT
  // tree with no `.chat-scroll` in it: an active pane that starts on the picker
  // has a null ref here, and without re-running when the real chat mounts the
  // observer would never attach for that pane's whole life.
  // biome-ignore lint/correctness/useExhaustiveDependencies: pendingPick gates when the scroll container exists.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !active) return;
    let last = '';
    const ro = new ResizeObserver(() => {
      // Both dimensions matter: content growing (scrollHeight) and the viewport
      // shrinking (clientHeight — composer regrowth, window resize) each move
      // where the intent's target lies.
      const key = `${el.scrollHeight}x${el.clientHeight}`;
      if (key === last) return;
      last = key;
      scroll.current?.place();
    });
    ro.observe(el);
    // The scroll container's own box often does not change when its CONTENT
    // grows, so watch the list too — that is the element images live in.
    //
    // BORDER-BOX, not the default content-box: the composer's clearance is a
    // sibling row at the end of the list, and a content-box observer would not
    // see it resize.
    const list = el.querySelector('.chat-list');
    if (list) ro.observe(list, { box: 'border-box' });
    return () => ro.disconnect();
  }, [active, pendingPick]);

  /**
   * A scroll event arrived. Ask the controller whose it was; if it was the
   * reader's, their position is now the intent and is worth storing.
   *
   * This was 180 lines. It computed `nearBottom` from raw geometry and set the
   * pin from it, ran two discriminators over four refs, decided what to preserve
   * from the store versus what to overwrite, and wrote the memory on every
   * event. Every one of those decisions is now either a state transition or a
   * consequence of one.
   */
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    if (scroll.current?.onScroll()) saveScroll();
    // Hysteresis: only reveal the arrow once meaningfully scrolled up, so it
    // doesn't flicker on tiny nudges near the bottom. Derived from current
    // geometry and self-correcting, so it is deliberately outside the
    // reader-or-layout question.
    syncScrollDownArrow();
    // Near the top → page in earlier messages. A reader at the bottom is not
    // paging history, and a pane that has not been placed yet has not had its
    // layout read (the old version needed a 250ms window here, because a
    // just-shown pane reports scrollTop 0 while it settles and paging on that
    // prepended a batch of history on every tab visit).
    if (
      el.scrollTop < TOP_PAGE_ZONE_PX &&
      events.length > 0 &&
      scroll.current?.phase(hasMoreOlderRef.current) !== 'FOLLOWING'
    ) {
      requestOlder();
    }
  };

  const scrollToBottom = () => {
    setShowScrollDown(false);
    // The one gesture that unambiguously means "follow the tail again". It is an
    // INPUT, so it needs no flag — and it used to need one, because the smooth
    // glide below emitted a scroll event per frame at positions nothing had
    // written, so each was read as the reader scrolling away from the target the
    // button had just set.
    //
    // There is no glide any more. `behavior: 'smooth'` is an unattributable
    // writer we opted into voluntarily: the browser interpolates, so neither half
    // of the discriminator can recognise the intermediate frames, and that is the
    // entire reason `SMOOTH_SCROLL_SETTLE_MS` (600ms) existed. A cosmetic easing
    // bought a hole in the one invariant this mechanism rests on.
    scroll.current?.dispatch({ t: 'jump-to-latest' });
    saveScroll();
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

  // Drop the optimistic user bubble once the real one lands from the
  // transcript. See optimisticEchoLanded for why only the NEWEST user line
  // counts and why a suffix match does.
  //
  // A LAYOUT effect, not a plain one: a plain effect runs after paint, so the
  // commit that first carries the real user event paints the echo alongside it
  // — the reader's own message on screen twice, and a one-frame height bounce
  // that a pinned reader gets re-pinned through in both directions, at the
  // exact moment they are looking at the bottom of the chat.
  useLayoutEffect(() => {
    if (optimisticUser && optimisticEchoLanded(events, optimisticUser)) {
      setOptimisticUser(null);
    }
  }, [events, optimisticUser]);

  // CHAT MODE'S VOICE. In Chat mode the agent's plain text is a private
  // scratchpad and its `reply` calls are the conversation; this decides which
  // events are messages and which fold into the "N actions" rows. Presentation
  // ONLY — `events` (and the transcript, and the archive) still hold every
  // word, which is what makes the fold auditable rather than a disappearance.
  //
  // `sending` is the live-turn signal: it goes true synchronously on send and
  // on turn-start, false on turn-done, so the guard's promotion lands exactly
  // when the turn closes rather than flickering mid-turn.
  //
  // It is not enough on its own. `sending` says a turn is RUNNING; the voice
  // needs to know whether the last segment IS that turn, and for a beat at the
  // start of every turn it isn't — the flag is a socket frame (or an
  // optimistic send), the user's message is a transcript line that has to be
  // written, tailed and normalised first. The latch below closes that gap:
  // while nothing is running, the last segment is by definition finished, so
  // record which one it is; while a turn runs the value is FROZEN, and the
  // voice compares against it to tell "the running turn hasn't written
  // anything yet" from "the last segment is the running turn". See
  // closedTurnStartId in chat-voice.ts for the measured symptom.
  const lastTurnStart = useMemo(() => lastTurnStartId(events), [events]);
  const closedTurnStart = useRef<string | null>(null);
  if (!sending) closedTurnStart.current = lastTurnStart;
  const closedTurnStartId = closedTurnStart.current;
  const voiceOpts = useMemo(
    () => ({ mode, turnActive: sending, assistant: session?.assistant, closedTurnStartId }),
    [mode, sending, session?.assistant, closedTurnStartId],
  );
  const voiceOn = chatVoiceActive(voiceOpts);
  const voiced = useMemo(() => applyChatVoice(events, voiceOpts), [events, voiceOpts]);

  // ── SPOKEN voice (GPT-Live) ────────────────────────────────────────────────
  //
  // Reuses `voiceOn` — the SAME predicate that decides Chat mode's written
  // voice — so the mic can never appear in Agent mode, and can never appear on
  // a backend Chat mode doesn't support. One predicate, no second door.
  //
  // The link below is the ONLY path from the voice layer to the agent, and it
  // is the path the composer already uses: `{t:'send'}` and `{t:'stop'}` on
  // this pane's socket. A spoken request therefore lands in the transcript
  // verbatim, queues behind a busy agent like any other, and shows on screen
  // while the model paraphrases it aloud.
  const agentLink: AgentLink = {
    send: (text: string) => dispatchSend(text),
    stop,
    // An explicit spoken cancel must reach the BACKLOG too, not just the turn
    // on the wire — `stop` only touches what is running, and honouring "stop"
    // by killing one turn and then firing the next queued one at the agent is
    // not what anybody means. Same server-owned queue the pending bubbles use.
    cancelQueued: (id: string) => {
      cancelQueued(id);
    },
    // The same frame the QuestionCard's chips send. A gate question raised
    // mid-turn blocks the pane until this arrives, and a `send` cannot take its
    // place — the server queues that behind the running turn, so the answer
    // would wait on the question it was meant to release.
    answer: answerQuestion,
    onFrame: (cb) => {
      frameTaps.current.add(cb);
      return () => frameTaps.current.delete(cb);
    },
  };
  const voice = useVoice({ paneId, enabled: voiceOn, agent: agentLink });

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
   * The harness the user tapped, with its (pre-answered) folder and model,
   * waiting on "Start". Non-null = the launch card is open in place of the
   * strip. Nothing has been sent to the server yet — this is the step that
   * used to not exist, when a tap converted the pane instantly and invisibly.
   */
  const [staged, setStaged] = useState<{
    backend: AgentBackendId;
    cwd: string;
    model: string | null;
  } | null>(null);
  /** Recent folders + per-backend model lists for the card. Fetched once, and
   *  only for a chat that is actually showing the offer. */
  const [launchOptions, setLaunchOptions] = useState<AgentLaunchOptions | null>(null);
  const launchFetched = useRef(false);
  // PREFETCH on the strip, not on the card. Fetching when the card opens meant
  // its first frame had no folder chips and a models list of just "Default",
  // which then popped in — the exact layout jump the single-request design
  // exists to avoid. Worse, `launchFetched` was set before the request
  // resolved, so ONE failed fetch left the card Default-only for the rest of
  // the mount and the user again "can't change the model". Now it is fetched
  // as soon as the offer is on screen, and a failure is retryable.
  const wantLaunchOptions = staged !== null || !hasMessages;
  useEffect(() => {
    if (!wantLaunchOptions || launchFetched.current) return;
    let cancelled = false;
    void api
      .agentLaunchOptions()
      .then((o) => {
        if (cancelled) return;
        // Only a SUCCESS closes the door. A rejected fetch leaves the flag
        // clear so opening the card can try again.
        launchFetched.current = true;
        setLaunchOptions(o);
      })
      .catch(() => {
        // Suggestions are a convenience: with none, the card still shows the
        // pane's own folder and "Default", which is a complete answer. Do not
        // block the card on this, and do not shout about it.
      });
    return () => {
      cancelled = true;
    };
  }, [wantLaunchOptions]);
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
  /**
   * The REFUSAL, kept apart from `pickError`.
   *
   * A 409 flips `hasMessages`, and that immediately re-routes the empty state
   * to the "Loading conversation…" spinner — which used to be rendered by a
   * branch that knows nothing about `pickError`, so the server's explanation
   * ("this chat already has messages — open a new tab instead") was set and
   * then thrown away in the same tick. The user saw the strip vanish and a
   * spinner appear, which reads as the app agreeing with them. This one is
   * sticky and is rendered by BOTH branches.
   */
  const [convertRefusal, setConvertRefusal] = useState<string | null>(null);
  /** A conversion that LANDED, held briefly so the change is announced rather
   *  than merely being true. Cleared on a timer — see CONVERT_CONFIRM_MS. */
  const [converted, setConverted] = useState<ConversionReceipt | null>(null);
  const confirmTimer = useRef<number | undefined>(undefined);
  useEffect(
    () => () => {
      window.clearTimeout(confirmTimer.current);
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
      setConvertRefusal(null);
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
        return true;
      } catch (e) {
        window.clearTimeout(pickStall.current);
        setPickBusy(null);
        const { message, refused, hasMessages: nowHasMessages } = conversionFailure(e, fallback);
        if (refused) {
          // The refusal owns the message — putting it in `pickError` too
          // printed the same sentence twice, once in the sticky banner and
          // once under the strip.
          setConvertRefusal(message);
          setStaged(null);
        } else {
          setPickError(message);
        }
        // Only `has_messages` corrects our render: the server is telling us the
        // chat we drew as empty is not. A `mid_turn` refusal leaves the empty
        // state alone — the offer is legitimately available again in a moment.
        if (nowHasMessages) setHasMessages(true);
        return false;
      }
    },
    [],
  );
  /**
   * Commit the staged harness: convert, then SAY SO.
   *
   * The identity change (logo, name, folder line in the greeting) lands on its
   * own when the new runner hellos — but that is a few seconds away and looks
   * like nothing happening. The confirmation is immediate and names exactly
   * what was started, including the folder and model the user just chose, so a
   * mis-tap is legible instead of silent.
   */
  const startStaged = useCallback(async () => {
    if (!staged) return;
    const { backend, cwd, model } = staged;
    const dir = cwd.trim();
    // What the server RESOLVED, which is not always what we asked for: it snaps
    // the folder to the project root. Echoing our own input here put two
    // different folders on screen for one conversion — the receipt naming the
    // subdirectory the user typed, the greeting naming the root that actually
    // started.
    let resolved: { cwd: string | null; model: string | null } | null = null;
    const ok = await runConversion(backend, 'could not start the agent', async () => {
      // 'agent' = Agent mode, NO house overlay. Choosing a harness by name means you
      // want that harness as it ships — capabilities injection only.
      resolved = await api.setAgentBackend(paneId, backend, 'agent', {
        ...(dir ? { cwd: dir } : {}),
        ...(model ? { model } : {}),
      });
    });
    if (!ok) return;
    setStaged(null);
    setConverted({
      backend,
      cwd: (resolved as { cwd: string | null } | null)?.cwd ?? dir,
      model: (resolved as { model: string | null } | null)?.model ?? model,
    });
    window.clearTimeout(confirmTimer.current);
    confirmTimer.current = window.setTimeout(() => setConverted(null), CONVERT_CONFIRM_MS);
  }, [staged, paneId, runConversion]);
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
            {/* The refusal rides THIS branch too — a 409 is precisely what
                lands the user here, and dropping it was the whole bug. */}
            {convertRefusal ? (
              <output className="chat-convert-refusal">{convertRefusal}</output>
            ) : null}
            <div className="chat-empty-spinner" aria-hidden="true" />
            <p>Loading conversation…</p>
          </div>
        );
      // A live agent runner with no transcript yet is a FRESH session (the
      // transcript file only appears on the first message) — greet, don't
      // spin for 8s and then claim the session "may have ended".
      if (session.writer === 'sdk') {
        return (
          <div className="chat-empty">
            <ChatReadyGreeting
              assistant={session.assistant}
              cwd={folder?.cwd ?? null}
              mode={mode}
              converted={converted}
              refusal={convertRefusal}
            />
            {/* No "send a message below" line: the composer is right there
                with the cursor already in it, so saying so was noise that
                pushed the one thing worth reading — the alternatives — out
                of the eye's path. */}
            {staged ? (
              <HarnessLaunchCard
                backend={staged.backend}
                folders={launchOptions?.folders ?? []}
                models={launchOptions?.models[staged.backend] ?? []}
                paneCwd={folder?.cwd ?? null}
                cwd={staged.cwd}
                setCwd={(v) => setStaged((s) => (s ? { ...s, cwd: v } : s))}
                model={staged.model}
                setModel={(v) => setStaged((s) => (s ? { ...s, model: v } : s))}
                busy={pickBusy !== null}
                error={pickError}
                onCancel={() => {
                  setStaged(null);
                  setPickError(null);
                }}
                onStart={() => void startStaged()}
              />
            ) : queue.length === 0 ? (
              <OpenInsteadStrip
                busy={pickBusy}
                error={pickError}
                onBackend={(b) => setStaged({ backend: b, cwd: folder?.cwd ?? '', model: null })}
                onTerminal={() => void chooseTerminal()}
                onWeb={() => void chooseWeb()}
              />
            ) : (
              // Messages are parked waiting for this agent, so the chat is not
              // empty in any sense the user would recognise and converting
              // would respawn the runner out from under them.
              //
              // The server agrees and REFUSES: `agentPaneHasMessages` returns
              // true on a non-empty queue, first thing. (An earlier comment
              // here claimed the opposite and called this gate "the only thing
              // standing between a stray tap and a lost message" — it is not,
              // it is the second line.) So this branch is presentation only,
              // and rendering `null` was wrong: it removed the harness offer,
              // Terminal, Web view AND any explanation, leaving a silent dead
              // end with no way out.
              <p className="chat-empty-hint">
                {queue.length === 1 ? 'A message is' : `${queue.length} messages are`} waiting for
                this agent to start. Other harnesses are offered once the queue drains.
              </p>
            )}
          </div>
        );
      }
      // NOT an sdk writer. A conversion passes THROUGH here: the convert route
      // kills the old runner, teardown sets writer='none', and the pane sits in
      // this branch until the new runner hellos. So this is exactly the window
      // the receipt exists to cover, and it used to render nothing at all —
      // press "Start Claude", watch the card vanish, and get "Waiting for the
      // first message…" or, past the 8s stale timer, "This session may have
      // ended." That is the original complaint ("it doesn't seem to do
      // anything") reappearing in the gap between the two runners.
      return (
        <div className="chat-empty">
          {converted ? (
            <output className="chat-convert-confirm">
              <AgentBackendLogo backend={converted.backend} size={14} />
              <span>
                Starting {backendLabel(converted.backend)}
                {converted.model ? ` · ${converted.model}` : ''}
                {converted.cwd ? ` · ${converted.cwd}` : ''}
              </span>
            </output>
          ) : null}
          {convertRefusal ? (
            <output className="chat-convert-refusal">{convertRefusal}</output>
          ) : null}
          {stale && !converted ? (
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
              {/* A respawn in flight is not a wait for the user's first
                  message — say which one is happening. */}
              <p>{converted ? 'Starting the session…' : 'Waiting for the first message…'}</p>
            </>
          )}
        </div>
      );
    }
    const { resultFor, consumed } = toolIndex;
    // `anchorId` is set ONLY for rows the scroll memory may anchor to, which
    // means TOP-LEVEL rows. Rows rendered inside an expanded ActionGroup are
    // nested under that group's own anchored box, so stamping them too would
    // break the one property the anchor lookup relies on: that `[data-eid]`
    // in document order have monotonically increasing bottoms (a parent's box
    // encloses its children's). ActionGroup receives this as a one-argument
    // callback, so its nested rows get `undefined` and stay unanchored.
    const renderEvent = (e: ChatEvent, anchorId?: string) => {
      // Exactly one row is ever highlighted, and every other row is handed the
      // same stable `undefined` — which is what keeps `ChatRow`'s memo intact,
      // so a jump re-renders one message instead of re-parsing the markdown of
      // the whole transcript.
      const hl = jumpTargetId && e.id === jumpTargetId ? jumpTerms : undefined;
      if (e.kind === 'tool_use') {
        // A subagent launch reads as an event ("agent X launched"), not a
        // tool call — its own bubble, mirroring the finish notice.
        if (isAgentLaunch(e))
          return (
            <AgentLaunchCard
              key={e.id}
              description={agentLaunchDescription(e)}
              anchorId={anchorId}
            />
          );
        return (
          <ToolRow
            key={e.id}
            use={e}
            result={resultFor.get(e.toolUseId)}
            anchorId={anchorId}
            onOpen={setOpenTool}
          />
        );
      }
      if (e.kind === 'tool_result')
        return <ToolRow key={e.id} result={e} anchorId={anchorId} onOpen={setOpenTool} />;
      return (
        <ChatRow key={e.id} event={e} anchorId={anchorId} onOpenImage={setOpenImage} hl={hl} />
      );
    };

    // A long agentic stretch renders as ONE collapsed block instead of a
    // wall of per-action rows: consecutive tool/thinking events (an
    // "action run") fold behind a count + tool summary, expandable in
    // place. Real prose — user and assistant text — always breaks a run
    // and renders as normal messages. The in-flight run folds too (the
    // count ticks live; the working label names the running tool) —
    // rendering it unfolded made blocks visibly "merge" when the turn
    // closed, which read as a glitch.
    const renderable = voiced.filter((e) => !(e.kind === 'tool_result' && consumed.has(e.id)));
    // Agent launches break runs (like prose) so each renders as its own
    // launch bubble — never buried inside a "5 actions · Agent ×5" fold.
    //
    // In Chat mode, demoted assistant prose is an action too: that is the
    // whole mechanism — deliberation goes where tool calls go, one tap from
    // being read in full, and only a deliberate `reply` breaks the run as a
    // real message.
    const isAction = (e: ChatEvent) =>
      !isAgentLaunch(e) &&
      (e.kind === 'tool_use' ||
        e.kind === 'tool_result' ||
        e.kind === 'thinking' ||
        isPrivateReasoning(e));
    // Fold from TWO actions up — except a run carrying Chat mode's demoted
    // prose, which folds even alone. The rule lives in chat-voice.ts
    // (foldsAsActionRun) next to the demotion that creates those events, so
    // the two can be pinned together by a test.
    const items: React.ReactNode[] = [];
    for (let i = 0; i < renderable.length; ) {
      const e = renderable[i] as ChatEvent;
      if (!isAction(e)) {
        items.push(renderEvent(e, e.id));
        i++;
        continue;
      }
      let j = i;
      while (j < renderable.length && isAction(renderable[j] as ChatEvent)) j++;
      const run = renderable.slice(i, j) as ChatEvent[];
      if (!foldsAsActionRun(run)) {
        // Explicit arrow, not `.map(renderEvent)`: Array#map passes the INDEX
        // as the second argument, which is now the anchor id.
        items.push(...run.map((ev) => renderEvent(ev, ev.id)));
      } else {
        // ONE id for the React key and the scroll anchor, and it is the run's
        // FIRST event. These used to differ: the key flipped between the
        // first and last event depending on whether the run was still
        // trailing, which remounted the group (and, with the expansion keyed
        // the same way, silently collapsed it) exactly when the turn's reply
        // landed. The head is stable across a run growing at its tail and
        // across that trailing→closed transition; only a prepended batch
        // whose own tail is contiguous actions can move it, which is rare and
        // degrades to the ordinary "anchor not loaded" path.
        //
        // The EXPANSION is not keyed off it at all — see actionRunExpanded.
        const anchorId = (run[0] as ChatEvent).id;
        // A `thinking` block is an ACTION, so it folds into a run — and the
        // archive indexes thinking, so a search can legitimately land inside a
        // collapsed one. Force the run open in that case: a highlight nobody
        // can see is the same as no highlight, and this is the one place the
        // fold has to yield to something the user explicitly asked for. Not
        // written into `expandedGroups`, so the fold snaps back the moment the
        // highlight is dismissed rather than leaving the chat rearranged.
        const holdsHit = !!jumpTargetId && run.some((ev) => ev.id === jumpTargetId);
        items.push(
          <ActionGroup
            key={`group-${anchorId}`}
            events={run}
            expanded={actionRunExpanded(run, expandedGroups) || holdsHit}
            anchorId={anchorId}
            onToggle={() => {
              // A fold toggle is a height change the READER caused, in the
              // middle of the document — so it is an INPUT, not something to be
              // detected afterwards. The intent becomes "hold this header where
              // it is right now", measured before the commit that changes its
              // height, and the commit subscription satisfies it.
              onFoldToggled(anchorId);
              setExpandedGroups((prev) => toggleActionRun(run, prev));
            }}
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
    voiced,
    stale,
    hasMessages,
    optimisticUser,
    sending,
    loadingOlder,
    expandedGroups,
    jumpTargetId,
    jumpTerms,
    toolIndex,
    pickBusy,
    pickError,
    staged,
    launchOptions,
    converted,
    convertRefusal,
    startStaged,
    folder,
    queue,
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
          {/* Same two-step as the empty-chat strip: an agent choice opens the
              launch card (folder + model) rather than starting blind. This
              legacy screen only exists for panes created before the chooser was
              retired, but it must not be the one place with the old behavior. */}
          {staged ? (
            <HarnessLaunchCard
              backend={staged.backend}
              folders={launchOptions?.folders ?? []}
              models={launchOptions?.models[staged.backend] ?? []}
              paneCwd={folder?.cwd ?? null}
              cwd={staged.cwd}
              setCwd={(v) => setStaged((s) => (s ? { ...s, cwd: v } : s))}
              model={staged.model}
              setModel={(v) => setStaged((s) => (s ? { ...s, model: v } : s))}
              busy={pickBusy !== null}
              error={pickError}
              onCancel={() => {
                setStaged(null);
                setPickError(null);
              }}
              onStart={() => void startStaged()}
            />
          ) : (
            <div className="chat-harness-choices">
              {AGENT_BACKENDS.map((b) => (
                <button
                  key={b.id}
                  type="button"
                  className="chat-harness-btn"
                  disabled={pickBusy !== null}
                  aria-busy={pickBusy === b.id}
                  onClick={() => setStaged({ backend: b.id, cwd: folder?.cwd ?? '', model: null })}
                >
                  <AgentBackendLogo backend={b.id} size={22} />
                  <span>{b.label}</span>
                  {pickBusy === b.id ? (
                    <span className="chat-harness-spin" aria-hidden="true" />
                  ) : null}
                </button>
              ))}
            </div>
          )}
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
          {/* A 409 sets convertRefusal, not pickError, and also clears the
              staged card. Without this the refusal was SWALLOWED here: tap a
              harness, press Start, the card closes and the screen is otherwise
              unchanged — which is the original "it doesn't seem to do anything"
              bug, re-created in the one screen whose own comment says it must
              not be the place with the old behaviour. */}
          {convertRefusal ? <p className="chat-harness-error">{convertRefusal}</p> : null}
        </div>
      </div>
    );
  }

  return (
    <div className="chat-pane" ref={paneRef}>
      {/* We were asked to show WHERE the term is, and could not — so say so.
          Silently landing on an unchanged chat is the one outcome that reads as
          a broken search. Floats over the transcript rather than sitting in the
          flow: inserting a strip would reflow the log and move the very scroll
          position the jump is trying to hold. */}
      {jump && jumpMissed && !jumpTargetId ? (
        <output className="chat-search-missed">
          <span className="chat-search-missed-text" dir="auto">
            {hasMoreOlder
              ? `“${jump.query}” is further back than the history loaded here.`
              : `“${jump.query}” isn’t in this conversation’s messages.`}
          </span>
          {hasMoreOlder ? (
            <button
              type="button"
              className="chat-search-missed-more"
              onClick={() => {
                // "Keep looking" is a fresh request, so it gets a fresh budget —
                // re-claiming the same jump resets the controller's page count.
                if (jumpTargetId) scroll.current?.dispatch({ t: 'search-jump', id: jumpTargetId });
                else if (jump) scroll.current?.dispatch({ t: 'search-jump', id: jump.query });
                setJumpMissed(false);
              }}
            >
              Keep looking
            </button>
          ) : null}
          <button
            type="button"
            className="chat-search-missed-close"
            aria-label="Dismiss"
            onClick={clearJump}
          >
            ×
          </button>
        </output>
      ) : null}
      {/* tabIndex=0 because a keydown listener on an element only fires when
          focus is inside it, and this was a plain div: focus sat on <body>, the
          listener never saw a key, and PageDown moved the log 0px. The chat had
          no keyboard scrolling at all. A scrollable region is supposed to be
          focusable for exactly this reason; `role=log` names what it is for a
          screen reader now that it is in the tab order. */}
      <div
        className="chat-scroll"
        ref={scrollRef}
        onScroll={onScroll}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a SCROLLABLE region must be focusable or it cannot be scrolled by keyboard at all — the inverse of this rule's concern, and what axe's "scrollable-region-focusable" requires.
        tabIndex={0}
        role="log"
        aria-label="Conversation"
      >
        <div className="chat-list">
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
              {/* In Chat mode the token stream IS the private scratchpad — the
                  `reply` tool's argument streams as input_json, which the
                  runner does not forward — so showing it would put reasoning on
                  screen live and then take it back at turn end. The working
                  indicator is what a Chat-mode turn shows instead, and it names
                  the running tool so a silent pane never reads as stuck. */}
              {streamingText && !voiceOn ? (
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
          {/* ── The composer's reserve, as a SIBLING ──────────────────────────
              The floating composer overlaps the scroller, so the log has to
              reserve its exact measured height or the last message hides behind
              it. That reserve used to be `.chat-list`'s padding-bottom, and
              `.chat-list` is an ancestor of every anchor node in the chat — so
              every time the composer's height moved, the computed `padding`
              change SUPPRESSED the browser's scroll anchoring for that whole
              layout pass. Measured in headless Chromium, unpinned reader,
              480px of growth above them: 0px drift normally, the full 480px the
              moment `.chat-list`'s padding moved in the same pass. And nothing
              else compensates — the hand-rolled compensations were deliberately
              narrowed to "older prepend" and "search fold" once the engine took
              the general case.
              Moving it to the SCROLLER does not help (measured: 480px drift
              there too — the scrolling box is in the anchor node's chain, and
              the spec's suppression triggers run up to and including it). A
              sibling is: its height is nobody's ancestor. Measured 0px drift
              with the reserve growing 96 -> 140 in the same pass as the growth.
              `margin-top` cancels `.chat-list`'s row gap so the resting
              clearance is identical to the padding it replaces (measured: 100px
              either way). No `data-eid`, so it is invisible to the anchor scan
              exactly like the rest of the live furniture below the last row. */}
          <div
            className="chat-composer-reserve"
            aria-hidden="true"
            // …plus the keyboard, on mobile: the scroller's clientHeight does
            // not change when iOS raises one, so without this the last turns
            // sit behind it. `--chat-keyboard-inset` is 0px everywhere else.
            style={
              composerH
                ? { height: `calc(${composerH + 14}px + var(--chat-keyboard-inset, 0px))` }
                : undefined
            }
          />
        </div>
      </div>
      {showScrollDown ? (
        <button
          type="button"
          className="chat-scroll-down"
          // Rides above the composer, so it rides above the keyboard too.
          style={
            composerH
              ? { bottom: `calc(${composerH + 12}px + var(--chat-keyboard-inset, 0px))` }
              : undefined
          }
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
          {voiceOn ? (
            <VoiceBar
              state={voice.state}
              detail={voice.detail}
              status={voice.status}
              supported={voice.supported}
              minutesLeft={voice.minutesLeft}
              elapsedMs={voice.elapsedMs}
              onStart={voice.start}
              onStop={() => voice.stop('user')}
              muted={voice.muted}
              onEnableSound={() => void voice.enableSound()}
              onDismiss={() => voice.stop('user')}
            />
          ) : null}
          <SessionBar
            paneId={paneId}
            folder={folder}
            status={agentStatus}
            {...(session?.assistant ? { assistant: session.assistant } : {})}
            liveLabel={liveLabel}
            agents={rosterAgents}
            mode={mode}
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
              {/* Chat mode only — Agent mode is raw, and `voiceOn` is the same
                  predicate that governs Chat mode's written voice. */}
              {voiceOn ? (
                <VoiceControl
                  state={voice.state}
                  detail={voice.detail}
                  status={voice.status}
                  supported={voice.supported}
                  minutesLeft={voice.minutesLeft}
                  elapsedMs={voice.elapsedMs}
                  onStart={voice.start}
                  onStop={() => voice.stop('user')}
                />
              ) : null}
              <textarea
                ref={inputRef}
                className="chat-input"
                value={input}
                onChange={(e) => {
                  setInput(e.target.value);
                  // Editing retires a search highlight. Typing into the
                  // composer means you have stopped reading the result you were
                  // brought here for and started using the chat.
                  clearJump();
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
                    : // Chat is addressed as Chat. Naming the harness here was
                      // the same slip as the greeting: "Message Claude…" under a
                      // pane that calls itself Chat, in the one mode where the
                      // harness is not a thing the user chose.
                      `Message ${mode === 'chat' ? 'Chat' : assistantLabel(session?.assistant)}…`
                }
                rows={1}
              />
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
  anchorId,
  onToggle,
  renderEvent,
}: {
  events: ChatEvent[];
  expanded: boolean;
  /** See ANCHOR_ATTR — the scroll memory's handle on this row. */
  anchorId?: string | undefined;
  onToggle: () => void;
  renderEvent: (e: ChatEvent) => React.ReactNode;
}) {
  const counts = new Map<string, number>();
  let failed = 0;
  for (const e of events) {
    // Orphan tool_results (their tool_use never reached this pane) count as
    // actions too — a run of only results must not label itself '0 actions'.
    const name =
      e.kind === 'tool_use'
        ? e.name
        : e.kind === 'thinking'
          ? 'thinking'
          : // Chat mode's demoted prose. Named in the header so the fold
            // advertises that reasoning is in there — "12 actions · Bash ×6"
            // with nothing else said would be the disappearance this is
            // deliberately not.
            e.kind === 'assistant'
            ? 'notes'
            : 'result';
    counts.set(name, (counts.get(name) ?? 0) + 1);
    if (e.kind === 'tool_result' && !e.ok) failed++;
  }
  // Paired results ride their tool_use row, so only orphans reach this run —
  // but a tool_use + its paired result never co-occur here (consumed results
  // are filtered before grouping), making every event one visible action.
  const actions = events.length;
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  const summary = top.map(([name, n]) => (n > 1 ? `${name} ×${n}` : name)).join(' · ');
  // A run of ONLY demoted prose is not "1 action" — nothing was done. Counting
  // reasoning as an action is what made Chat mode read backwards: the header
  // announced a hidden tool call, so the fold looked like the place the WORK
  // went, while the visible reply looked like deliberation. It inverted the
  // whole design in the reader's head while the mechanism underneath was
  // correct. Name it for what it is; the count returns the moment a real
  // action joins the run.
  const notesOnly = events.every((e) => e.kind === 'assistant');
  const countLabel = notesOnly
    ? `${actions === 1 ? 'note' : `${actions} notes`}`
    : `${actions} action${actions === 1 ? '' : 's'}`;
  return (
    <div className="chat-turn chat-turn-assistant" data-eid={anchorId}>
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
          <span className="chat-action-group-count">{countLabel}</span>
          {notesOnly ? null : <span className="chat-action-group-summary">{summary}</span>}
          {failed > 0 ? <span className="chat-action-group-failed">{failed} failed</span> : null}
        </button>
        {expanded ? (
          // Explicit arrow, NOT `.map(renderEvent)`: Array#map passes the index
          // as the second argument, which `renderEvent` reads as the anchor id —
          // so every row inside an expanded group would render `data-eid="0"`,
          // `data-eid="1"`, … Harmless today (the anchor scan only walks
          // .chat-list's direct children) but it falsifies the invariant the
          // whole scheme rests on, and it is the exact trap the sibling call
          // site is already guarded against.
          <div className="chat-action-group-body">{events.map((ev) => renderEvent(ev))}</div>
        ) : null}
      </div>
    </div>
  );
}

/** Memoized: the chat body rebuilds its element list on every subagent
 *  progress frame (~2/s during turns); stable props must skip re-rendering
 *  (and re-parsing Markdown for) the entire transcript. */
const ChatRow = memo(function ChatRow({
  event,
  anchorId,
  onOpenImage,
  hl,
}: {
  event: ChatEvent;
  /** See ANCHOR_ATTR — the scroll memory's handle on this row. */
  anchorId?: string | undefined;
  onOpenImage?: OpenMedia | undefined;
  /**
   * Search terms to light up, passed ONLY to the one row a search jump landed
   * on. Every other row gets `undefined`, so `memo` holds and a jump re-renders
   * (and re-parses the markdown of) exactly one message rather than the whole
   * transcript. The array is memoised per query upstream, so a stable
   * `undefined`/reference is what the comparison sees.
   */
  hl?: readonly string[] | undefined;
}) {
  // The row itself is marked, not just the words in it. "Which message" is
  // half the answer to "where is the term", and it must survive a hit that is
  // scrolled just off the top of the viewport, a colour-blind reader, and a
  // forced-colours mode that flattens the marks. See .chat-turn[data-search-hit].
  const found = hl && hl.length > 0 ? 'true' : undefined;
  switch (event.kind) {
    case 'user':
      return (
        <div className="chat-turn chat-turn-user" data-eid={anchorId} data-search-hit={found}>
          <div className="chat-bubble" dir="auto">
            <UserText text={event.text} onOpenImage={onOpenImage} hl={hl} />
          </div>
        </div>
      );
    case 'assistant':
      // Chat mode's private scratchpad: the same muted treatment extended
      // thinking gets, folded inside an action run. The text is rendered in
      // full — collapse, never drop.
      if (event.voice === 'private')
        return (
          <div
            className="chat-turn chat-turn-assistant"
            data-eid={anchorId}
            data-search-hit={found}
          >
            <div className="chat-thinking" dir="auto">
              <HighlightedText text={event.text} hl={hl} />
            </div>
          </div>
        );
      return (
        <div
          className="chat-turn chat-turn-assistant"
          data-eid={anchorId}
          data-search-hit={found}
          // The guard spoke, not the agent. Marked in the DOM rather than
          // dressed up in prose: "the harness had to say this for it" is worth
          // being able to see (and to grep for in a screenshot-driven bug
          // report) without putting an apology in the conversation.
          data-voice={event.voice === 'fallback' ? 'fallback' : undefined}
        >
          <div className="chat-msg">
            <AssistantText text={event.text} onOpenImage={onOpenImage} hl={hl} />
          </div>
        </div>
      );
    case 'thinking':
      return (
        <div className="chat-turn chat-turn-assistant" data-eid={anchorId} data-search-hit={found}>
          <div className="chat-thinking" dir="auto">
            <HighlightedText text={event.text} hl={hl} />
          </div>
        </div>
      );
    case 'notice':
      return <NoticeCard event={event} anchorId={anchorId} hl={hl} />;
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
  hl,
}: {
  text: string;
  onOpenImage?: OpenMedia | undefined;
  hl?: readonly string[] | undefined;
}) {
  const parts = splitMessageAttachments(text);
  if (parts.length === 1 && parts[0]?.kind === 'text')
    return <HighlightedText text={text} hl={hl} />;
  return (
    <>
      {renderMessageParts(
        parts,
        (t, key) => (
          <span key={key}>
            <HighlightedText text={t} hl={hl} />
          </span>
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
  hl,
}: {
  text: string;
  onOpenImage?: OpenMedia | undefined;
  hl?: readonly string[] | undefined;
}) {
  const parts = splitMessageAttachments(text);
  if (parts.length === 1 && parts[0]?.kind === 'text') return <Markdown text={text} hl={hl} />;
  return (
    <>
      {renderMessageParts(
        parts,
        (t, key) => (
          <Markdown key={key} text={t} hl={hl} />
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
  interrupted: '⏹',
};

/** Time-of-day for a cron chip, in the VIEWER's zone. The cron's own zone is
 *  the scheduling truth, but this line answers "when did this land for me". */
function fireTime(ts: number | null): string {
  if (ts === null) return '';
  return new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** Harness control message (background-task update / session reminder), or a
 *  muxpad cron fire — "⏱ pr-sweep · 09:00" ahead of the prompt it delivered. */
function NoticeCard({
  event,
  anchorId,
  hl,
}: {
  event: NoticeEvent;
  anchorId?: string | undefined;
  hl?: readonly string[] | undefined;
}) {
  const at = event.variant === 'cron' ? fireTime(event.ts) : '';
  const detail = event.detail ?? (at || undefined);
  return (
    <div
      className="chat-turn chat-turn-notice"
      data-eid={anchorId}
      data-search-hit={hl && hl.length > 0 ? 'true' : undefined}
    >
      <div className={`chat-sysnote chat-sysnote-${event.variant}`} title={event.text}>
        <span className="chat-sysnote-icon" aria-hidden="true">
          {NOTICE_ICON[event.variant]}
        </span>
        <span className="chat-sysnote-text">
          <HighlightedText text={event.text} hl={hl} />
        </span>
        {detail ? <span className="chat-sysnote-detail">{detail}</span> : null}
      </div>
    </div>
  );
}

/** Subagent LAUNCH bubble — the counterpart to the harness "…finished"
 *  notice, so a dispatch reads as one discrete event instead of folding into
 *  a "5 actions · Agent ×5" run. Same pill family as NoticeCard. */
function AgentLaunchCard({
  description,
  anchorId,
}: { description: string; anchorId?: string | undefined }) {
  const text = `Agent "${description}" launched`;
  return (
    <div className="chat-turn chat-turn-notice" data-eid={anchorId}>
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
  anchorId,
  onOpen,
}: {
  use?: ToolUseEvent | undefined;
  result?: ToolResultEvent | undefined;
  /** See ANCHOR_ATTR — the scroll memory's handle on this row. */
  anchorId?: string | undefined;
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
    <div className="chat-turn chat-turn-assistant" data-eid={anchorId}>
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
              <CopyablePre className="chat-modal-block">{commandText(use)}</CopyablePre>
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
              <CopyablePre className="chat-modal-block">{result.text.slice(0, 20000)}</CopyablePre>
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
