import {
  AGENT_MODE_LABELS,
  ATTACHMENT_ACCEPT,
  ATTACHMENT_EXTENSIONS,
  ATTACHMENT_MIME_BY_EXT,
  type AgentMode,
  type AgentQuestion,
  type AgentSessionStatus,
  type ChatEvent,
  type InboundSender,
  LAUNCH_ACK_RE,
  type NoticeEvent,
  type SubagentProgress,
  type ToolResultEvent,
  type ToolUseEvent,
  attachmentExtForMime,
  imageExtForMime,
  isAgentLaunchTool,
  subagentLabel,
  summarizeToolInput,
} from '@muxpad/shared';
import { useNavigate } from '@tanstack/react-router';
import {
  type ChangeEvent,
  type ComponentProps,
  Fragment,
  type ReactNode,
  createContext,
  isValidElement,
  memo,
  useCallback,
  useContext,
  useEffect,
  useId,
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
import { cachedAllTabs, loadAllTabs, subscribeAllTabs } from '../lib/all-tabs';
import {
  type MessagePart,
  composeOutgoingMessage,
  splitMessageAttachments,
} from '../lib/attachments';
import { browserOpenIntent, injectBrowserMoments } from '../lib/browser-card';
import {
  type DirectedWork,
  addDirected,
  loadDirected,
  removeDirected,
  syncReported,
} from '../lib/chat-directed';
import {
  MAX_MENTION_ROWS,
  MAX_SPAWN_CARDS,
  type MentionChat,
  type MentionPick,
  type MentionRow,
  type MentionRun,
  type MentionSearchState,
  NO_MENTION_SEARCH,
  type SpawnCard,
  type SpawnRoundsByChild,
  applyMention,
  canExpandSpawn,
  detectMentionRun,
  directTo,
  hitsFor,
  interleaveSpawnCards,
  nextMentionRun,
  nextSearchLimit,
  parseDirectMarker,
  parseDirective,
  parseMentions,
  parseReportMarker,
  rankMentions,
  repinPicks,
  resolveSpawnAnchor,
  spawnCardSummary,
  spawnCards,
  spawnHandle,
  spawnLabel,
  spawnState,
  toMentionChats,
  withContentRows,
} from '../lib/chat-mention';
import {
  actionRunExpanded,
  applyChatVoice,
  chatVoiceActive,
  foldsAsActionRun,
  isPrivateReasoning,
  lastTurnStartId,
  toggleActionRun,
} from '../lib/chat-voice';
import { NO_SENDERS, loadInboundSenders, matchInboundSenders } from '../lib/inbound-senders';
import { showFolderChip } from '../lib/nav-row-affordances';
import { type WorkspaceTabs, paneIndex } from '../lib/nav-search';
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
import { documentVisible } from '../lib/seen-ack';
import { NO_ROUNDS, loadSpawnRounds } from '../lib/spawn-rounds';
import { type SpawnWork, fetchSpawnWork } from '../lib/spawn-work';
import type { AgentLink } from '../lib/voice/session';
import { useVoice } from '../lib/voice/use-voice';
import { AgentBackendLogo, backendFromAssistant } from './AgentLogos';
import { BrowserCard } from './BrowserCard';
import { useBrowsers } from './BrowserCards';
import { ChatDraft, type ChatDraftHandle } from './ChatDraft';
import { HighlightedText, Markdown } from './ChatMarkdown';
import { ChatMentionCard, ChatMentionPicker, ChatMentionPill } from './ChatMentionPicker';
import {
  type AgentStatus,
  ChatNoRunner,
  ChatReadyGreeting,
  type ConversionReceipt,
  FolderChoice,
  HarnessLaunchCard,
  OpenInsteadStrip,
  type RosterAgent,
  SessionBar,
  SvgFolder,
  SvgModeGlyph,
  assistantLabel,
} from './ChatStart';
import {
  ActionGroup,
  AgentLaunchCard,
  ChatMentionContext,
  ChatRow,
  ImageModal,
  type MediaItem,
  type OpenMedia,
  type PendingQuestion,
  QuestionCard,
  RosterSpinner,
  SpawnWorkBody,
  type ToolDetail,
  ToolModal,
  ToolRow,
  UserText,
} from './ChatTranscript';
import { CopyablePre } from './CopyablePre';
import { FromAgentMessage } from './FromAgentMessage';
import { SvgAgentGlyph, SvgGlobe, SvgTerminalGlyph } from './PaneWebSwitch';
import { VoiceBar, VoiceControl } from './VoiceControl';

/** Open a media item in the lightbox (image or video). */
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
import { trackKeyboardInset } from '../lib/keyboard-inset';
import {
  childIsRunning,
  liveStatusLabel,
  runningChildren,
  sessionModelLabel,
  workingRowLabel,
} from '../lib/live-status';
import { isMobileLayout } from '../lib/mobile-layout';
import { useDismissable } from '../lib/use-dismissable';
import './ChatPane.css';

/** Stable empties for the report-expansion state, so a pane that never opens one
 *  contributes no new identity to the transcript memo on every render. */
const EMPTY_EXPANDED: ReadonlySet<string> = new Set();
const EMPTY_WORK: ReadonlyMap<string, SpawnWork | null> = new Map();

// The markdown layer — MD_COMPONENTS, the per-block base direction, Markdown
// and HighlightedText — now lives in ChatMarkdown.tsx. It had to move rather
// than merely wanting to: the transcript rows render markdown too, so keeping
// it here would mean the rows importing from the file that imports the rows.

/** Camera glyph for the photo/attach button (matches the TUI composer). */
function SvgAttach() {
  return (
    /* 22, matched to the mic beside it — see VoiceControl's SvgMic. The two sit
       in identical 36px circles, so any difference between the GLYPHS is the
       only thing the eye has to go on, and it read as two mismatched icons
       rattling around in their boxes. */
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true" fill="none">
      {/* A paperclip, not a camera. The button takes any file muxpad can
          render — pdf, csv, json, zip, the lot — and a camera glyph promised
          photos only, which is also what the input's accept was enforcing. */}
      <path
        d="M17.5 9.5 10.9 16.1a3 3 0 0 1-4.24-4.24l7.07-7.07a2 2 0 0 1 2.83 2.83l-7.08 7.07a1 1 0 0 1-1.41-1.41l6.36-6.37"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
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

// The pre-session screens — folder and harness pickers, the no-runner and
// ready-to-start states — and the session bar now live in ChatStart.tsx.
// Each takes props and reports through callbacks, holding no socket and no
// turn state, which is why several were already exported and tested alone.

interface SessionMeta {
  current_sid: string | null;
  writer: string;
  view_mode: string;
  assistant: string;
}

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
      /**
       * Why this pane has NO agent, when something refused to make one
       * ("posix_spawnp failed", "ptyd disconnected"). Absent in every healthy
       * case, which is the majority of frames.
       *
       * It is the difference between the two sentences the empty chat can say.
       * "This chat has no agent yet" describes a steady state and is true of a
       * pane nobody has started; printing it over a create whose spawn failed
       * ten seconds ago was the user's top complaint, because it asked them to
       * press Start agent for a chat they had just made and said nothing about
       * what had gone wrong. When this is set the chat says the reason instead.
       */
      provisionError?: string;
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
 * Lives in `lib/keyboard-inset.ts` with the tracker that keeps it true — see
 * that file for why the composer needs it, why `MobileInputBar`'s "skip the JS
 * in a PWA" shortcut does not transfer, and how a stale read used to latch.
 */
export { keyboardInset as chatKeyboardInset } from '../lib/keyboard-inset';

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

/**
 * How long "Start agent" spins before handing the button back.
 *
 * The respawn route answers as soon as ptyd has the pty; the RUNNER then has
 * to boot node, connect and hello, which is the part worth waiting through.
 * Sized against the server's own patience (RESPAWN_STARTUP_GRACE_MS, 30s)
 * rather than a feel: giving up sooner than the server does would offer a
 * retry for a boot that is still perfectly on track.
 */
const AGENT_START_STALL_MS = 35_000;

/** '.ext' when the filename carries an extension the upload route accepts —
 *  the picker's fallback for providers that report an empty MIME type (HEIC
 *  pickers, some Android providers, and iOS's Files for several document
 *  types). Mirrors the server's rule, which keys off the extension. */
function attachmentExtFromName(name: string): string | null {
  const m = /\.[a-z0-9]+$/i.exec(name);
  const ext = m ? m[0].toLowerCase() : '';
  return ext && ext in ATTACHMENT_MIME_BY_EXT ? ext : null;
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
    scroll.current = new ChatScrollController(domScrollSurface(() => scrollRef.current));
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
  /**
   * The observer, and the rows it is watching.
   *
   * A ref rather than a local so the commit subscription can re-offer newly
   * rendered rows without tearing the observer down — see the effect below for
   * why the rows and not just the container.
   */
  const rowWatcher = useRef<ResizeObserver | null>(null);
  const watchRows = useCallback(() => {
    const ro = rowWatcher.current;
    const el = scrollRef.current;
    if (!ro || !el) return;
    ro.observe(el);
    const list = el.querySelector('.chat-list');
    if (!list) return;
    // BORDER-BOX on the list: the composer's clearance is a sibling row at the
    // end of it, and a content-box observer would not see that resize.
    ro.observe(list, { box: 'border-box' });
    for (const row of list.children) {
      if (row instanceof HTMLElement && row.hasAttribute(ANCHOR_ATTR)) ro.observe(row);
    }
  }, []);

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
  // The composer is a `ChatDraft` — a contenteditable that draws picked mentions
  // as chips while you type (see ChatDraft.tsx and lib/chat-draft.ts). It is not
  // a form control, so `value`/`selectionStart`/`setSelectionRange` come through
  // this handle instead. The draft ITSELF is unchanged: still the `input` string
  // below, still what every offset in the `@` grammar counts into.
  const inputRef = useRef<ChatDraftHandle>(null);
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

  /**
   * WHICH CHATS THE USER ACTUALLY PICKED, alongside the draft that shows them.
   *
   * A mention's token is the chat's NAME, which is the right thing for the user
   * to read and the wrong thing to resolve a recipient from: names are neither
   * unique nor stable, so re-reading one at send time is a guess, and it guessed
   * wrong in two reproducible ways (see MentionPick in lib/chat-mention). The
   * identity is therefore kept beside the text, by id, anchored to its `@`.
   *
   * Persisted next to the draft rather than inside it: a reload must not turn an
   * explicit choice back into a name to be re-guessed, and a separate key means a
   * draft written before this existed still restores as a draft.
   */
  const picksKey = `muxpad.chatPicks.${paneId}`;
  const [picks, setPicks] = useState<MentionPick[]>(() => {
    try {
      const raw = localStorage.getItem(picksKey);
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (p): p is MentionPick =>
          !!p &&
          typeof p === 'object' &&
          typeof (p as MentionPick).tabId === 'string' &&
          typeof (p as MentionPick).name === 'string' &&
          typeof (p as MentionPick).start === 'number',
      );
    } catch {
      return [];
    }
  });
  /**
   * The picks as they describe the draft RIGHT NOW.
   *
   * Derived rather than stored, because the draft is edited freely after a pick:
   * every offset shifts when text is typed in front of a mention, and a pick
   * whose token was deleted is void. Deriving it means the two can never
   * disagree — there is no effect to miss an edit, and clearing the composer
   * clears the picks by construction.
   */
  const livePicks = useMemo(() => repinPicks(input, picks), [input, picks]);
  useEffect(() => {
    try {
      if (livePicks.length) localStorage.setItem(picksKey, JSON.stringify(livePicks));
      else localStorage.removeItem(picksKey);
    } catch {
      // same contract as the draft next door: persistence is a nicety
    }
  }, [livePicks, picksKey]);

  // ── The @ picker ──────────────────────────────────────────────────────────
  // Typing `@` opens a picker over EVERY chat, live and done. Three things in
  // one gesture: a reference (a chip in the message), a direction (`@Name text`
  // sends the work to that chat and it reports back as a card), and — because
  // the query matches names AND what was said in them — a search. See
  // lib/chat-mention for the grammar; this is only the surface.
  const navigate = useNavigate();
  const mentionListId = useId();
  /**
   * Every chat, as the picker, the inline chips and the cards all need them.
   *
   * Seeded from whatever `/api/tabs/all` has already answered this session, so
   * the first `@` has something to show before its own fetch lands — and then
   * SUBSCRIBED, which is the part that was missing. A pane used to take one
   * snapshot and hold it for as long as it was mounted, so a referenced chat
   * that was renamed, archived, retired or revived went on being drawn in its
   * old state, in a conversation sitting right beside the sidebar row that had
   * already updated. The store follows the server's own tab pushes (lib/all-tabs)
   * so there is one answer to "which chats are there" and it is current.
   */
  const [corpusGroups, setCorpusGroups] = useState<WorkspaceTabs[]>(() => cachedAllTabs() ?? []);
  useEffect(() => subscribeAllTabs(setCorpusGroups), []);
  const corpus = useMemo(() => toMentionChats(corpusGroups), [corpusGroups]);
  const [mentionRun, setMentionRun] = useState<MentionRun | null>(null);
  const [mentionCursor, setMentionCursor] = useState(0);
  // Escape dismisses the picker for THIS run without clearing the draft. Keyed
  // by the run's `@` offset: a NEW `@` is a new invitation, but continuing to
  // type into a run you dismissed must not bring it back.
  const [mentionDismissed, setMentionDismissed] = useState<number | null>(null);
  // The archive tier's hits, CARRYING THE QUERY THEY ANSWER. Kept together
  // deliberately: hits held on their own stayed selectable under a query they
  // had nothing to do with (see hitsFor), and the ticket scheme cannot help —
  // it guards a late response, not stale state.
  const [mentionSearch, setMentionSearch] = useState<MentionSearchState>(NO_MENTION_SEARCH);
  const [mentionSearching, setMentionSearching] = useState(false);
  // Latches false on the first 404: /api/search exists only when the archive
  // does, so its absence must cost one request to learn, not one per keystroke.
  const [archiveAvailable, setArchiveAvailable] = useState(true);
  const mentionTicket = useRef(0);
  /** `<query>\0<limit>` of the request already sent, so an escalation fires once. */
  const mentionAsked = useRef<string | null>(null);

  const ensureCorpus = useCallback(() => {
    void loadAllTabs().then((groups) => {
      // An empty answer is a real answer (no workspaces) but must not replace a
      // usable fallback that came from a failed request — see loadAllTabs. A
      // successful load publishes to every subscriber, so there is nothing to
      // set here; this only covers the fresh-cache case, where loadAllTabs
      // answers from the cache without notifying anyone.
      // A trailing refresh or push can publish before this promise callback.
      // Read the held corpus now, never roll it back to the request's answer.
      const current = cachedAllTabs();
      if (current) setCorpusGroups(current);
      else if (groups.length > 0) setCorpusGroups(groups);
    });
  }, []);

  /**
   * WHEN THIS PANE NEEDS THE CORPUS, which is not only when composing.
   *
   * It used to be loaded on exactly two triggers: a draft containing `@`, and
   * opening the picker. Neither fires on the case that matters most — reload
   * straight into a conversation that already HAS a report in it, with an empty
   * composer. The corpus was then empty, so the report card rendered a fallback
   * name and a button whose click did nothing at all, inline references stayed
   * plain text, and no poll or tab push ever fixed it. The one route back to a
   * worker that has retired out of the sidebar was a dead button, and the
   * remedy — type `@` in the composer and delete it — is not discoverable.
   *
   * So the TRANSCRIPT asks for it too, and so do the directed cards, which now
   * resolve against it rather than only against their own frozen snapshot. The
   * `.some` short-circuits, and the latch means a long transcript is scanned
   * until the first hit and then never again.
   */
  const [transcriptNeedsCorpus, setTranscriptNeedsCorpus] = useState(false);
  useEffect(() => {
    if (transcriptNeedsCorpus) return;
    // USER events only, which is where all three live: a mention chip, a report
    // coming back, and a request that arrived here from another chat are all
    // delivered messages (see MentionMessage). Same population `reportedIds`
    // walks, for the same reason.
    const wants = events.some(
      (ev) => ev.kind === 'user' && /@|<muxpad-report|<muxpad-direct/.test(ev.text),
    );
    if (wants) setTranscriptNeedsCorpus(true);
  }, [events, transcriptNeedsCorpus]);
  const draftHasAt = input.includes('@');

  /** Which chat this pane belongs to — excluded from its own picker. */
  const myChat = useMemo(() => paneIndex(corpus).get(paneId), [corpus, paneId]);

  // Browsers muxpad owns. The machinery lives in the hook; the CARDS are placed
  // in the log below, at the moment each thing happened.
  const {
    moments: browserMoments,
    open: openBrowser,
    modal: browserModal,
  } = useBrowsers({ by: paneId, tabId: myChat?.tabId ?? '' });
  /** By tab id — how a stored card finds the chat it was sent to, now. */
  const corpusById = useMemo(() => new Map(corpus.map((c) => [c.tabId, c])), [corpus]);

  /** The query under the caret, trimmed — what everything below keys off. */
  const mentionQuery = mentionRun?.query.trim() ?? '';
  const mentionNameRows = useMemo(
    () =>
      mentionRun
        ? rankMentions(corpus, mentionRun.query, { excludeTabId: myChat?.tabId })
        : ([] as MentionRow[]),
    [corpus, mentionRun, myChat],
  );
  // Only ever the hits for the query being shown. A previous query's results are
  // not "slightly stale", they are a row that sends work to an unrelated chat.
  const mentionHits = useMemo(
    () => hitsFor(mentionSearch, mentionQuery),
    [mentionSearch, mentionQuery],
  );
  const mentionRows = useMemo(
    () =>
      mentionRun
        ? withContentRows(mentionNameRows, mentionHits, corpus, {
            excludeTabId: myChat?.tabId,
            limit: MAX_MENTION_ROWS,
          })
        : ([] as MentionRow[]),
    [mentionNameRows, mentionHits, corpus, mentionRun, myChat],
  );
  // Open only while there is something to choose. A query that matches nothing
  // must give Enter back to the composer rather than swallow it.
  const mentionOpen = mentionRun !== null && mentionRows.length > 0;
  const mentionSafeCursor =
    mentionRows.length === 0 ? 0 : Math.min(mentionCursor, mentionRows.length - 1);

  /**
   * The content tier — what was SAID, from the archive's FTS index.
   *
   * WHAT to ask for is `nextSearchLimit`'s decision, not this effect's: the
   * thresholds, the first page, and the ONE escalation for a page that came back
   * full without filling the picker are all policy, they are all testable
   * without a composer, and they live beside `withContentRows` which throws most
   * of the answer away. This is the transport: debounce, ticket, 404 latch.
   *
   * It settles rather than loops — the escalated page is the server's own cap, so
   * `nextSearchLimit` returns null once it lands whatever the rows do.
   */
  const mentionWantLimit = nextSearchLimit({
    query: mentionQuery,
    state: mentionSearch,
    rows: mentionRows.length,
    want: MAX_MENTION_ROWS,
    archiveAvailable,
  });
  useEffect(() => {
    mentionTicket.current += 1;
    if (mentionWantLimit === null) {
      setMentionSearching(false);
      return;
    }
    // One request per (query, limit). Without this the escalation would re-fire
    // on every render that still shows a short list.
    const asked = `${mentionQuery}\0${mentionWantLimit}`;
    if (mentionAsked.current === asked) return;
    const mine = mentionTicket.current;
    setMentionSearching(true);
    const timer = window.setTimeout(() => {
      mentionAsked.current = asked;
      api
        .searchMessages(mentionQuery, mentionWantLimit)
        .then((res) => {
          if (mine !== mentionTicket.current) return;
          setMentionSearch({ query: mentionQuery, limit: mentionWantLimit, hits: res.hits });
        })
        .catch((err: unknown) => {
          if (mine !== mentionTicket.current) return;
          if ((err as { status?: number } | null)?.status === 404) setArchiveAvailable(false);
          // An empty answer FOR THIS QUERY, so the tier reports "nothing said
          // this" rather than leaving the previous query's rows up.
          setMentionSearch({ query: mentionQuery, limit: mentionWantLimit, hits: [] });
        })
        .finally(() => {
          if (mine === mentionTicket.current) setMentionSearching(false);
        });
    }, 150);
    return () => window.clearTimeout(timer);
  }, [mentionQuery, mentionWantLimit]);

  /**
   * Recompute the run from the draft and the caret.
   *
   * Called on every change AND on caret movement: a mention is defined by where
   * the caret is (editing one mid-sentence must reopen its picker), not by the
   * end of the string.
   */
  /**
   * Held over a pick, because `keyup` reads the DOM.
   *
   * Picking with Enter happens on keydown: the draft is replaced and the picker
   * closes. The matching KEYUP then fires against a textarea that React may not
   * have re-rendered yet, so the run it computes is the OLD one — and the picker
   * you just closed comes straight back. One frame of suppression is enough,
   * because the caret restore runs in the same frame.
   */
  const mentionJustPicked = useRef(false);

  const syncMentionRun = (text: string, caret: number) => {
    if (mentionJustPicked.current) return;
    const live = nextMentionRun(text, caret, corpus, mentionDismissed);
    if (!live) {
      if (mentionRun) setMentionRun(null);
      // The `@` this dismissal belonged to is gone (deleted, or the caret left
      // it), so the latch has nothing left to hold shut.
      if (mentionDismissed !== null && !detectMentionRun(text, caret)) setMentionDismissed(null);
      return;
    }
    if (mentionDismissed !== null) setMentionDismissed(null);
    // Only the first `@` of a session pays for the corpus.
    if (!mentionRun) ensureCorpus();
    if (mentionRun?.start !== live.start || mentionRun?.query !== live.query) {
      setMentionRun(live);
      setMentionCursor(0);
    }
  };

  const closeMentions = (dismiss = false) => {
    if (dismiss && mentionRun) setMentionDismissed(mentionRun.start);
    setMentionRun(null);
    // Nothing to clear: the hits are read through `hitsFor`, which answers the
    // query being shown and no other, so closing the run retires them. The
    // state is left as a one-query cache — reopening the same `@…` shows its
    // rows immediately and still refetches.
    setMentionSearching(false);
  };

  /** Insert the picked chat's token and put the caret back where it belongs. */
  const pickMention = (row: MentionRow) => {
    if (!mentionRun) return;
    const next = applyMention(input, mentionRun, row.chat);
    mentionJustPicked.current = true;
    // WHERE THE CARET GOES, SAID BEFORE THE VALUE LANDS.
    //
    // This used to be a `setCaret` inside a `requestAnimationFrame` after the
    // `setInput` below, and that placed the caret TWICE. A value replaced from
    // outside is not an echo, so the composer's reconcile parks the caret at
    // the END of the draft — and for a mention picked MID-SENTENCE the end is
    // wrong by however much was already written. The rAF then dragged it back.
    //
    // Measured in WebKit against the real composer: picking `@Investing` in
    // `Ask @Inv about cash` left the caret at 25 for a whole frame before it
    // landed at 15, and a character typed inside that frame went to the end —
    // `"Ask @Investing about cashX"` rather than `"Ask @Investing Xabout cash"`
    // — with the caret then jumping away from it. A desktop frame is ~16ms and
    // hides this; on iOS the pick is a TAP, the keyboard is mid-animation, and
    // rAF is throttled through that animation, which is why it reads as
    // "sometimes the caret moves" rather than as something reproducible.
    //
    // Naming the caret first collapses the two placements into one, in the same
    // commit that draws the chip. See `caretFor`.
    inputRef.current?.caretFor(next.text, next.caret);
    setInput(next.text);
    // Remember WHICH chat this was, not just what it is called. Re-anchored
    // against the new draft first, so the stored list stays the size of the
    // mentions actually in the composer rather than growing per pick.
    setPicks((cur) => [...repinPicks(next.text, cur), next.pick]);
    closeMentions();
    // The frame of suppression, and NOTHING ELSE in here any more. Picking with
    // Enter happens on keydown; the matching keyup then fires and would
    // recompute the run from a draft React has already replaced, reopening the
    // picker that was just closed. One frame covers that. The caret no longer
    // waits for it — see `caretFor` above — so a late frame is now harmless
    // rather than a caret landing in the wrong place.
    requestAnimationFrame(() => {
      mentionJustPicked.current = false;
    });
  };

  /** Go to a chat — from a picker row's chip, a pill in text, or a card. */
  const openChat = useCallback(
    (chat: { workspaceSlug: string; tabSlug: string }) => {
      void navigate({
        to: '/w/$wsSlug/t/$tabSlug',
        params: { wsSlug: chat.workspaceSlug, tabSlug: chat.tabSlug },
      });
    },
    [navigate],
  );
  // What every rendered mention in the log resolves through. Memoized so the
  // transcript re-renders when the corpus lands, not on every frame around it.

  // ── Directed work ─────────────────────────────────────────────────────────
  // Cards for requests this chat has sent to another one. Local echo — see
  // lib/chat-directed for why it cannot be a transcript row.
  const [directed, setDirected] = useState<DirectedWork[]>(() => loadDirected(paneId));
  useEffect(() => {
    setDirected(loadDirected(paneId));
  }, [paneId]);

  // ── Work this chat SPAWNED ────────────────────────────────────────────────
  // The children of this chat, from the corpus — no storage of its own, because
  // a child chat IS the record that a spawn happened. The cards are the
  // conversation's copy of what the sidebar already knows: before this, a spawn
  // made by `muxpad agent new` from inside a pane set `spawned_by` and wrote
  // nothing here, so the parent had no record that it had started anything.
  //
  // ─── A CARD IS A TRANSCRIPT ENTRY, not furniture ─────────────────────────
  // These used to be a block pinned at the foot of the log, above the composer.
  // Live-only, because that block had to be: a finished child's card stayed there
  // forever, so six delivered agents sat permanently between the last message and
  // the composer, saying what the status cell's "2 agents" already said.
  //
  // Placed at the SPAWN instead (`interleaveSpawnCards`, by the child's
  // `created_at`) the constraint goes away and the card becomes what the user
  // asked for: "have that UI component in the chat as an indication that u
  // launched". It scrolls away with the conversation, it keeps the finished ones —
  // that is the record of what this chat started — and its mark says which.
  //
  // ONE list still, and that is load-bearing: the roster below is DERIVED from
  // this one, so the cards and the running count cannot answer "what is this
  // chat running" differently, which is exactly how they drifted before.
  //
  // THE FILTER IS `runningChildren`, NOT `!done`. It used to be the latter, and
  // that shipped a bar reading "4 agents" over one working child, two idle ones
  // and a DEAD one. `done` is retirement — whether the chat has left the live
  // list — and a worker between turns, or one whose runner gave up, is unretired
  // and not running. The pane's `status` is the field that means "is this
  // working", it is what the sidebar spins on, and it is now what this counts.
  // See live-status.ts for the measured scene and ChatPane.liveset.test.tsx for
  // the test that holds all three surfaces to one answer.
  //
  // ─── ROUNDS ────────────────────────────────────────────────────────────────
  // A worker is not one job: `muxpad agent send` revives a retired one and hands
  // it the next. Both cards were anchored to `created_at` and `retired_at`, one
  // pair per TAB, so every round after the first left nothing in the log —
  // measured at five handovers against one pair. `spawnCards` draws a pair per
  // ROUND when it has them, and falls back to the tab pair when it does not
  // (the corpus arrives first, and an older server sends none).
  const [spawnRounds, setSpawnRounds] = useState<SpawnRoundsByChild>(NO_ROUNDS);
  const myTabId = myChat?.tabId;
  useEffect(() => {
    if (!myTabId) return;
    // NOTHING TO ASK FOR when this chat has spawned nothing, which is most
    // chats — and the corpus is how that is known, which is also why it belongs
    // in the dependency list: a round starting or ending moves the child's tab
    // row, so the corpus patch that lands for it is exactly the moment these go
    // stale. Invalidate even a fresh or in-flight read; the loader coalesces
    // changes during a read into a trailing refresh (lib/spawn-rounds).
    if (!corpus.some((c) => c.parentId === myTabId)) return;
    let live = true;
    void loadSpawnRounds(myTabId, true).then((r) => {
      if (live) setSpawnRounds(r);
    });
    return () => {
      live = false;
    };
  }, [myTabId, corpus]);
  const spawnedCards = useMemo(
    () => spawnCards(corpus, myChat?.tabId, MAX_SPAWN_CARDS, spawnRounds),
    [corpus, myChat, spawnRounds],
  );

  useLayoutEffect(() => {
    // The DOM now has per-round rows. Migrate both memories before the general
    // placement effect can seek a fallback id that no transcript page contains.
    const mem = recallChatScroll(paneId);
    if (mem?.anchorId) {
      const id = resolveSpawnAnchor(mem.anchorId, spawnRounds);
      if (id !== mem.anchorId) rememberChatScroll(paneId, { ...mem, anchorId: id });
    }
    const c = scroll.current;
    const intent = c?.intent();
    if (intent?.at === 'row') {
      const id = resolveSpawnAnchor(intent.id, spawnRounds);
      if (id !== intent.id) c?.dispatch({ t: 'anchor-renamed', from: intent.id, to: id });
    }
  }, [paneId, spawnRounds]);

  /**
   * WHO SENT THE MESSAGES IN THIS CHAT — the mirror of the spawn cards above.
   * Those are work going OUT of this conversation; this is work coming IN.
   *
   * A message delivered by `muxpad agent send` is a REAL user message (muxpad
   * does not write the agent's transcript, it tails the harness's file), so it
   * arrives here as an ordinary bubble with nothing on it to say a coordinator
   * rather than the human typed it. The server records that separately; this
   * joins it back on. See lib/inbound-senders.
   */
  const [inboundSenders, setInboundSenders] = useState<InboundSender[]>(NO_SENDERS);
  /**
   * The newest user bubble's id — the ONLY thing that can make the list stale,
   * and the reason this is not a poll.
   *
   * Keying the fetch on "a user message arrived" bounds it by real deliveries.
   * The obvious alternative — re-asking whenever some bubble is unattributed —
   * would re-ask forever in the common case, because a chat the human types
   * into has unattributed bubbles by definition and always will.
   */
  const newestUserId = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e?.kind === 'user') return e.id;
    }
    return null;
  }, [events]);
  /** The newest user id the last fetch was asked for. A DIFFERENT one on the
   *  same tab is a delivery, which is staleness the 4s cache cannot see. */
  const askedForUserId = useRef<{ tab: string; id: string } | null>(null);
  useEffect(() => {
    if (!myTabId || !newestUserId) return;
    const prev = askedForUserId.current;
    const arrived = prev !== null && prev.tab === myTabId && prev.id !== newestUserId;
    askedForUserId.current = { tab: myTabId, id: newestUserId };
    let live = true;
    void loadInboundSenders(myTabId, arrived).then((s) => {
      if (live) setInboundSenders(s);
    });
    return () => {
      live = false;
    };
  }, [myTabId, newestUserId]);
  const inboundByEvent = useMemo(
    () => matchInboundSenders(events, inboundSenders),
    [events, inboundSenders],
  );
  /**
   * A FOURTH kind of card wants the corpus, and no amount of scanning the text
   * can find it: a message another chat sent here carries no marker at all.
   * That is the point — the prompt the agent receives is untouched — so the
   * recorded senders are the only tell, and they ask for the corpus themselves.
   *
   * Down here rather than beside the other three because it reads
   * `inboundSenders`, which is declared above this line and not above those.
   */
  useEffect(() => {
    if (!transcriptNeedsCorpus && inboundSenders.length > 0) setTranscriptNeedsCorpus(true);
  }, [inboundSenders, transcriptNeedsCorpus]);

  // `inbound` rides the SAME context as the `@` resolver for the same reason it
  // exists: rows are drawn by a memoized component reached from several call
  // sites, and threading a map through all of them would be a prop on every
  // event shape in the file.
  const mentionContext = useMemo(
    () => ({ corpus, open: openChat, inbound: inboundByEvent }),
    [corpus, openChat, inboundByEvent],
  );
  const spawnedLive = useMemo(
    () =>
      // DEDUPED BY CHILD before it is counted. With rounds a worker appears in
      // several entries — one pair per round — and the bar counts CHATS, not
      // cards. Without this a child with four rounds would read as four agents,
      // which is the same inflation `runningChildren` was introduced to fix.
      runningChildren([...new Map(spawnedCards.map((c) => [c.chat.tabId, c.chat])).values()]),
    [spawnedCards],
  );

  // ── THE REPORT, EXPANDED ──────────────────────────────────────────────────
  // "if I just got a summary of it I'd be bummed that I lost everything."
  //
  // The summary on a report card is an INDEX — three sentences and where the work
  // is. Expanding fetches the child's final turn and renders it in place, under
  // the summary, so a 25 KB research report is readable without leaving the
  // conversation. The head link still goes to the sub-chat: expand to read it
  // here, the link to go there and continue.
  //
  // Both pieces of state are EPHEMERAL and per-device:
  //
  //   · A disclosure is not a preference. Nothing is persisted and nothing is
  //     synced — opening a report on the phone must not open it on the desktop.
  //   · The OPEN SET is keyed by the card's `anchorId`, because a worker draws a
  //     completion entry per round and this set is what says which one you
  //     opened. Keyed by tab id — which is what it was, correctly, while a child
  //     had exactly one — a single tap opened every round's card at once. The
  //     WORK CACHE uses the same entry key: each round has its own answer.
  //   · Not an index (the log grows), not a memo identity (the transcript memo
  //     rebuilds on every corpus patch), not an event id (a card has none).
  //   · Held HERE rather than inside the card, for the reason `expandedGroups` is:
  //     the element tree is rebuilt whenever the transcript or the corpus changes,
  //     and state inside the card would collapse every open report when it did.
  const [expandedReports, setExpandedReports] = useState<ReadonlySet<string>>(EMPTY_EXPANDED);
  // The fetched work, cached per entry so later rounds never reuse an old answer.
  // `undefined` = never asked, `null` = in flight.
  const [reportWork, setReportWork] = useState<ReadonlyMap<string, SpawnWork | null>>(EMPTY_WORK);
  const toggleReport = useCallback(
    (chat: MentionChat, anchorId: string, round?: SpawnCard['round']) => {
      // The height change is READER-CAUSED and in the middle of the document, so
      // it is an INPUT rather than something to detect afterwards: hold this row
      // where it is, measured before the commit that changes its height. Without
      // it, expanding a card above the viewport pulls the text out from under
      // whoever pressed the button. Same machinery as an action-run fold.
      onFoldToggled(anchorId);
      // KEYED BY THE CARD, not by the child. A worker draws a completion entry
      // per round, so a set keyed by tab id opened EVERY one of them from one
      // tap — on the measured 27-round child, twenty-seven boxes growing at once,
      // most of them above the reader. `anchorId` is per entry (see
      // `SpawnCard.anchorId`), which is what "this disclosure" means.
      setExpandedReports((prev) => {
        const next = new Set(prev);
        if (next.has(anchorId)) next.delete(anchorId);
        else next.add(anchorId);
        return next;
      });
      setReportWork((prev) => {
        // Asked once. A `gone` answer is cached too — re-requesting a pruned
        // transcript on every toggle would be a request per click with one
        // possible answer.
        if (prev.has(anchorId)) return prev;
        const next = new Map(prev);
        next.set(anchorId, null);
        void fetchSpawnWork(chat.paneIds, round).then((work) => {
          setReportWork((cur) => new Map(cur).set(anchorId, work));
        });
        return next;
      });
    },
    [onFoldToggled],
  );

  // Everything this pane resolves through a chat, in one condition. Declared
  // here rather than up with the corpus because a card is one of the three
  // reasons — see the note on `transcriptNeedsCorpus`.
  //
  // …and now a FOURTH, which subsumes the rest: ANY chat may have children, and
  // the only way to find out is to look, so this one is unconditional. That is
  // not the regression it appears to be — the corpus is one shared,
  // single-flight, event-refreshed cache (lib/all-tabs), so it costs one request
  // per app rather than one per pane. The others are kept in the expression
  // because each is a real reason in its own right, and the next person to
  // narrow this needs to see all four.
  const mayHaveSpawnedWork = true;
  const needsCorpus =
    mayHaveSpawnedWork || draftHasAt || transcriptNeedsCorpus || directed.length > 0;
  useEffect(() => {
    if (needsCorpus) ensureCorpus();
  }, [needsCorpus, ensureCorpus]);

  // Which requests have been answered is READ OFF THE TRANSCRIPT, not observed
  // as an event: a report can land while this pane is closed (or on another
  // device), and a card left spinning for a request that came back yesterday is
  // a lie the user has no way to clear.
  const reportedIds = useMemo(() => {
    const ids = new Set<string>();
    for (const ev of events) {
      if (ev.kind !== 'user') continue;
      const id = parseReportMarker(ev.text)?.marker.id;
      if (id) ids.add(id);
    }
    return ids;
  }, [events]);
  useEffect(() => {
    if (reportedIds.size === 0) return;
    setDirected(syncReported(paneId, reportedIds));
  }, [paneId, reportedIds]);

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
  // Media opened full-size in a lightbox. Carries the whole SET the click came
  // from plus the index, so the modal's arrows have somewhere to go — see
  // OpenMedia. null = closed.
  const [openImage, setOpenImage] = useState<{
    items: MediaItem[];
    index: number;
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
  /**
   * Why this pane has no agent, from the session frame. Null = nothing is known
   * to be wrong, which is the normal case.
   *
   * Starts NULL — "assume it is coming up" — because the ordinary create is
   * exactly that: rows first, pty a moment later, and a pessimistic default
   * would flash a failure over every healthy new chat.
   */
  const [provisionError, setProvisionError] = useState<string | null>(null);
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
        // ASSIGNED UNCONDITIONALLY, `?? null`. The server omits the key when
        // provisioning is healthy, and that absence is a meaningful value — it
        // is how a RECOVERY arrives (a later retry landed, or a runner said
        // hello). Guarding on presence would leave a fixed chat showing a dead
        // complaint until the next reload.
        setProvisionError(msg.provisionError ?? null);
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
        //
        // "Looking at" means the DOCUMENT is visible too: a selected chat in a
        // backgrounded browser is still `active`, and acking there erased the
        // mark on every device for a reply nobody saw. Hidden → leave it;
        // TabView's seen-effect acks it when the page becomes visible again.
        if (activeRef.current && documentVisible()) void api.markPaneSeen(paneId).catch(() => {});
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

  /**
   * Hand a request to ANOTHER chat's agent, and leave a card here saying so.
   *
   * Does not touch this pane's socket: the point of `@Name do this` is that the
   * work happens over there and this chat stays free. The card goes up
   * optimistically (the user's sentence must not vanish while a request is in
   * flight) and is taken back if the request could not be delivered.
   */
  const directWork = (
    target: MentionChat,
    /** The request as the user wrote it, for the card's second line. Taken from
     *  the parsed directive rather than re-derived by stripping the name out of
     *  the draft: the token in the draft is whatever the chat was CALLED when it
     *  was picked, which after a rename is not its name any more. */
    request: string,
    /** What the other agent is sent — prose plus any attachment paths. */
    outgoing: string,
    /** The composer's state, to hand back untouched if this never leaves. */
    restore: { text: string; chips: readonly { path: string; name: string; previewUrl: string }[] },
  ) => {
    const id =
      globalThis.crypto?.randomUUID?.().slice(0, 8) ?? Math.random().toString(36).slice(2, 10);
    const entry: DirectedWork = {
      id,
      at: Date.now(),
      tabId: target.tabId,
      tabSlug: target.tabSlug,
      workspaceSlug: target.workspaceSlug,
      // The card shows the REQUEST as the user wrote it: attachment paths are
      // for the agent to read, not for the log to quote back.
      body: request,
      chip: target.chip,
    };
    setDirected(addDirected(paneId, entry));
    void directTo(
      target,
      { id, from: myChat?.tabName ?? 'another chat', pane: paneId },
      outgoing,
    ).then((res) => {
      if (res.ok) return;
      setDirected(removeDirected(paneId, id));
      setNotice({ text: res.message, tone: 'info' });
      // Give the composer back rather than lose it — the same contract as a send
      // into a dead socket. Only if it is still empty: the user may have started
      // typing something else while this was in flight.
      setInput((cur) => (cur.trim() ? cur : restore.text));
      if (restore.chips.length) setChips((prev) => (prev.length ? prev : [...restore.chips]));
    });
  };

  const sendMessage = () => {
    const text = input.trim();
    // Sending retires a search highlight: it is the clearest possible statement
    // that you are done reading the result you were brought here for. Covers
    // the paths `onChange` doesn't — dictation, and the mobile send button.
    clearJump();
    closeMentions();
    // Whatever happens below, the composed text is leaving (or being answered
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
    // `@Name <text>` at the head of the draft goes to THAT chat instead of this
    // one. Checked before the socket, because this path does not use it — and
    // deliberately after the question card above, which owns the composer while
    // it is up.
    //
    // `input`, not `text`: a pick is anchored at an offset into the draft, and
    // the trim would shift every one of them by the leading whitespace.
    // `parseDirective` trims for itself.
    const directive = parseDirective(input, corpus, livePicks);
    if (directive && !directive.target) {
      // The chat the user PICKED is gone from the corpus. Do not guess another
      // one with the same name, and do not send it here either — keep the draft
      // and say why, so they can pick again.
      setNotice({
        text: `@${directive.missing.name} isn't available any more — pick the chat again.`,
        tone: 'info',
      });
      return;
    }
    if (directive) {
      directWork(
        directive.target,
        directive.body,
        composeOutgoingMessage(directive.body, attachmentPaths),
        {
          text,
          chips,
        },
      );
      setInput('');
      clearChips();
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

  // File picker → upload via the same attachments endpoint the TUI composer
  // uses; each upload becomes a composer chip whose path is appended at send
  // (exactly like paste — the path is NEVER spliced into the draft, or it would
  // ride out twice and render the image twice).
  //
  // ── WHY NOT image/* ─────────────────────────────────────────────────────────
  // This was an image picker, and the server never was: the upload route has
  // always taken pdf, txt, md, csv, json, zip and the rest, and the chat has a
  // file-chip renderer for exactly those. The `accept` attribute was the only
  // thing standing in the way — and on iOS an image-only `accept` also
  // SUPPRESSES the Files and iCloud options in the share sheet, which is why
  // the phone offered only Photo Library and Take Photo. Naming the extensions
  // the server accepts restores the full native sheet and keeps the OS greying
  // out anything the upload would have rejected afterwards.
  const onPickFiles = async (e: ChangeEvent<HTMLInputElement>) => {
    const el = e.target;
    // Accept exactly what the server upload route accepts: a known MIME, or a
    // known filename extension when the provider reports no type (HEIC
    // pickers, some Android providers, and iOS Files for several document
    // types all hand over type=''). Dropping anything is LOUD — a silently
    // swallowed pick reads as "the app is broken".
    const all = Array.from(el.files ?? []);
    const files = all.filter(
      (f) => attachmentExtForMime(f.type) !== null || attachmentExtFromName(f.name) !== null,
    );
    if (files.length < all.length) {
      const skipped = all.filter((f) => !files.includes(f)).map((f) => f.name);
      setNotice({
        text: `skipped ${skipped.join(', ')} — muxpad accepts ${ATTACHMENT_EXTENSIONS.join(' ')}`,
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

  const onPaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
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
        // Same reason as editQueued: a programmatic setInput fires no onChange,
      }
      inputRef.current?.focus();
    })();
  };

  // ── THE DOCUMENT CHANGED: SATISFY THE INTENT ──────────────────────────────
  // One of two subscriptions. This one is "React committed, so the document may
  // have changed"; the ResizeObserver below is "something changed outside a
  // commit" (an image decoding, a font settling, the viewport resizing).
  //
  // NO DEPENDENCY ARRAY, deliberately. It used to list the state it thought
  // could move the log — `events`, `streamingText`, `optimisticUser`,
  // `question`, the subagent count, the queue length — and that list was an
  // enumeration, which is the same mistake the per-device gesture listeners
  // were. It was missing `notice` (the "Reconnecting…" banner), `loadingOlder`
  // (the older-history spinner), `stale`, `hasMessages`, `agentStatus`,
  // `folder` and `mode`, every one of which renders or unrenders a box.
  //
  // A ResizeObserver does not cover the gap, because it reports an element whose
  // own box changed and fires nothing when one is REMOVED. Measured: a restore
  // landed correctly and then ~6px above the reader disappeared, leaving them at
  // offset -6 for the whole visit. The old design survived it by polling for
  // 2500ms and re-converging; that is the forgiveness a poll buys, and the way
  // to keep it without the poll is to subscribe to the commit itself rather than
  // to a guess about which state matters.
  //
  // The cost is one `place()` per commit: two rect reads, and a write only when
  // the intent is not already satisfied.
  useLayoutEffect(() => {
    if (!active) return;
    // New rows are new things that can change height under the reader.
    watchRows();
    scroll.current?.place();
    // …and the arrow follows the placement. It used to be derived ONLY inside
    // `onScroll`, so a pane that opened somewhere other than the bottom without
    // producing a scroll event — a restore that lands exactly where the document
    // already was, which is the common case for a tab switch — showed no way
    // back to the tail at all.
    syncScrollDownArrow();
  });

  // Auto-grow the composer like ChatGPT: reset to content height, capped by CSS
  // max-height (the box keeps scrolling past that). `input` is the trigger
  // (we measure the DOM, not read it), so keep it in the dep list.
  //
  // Measuring works the same on the contenteditable the composer now is — one
  // box, one scrollHeight — with one difference that matters: a chip is TALLER
  // than the text beside it, so a draft can outgrow one line without any newline
  // in it. Which is the same reason this reads the DOM rather than counting the
  // string, and was already true of a wrapped line.
  // biome-ignore lint/correctness/useExhaustiveDependencies: input is the resize trigger
  useEffect(() => {
    const el = inputRef.current?.el();
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
  // byte the layout that shipped before it. All of the reasoning — why the
  // composer needs this at all, why the installed PWA is the case that matters,
  // and why a value that was right once has to be re-asserted rather than
  // latched — is in lib/keyboard-inset.ts.
  // biome-ignore lint/correctness/useExhaustiveDependencies: pendingPick/current_sid gate when the pane box and its composer exist.
  useEffect(() => {
    const pane = paneRef.current;
    if (!active || !pane || !isMobileLayout()) return;
    return trackKeyboardInset(pane, { viewport: window.visualViewport ?? null });
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
      const input = inputRef.current?.el();
      if (!input || document.activeElement === input) return;
      const ae = document.activeElement as HTMLElement | null;
      // `isContentEditable` covers the composer itself now as well as any other
      // editable on the page — which is why the identity check above comes
      // first: without it this would decline to focus the very field it is for.
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable))
        return;
      input.focus(); // the character then lands in the now-focused composer
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
  //
  // NO DEPENDENCY ARRAY, for the third time in this file and for the third time
  // for the same reason. It listed `[active, events, loadingOlder,
  // hasMoreOlder]` — and claiming a search jump changes none of them. It changes
  // `jump`, and it dispatches the intent. So the effect never re-ran, the seek
  // never started, and the reader was told the message was "further back than
  // the history loaded here" on the strength of zero requests. Measured: `rows`
  // and `first` identical before and after the jump.
  //
  // What wants a page is the INTENT, and an intent changes on a dispatch that no
  // dependency array can see. Running on every commit costs one `wantsOlder` —
  // a single row lookup — and `requestOlder` is single-flight on a ref, so a
  // burst of commits cannot produce a burst of requests.
  useEffect(() => {
    if (!active || loadingOlder) return;
    if (!scroll.current?.wantsOlder(hasMoreOlder)) return;
    if (requestOlder()) scroll.current.dispatch({ t: 'sought' });
  });

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
      // Dispatched on the CLAIM, not when the target binds. The message is
      // usually not loaded yet — that is what the seek is for — so waiting for
      // an id meant the jump never entered the state that pages for it.
      scroll.current?.dispatch({ t: 'search-jump' });
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
    // The target has bound (or re-rendered, or the pane became visible again):
    // re-place against the mark as it is now. The intent is already `hit` — set
    // when the jump was claimed — so this is a placement, not a state change.
    scroll.current?.place();
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
  //
  // Every branch here is a REASON, and none of them is "the seek is not running
  // for some other cause". `wantsOlder` used to stand in for the last one, and
  // it answers false for reasons that have nothing to do with having looked —
  // so a jump that never got as far as asking reported itself as exhausted.
  useEffect(() => {
    const c = scroll.current;
    if (!jump || !active || !c || jumpTargetId || jumpMissed || loadingOlder) return;
    if (
      // The server has no more to give.
      !hasMoreOlder ||
      // The hit's timestamp is already INSIDE the loaded range and it still is
      // not rendered — a subagent sidechain, which the archive indexes and the
      // chat view does not draw. No amount of paging will produce it.
      !jumpMayBeOlder(events, jump.ts) ||
      // …or we looked, eight pages of it.
      c.spentSeekBudget()
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
  // re-runs the restore transition above.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      // iOS resets overflow scroll on resume — that is what `showEpoch` exists
      // for — and the native `scroll` event from that reset can run in this same
      // turn, while the layout effect reacting to the bump is still queued behind
      // a render. Nothing has to be armed for it: the controller believes no
      // scroll event until `shown` permits placement again, which is a causal
      // gate rather than a 250ms window. `hidden` keeps it shut even while the
      // DOM is already measurable. This used to be a wall-clock deadline stamped here AND re-stamped in
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
  // ── IT WATCHES THE ROWS, NOT JUST THE BOXES ───────────────────────────────
  // Observing the scroller and the list is not enough, and the gap is silent.
  // A ResizeObserver reports an element whose own box changed — so two rows
  // ABOVE the reader that change by equal and opposite amounts, which is an
  // ordinary markdown reflow or an image replacing a placeholder of nearly the
  // same height, move the reader and fire NOTHING, because `.chat-list`'s total
  // height never moved. Measured in a browser: the callback did not run once.
  //
  // A poll is forgiving of that and a subscription is not, which is the price of
  // deleting the poll — so the subscription has to cover what the poll covered.
  // Watching each row closes it precisely: a ResizeObserver costs per CHANGED
  // element, not per observed one, and `observe` is idempotent, so re-offering
  // the same rows on each commit is cheap.
  //
  // `pendingPick` is a dependency because the harness picker renders a DIFFERENT
  // tree with no `.chat-scroll` in it: an active pane that starts on the picker
  // has a null ref here, and without re-running when the real chat mounts the
  // observer would never attach for that pane's whole life.
  // biome-ignore lint/correctness/useExhaustiveDependencies: pendingPick gates when the scroll container exists.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !active) return;
    const ro = new ResizeObserver(() => scroll.current?.place());
    rowWatcher.current = ro;
    watchRows();
    return () => {
      ro.disconnect();
      rowWatcher.current = null;
    };
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
   * STARTING AN AGENT-BACKED PANE THAT HAS NO RUNNER, from the chat itself.
   *
   * This pane already knows what it is — the row carries the backend, the mode
   * and the startup command. The only thing missing is a live process, so the
   * empty state's job is ONE button that starts it, not a sentence telling the
   * reader to go type `muxpad agent` in a terminal. Mobile is the primary
   * surface and there is no terminal on a phone; that instruction was
   * unreachable advice on the one device it was most likely to be read on.
   *
   * `respawnPane` is the right verb rather than a conversion: it re-types the
   * pane's OWN startup_cmd, so the chat comes back as itself (same harness,
   * same mode, same folder, resuming its session where it has one) instead of
   * being re-chosen.
   */
  const [startBusy, setStartBusy] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const startStall = useRef<number | undefined>(undefined);
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
  /**
   * Start the agent this pane is already configured to run.
   *
   * Success is NOT the 204 — it is the runner's hello, which arrives as a
   * session frame some seconds later. So the button keeps spinning past the
   * response and is released by whichever comes first: the session landing
   * (the effect below) or the stall timer. A failure that the server can name
   * (ptyd down → 503 with a reason) is shown verbatim; that sentence is the
   * honest answer the shell instruction was standing in for.
   */
  const startAgent = useCallback(async () => {
    setStartBusy(true);
    setStartError(null);
    window.clearTimeout(startStall.current);
    startStall.current = window.setTimeout(() => {
      setStartBusy(false);
      setStartError('the agent did not come up — tap to try again');
    }, AGENT_START_STALL_MS);
    try {
      await api.respawnPane(paneId);
    } catch (e) {
      window.clearTimeout(startStall.current);
      setStartBusy(false);
      setStartError(e instanceof Error && e.message ? e.message : 'could not start the agent');
    }
  }, [paneId]);
  // The runner arrived — stop spinning and drop any stale complaint. Also the
  // unmount/pane-switch cleanup, so a timer can't fire into a later pane.
  useEffect(() => {
    if (session?.current_sid) {
      window.clearTimeout(startStall.current);
      setStartBusy(false);
      setStartError(null);
    }
  }, [session?.current_sid]);
  useEffect(
    () => () => {
      window.clearTimeout(startStall.current);
    },
    [],
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
      //
      // …UNLESS the server has already told us the spawn failed. Then the grace
      // is a spinner over a known answer, and the honest screen is available
      // now. `provisionError` is only set once every retry is spent, so this
      // cannot pre-empt a provision that is still in progress.
      if (!stale && !provisionError)
        return (
          <div className="chat-empty">
            <div className="chat-empty-spinner" aria-hidden="true" />
            <p>Starting…</p>
          </div>
        );
      // Nothing is running here — but this pane already knows WHAT to run, so
      // the affordance is a button, not shell homework. See ChatNoRunner.
      //
      // `failed` is what turns the neutral screen into an honest one: same verb,
      // same button, different sentence — because "this chat has no agent yet"
      // and "this chat's agent could not be started, here is what said no" are
      // different facts and were being reported as the same one. `startError`
      // (this session's own failed tap) still wins when there is one: it is the
      // newer of the two.
      return (
        <ChatNoRunner
          busy={startBusy}
          error={startError ?? provisionError}
          failed={provisionError !== null}
          onStart={() => void startAgent()}
        />
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
    // Each top-level row, WITH the moment it happened — the spawn cards are
    // placed against these times (see the interleave below), so an entry that
    // records no time simply isn't a boundary. Nothing else reads `at`.
    const items: { at: number | null; node: React.ReactNode }[] = [];
    for (let i = 0; i < renderable.length; ) {
      const e = renderable[i] as ChatEvent;
      if (!isAction(e)) {
        items.push({ at: e.ts, node: renderEvent(e, e.id) });
        i++;
        continue;
      }
      let j = i;
      while (j < renderable.length && isAction(renderable[j] as ChatEvent)) j++;
      const run = renderable.slice(i, j) as ChatEvent[];
      if (!foldsAsActionRun(run)) {
        // Explicit arrow, not `.map(renderEvent)`: Array#map passes the INDEX
        // as the second argument, which is now the anchor id.
        items.push(...run.map((ev) => ({ at: ev.ts, node: renderEvent(ev, ev.id) })));
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
        items.push({
          // A folded run is placed by its HEAD, which is the same event the key
          // and the scroll anchor use — so a card whose spawn happened inside a
          // long run lands after the whole group, and stays there as the run
          // grows at its tail.
          at: (run[0] as ChatEvent).ts,
          node: (
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
            />
          ),
        });
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
        {/* The spawn cards, dropped in WHERE THE SPAWN HAPPENED — the child's
            `created_at` against the entries' own times. Everything that makes
            them what they are is in that one call: they scroll with the
            conversation, they cannot become furniture, and they cannot drift,
            because nothing here remembers a position.

            Not deduped against the directed cards below any more. That dedup was
            right while both were blocks at the foot of the log — one chat, two
            adjacent cards, drawn twice. They are different statements in
            different places now: this one is "you started this, here", and the
            other is "a request to it is in flight". Suppressing the spawn entry
            because of an unrelated later `@` would delete a piece of the record
            from the middle of the conversation. */}
        {interleaveSpawnCards(
          // Browser moments go in FIRST, as ordinary timed entries, so the
          // spawn-card interleave — and the file it lives in — never has to
          // know browsers exist. A browser opening and an agent getting stuck
          // are two moments in the log, not a status light above it.
          injectBrowserMoments(items, browserMoments, (moment) => (
            <BrowserCard
              key={`browser:${moment.profile}:${moment.at}:${moment.kind}`}
              moment={moment}
              onOpen={(mode) => openBrowser(moment.browser, mode, browserOpenIntent(moment))}
            />
          )),
          spawnedCards,
        ).map((x) => {
          if (x.kind === 'entry') return x.node;
          const kid = x.card.chat;
          // ONE state resolution for both kinds of card, in the lib and tested
          // there — including the `failed` that did not exist: a crashed worker
          // KEEPS its live row on purpose, so `!done` read it as still working and
          // its card span forever. Read off the corpus every render, which is what
          // keeps it honest after the card has scrolled up; the corpus is
          // live-patched from the server's own `tab.updated` (lib/all-tabs), so
          // nothing here polls and nothing caches a state.
          const state = spawnState(kid);
          // Closed-round entries carry a snapshot; the open round reads the live child.
          if (x.card.kind === 'launch') {
            // THE LAUNCH. "you started this, and it is running." Nothing else:
            // at a launch there is nothing to summarise, and once the work is
            // over its outcome lives on the completion entry at the bottom of the
            // log. Repeating it here would put the same fact in two places, with
            // the copy nobody can see being the one claiming to be current.
            //
            // So the mark SPINS while the child works and the slot is EMPTY once
            // it is finished. This card stops being a live indicator and becomes
            // what it always was underneath: the record that a launch happened.
            // THE CARD'S OWN ID, not one rebuilt from the child's tab. See
            // `SpawnCard.anchorId`: a worker is a sequence of rounds and draws a
            // pair of entries per round, so `spawn-${kid.tabId}` named 27 rows
            // in one log on the real database — a duplicate React key, and a
            // scroll anchor that resolved to the wrong card and threw the reader
            // 2,400px up the log off their own scroll event.
            const anchorId = x.card.anchorId;
            return (
              <ChatMentionCard
                key={anchorId}
                anchorId={anchorId}
                // A SENTENCE, NOT A HANDLE. The card used to read `status-line`
                // — the `--name=` value typed on a command line — beside a dot
                // and a spinner, and two of those said nothing about what was
                // running. `spawnLabel` reaches for the generated task line, then
                // the headline, then the handle; it is never blank.
                chat={{ ...kid.chip, name: spawnLabel(kid) }}
                // …and the handle underneath it, because that is what the rail
                // shows, what `@` completes, and what you would type to talk to
                // this worker. Omitted when it IS the label.
                sub={spawnHandle(kid)}
                // "At a minimum give them a sub-chat icon." A branch, in place of
                // the clock chip a sub-chat has no use for — see the component.
                mark="spawn"
                working={state === 'working'}
                onOpen={() => openChat(kid)}
              />
            );
          }
          // THE COMPLETION — a SECOND entry, at the moment the work ended, which
          // is where the reader is looking when a long job finishes. Everything
          // the result is lives here.
          // THIS ROUND's result, not the tab's newest one. The tab carries one
          // report — the latest — so reading it for every completion card would
          // make an old card restate a result that belongs to a later round.
          const report = x.card.report ?? kid.report;
          // Its own anchor, so the two entries are separately addressable by the
          // scroll memory and expanding one holds the right row — and, since
          // rounds, so are ROUND THREE's two entries and round four's. Built in
          // `spawnCards`, which is the only thing that knows whether this entry
          // came from a round or from the tab-level fallback.
          const anchorId = x.card.anchorId;
          // AN EXPANDER ONLY WHERE THERE IS A RESULT BEHIND IT. Three report
          // states exist in the wild at once and two of them have nothing to
          // show; over those the control used to fall through to the transcript,
          // and what it opened onto was the worker's entire narration. See
          // `canExpandSpawn`, which is where the three cases are written out.
          const canExpand = canExpandSpawn(kid);
          // The disclosure is per ENTRY — see `toggleReport`. Keyed by the child
          // it opened every round's card at once.
          const expanded = canExpand && expandedReports.has(anchorId);
          // The work is bounded to this round and cached under this entry.
          const work = expanded ? reportWork.get(anchorId) : undefined;
          return (
            <ChatMentionCard
              key={anchorId}
              anchorId={anchorId}
              // The SAME label and the same mark as its launch card: the two
              // entries are one worker seen twice, and a reader who scrolls past
              // the first has to recognise the second as the same thing.
              chat={{ ...kid.chip, name: spawnLabel(kid) }}
              mark="spawn"
              // NOTHING UNDER THE NAME unless there is a real summary — and it
              // is emphatically not the chat's headline, which is what used to be
              // here. That is HeadlineWriter's label: it restates the PROMPT
              // ("largest source files in muxpad" under a card named
              // `biggest-files`), and it is written on a six-minute interval, so
              // it turns up long after the work finished and then says nothing
              // about what the worker FOUND. A blank line beats a slow
              // meaningless one.
              //
              // The summary goes in the BODY, not in `sub`. `sub` is a one-line
              // slot that clips with an ellipsis — right for the directed card,
              // whose sub is the request you typed, and wrong for prose: it turned
              // a three-sentence summary into "Ranked the repo by line count:
              // ws.ts (4,812) and C…", which is the truncation this whole feature
              // is written against. The body wraps and takes a reading measure.
              body={spawnCardSummary(report)}
              // WHERE THE WORK IS. Not part of the summary and deliberately so:
              // these are scraped from the transcript, not generated, so they
              // land on a card whose summary was refused — which is exactly the
              // card that had nothing on it at all.
              artifacts={kid.artifacts}
              // A completion card only exists for a finished child, so `working`
              // is unreachable here — narrowed rather than asserted, because the
              // compiler cannot know that and a cast would hide it if it changed.
              state={state === 'working' ? undefined : state}
              tone={state === 'working' ? undefined : state}
              expanded={expanded}
              work={expanded ? <SpawnWorkBody work={work} onOpenImage={setOpenImage} /> : undefined}
              // Offered only behind a real report. The expansion is then the
              // child's own FINAL MESSAGE — its answer, with the path or url it
              // names in it — and not the story of how it worked, which is what
              // the whole final turn turned out to be.
              onToggleExpanded={
                canExpand ? () => toggleReport(kid, anchorId, x.card.round) : undefined
              }
              onOpen={() => openChat(kid)}
            />
          );
        })}
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
    startBusy,
    startError,
    // LOAD-BEARING. The failure arrives on the socket LONG after this memo last
    // ran — the ladder takes ~10s — so without it here the chat keeps rendering
    // "Starting…" over a spawn that has already given up, and the whole
    // server-side push chain lands on a view that never repaints. Same for the
    // recovery in the other direction.
    provisionError,
    startAgent,
    staged,
    launchOptions,
    converted,
    convertRefusal,
    startStaged,
    folder,
    queue,
    chooseTerminal,
    chooseWeb,
    // The cards live in the transcript now, so the transcript re-renders when a
    // child is spawned or finishes. That is one memo recompute per `tab.updated`
    // for this chat's children — the rows themselves are memoized, which is what
    // makes the indicator update in place instead of re-parsing the log.
    spawnedCards,
    openChat,
    // The expansion is a disclosure the READER drives, so the transcript has to
    // rebuild when it changes — and when the fetched work lands under it.
    expandedReports,
    reportWork,
    toggleReport,
    // Same reason as `spawnedCards` above: browser cards live IN the transcript,
    // so the transcript has to rebuild when one arrives or changes. Without
    // this the cards render once and then lie — a summons answered ten minutes
    // ago keeps shouting, because the memo never recomputes.
    browserMoments,
    openBrowser,
    // Both of these were CAPTURED but not listed, which in a memo means the
    // transcript keeps rendering against the values it first saw. `mode` is the
    // one with teeth: switching a live pane between Chat and Agent changed the
    // pane row and the next turn's contract, and left this body memoized
    // against the old mode. Adding deps to a memo has no side effects — it only
    // recomputes more often — so there is no reason to have left them out.
    mode,
    onFoldToggled,
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

  // What the working row says — see `workingRowLabel`. NULL when no tool is
  // running: the dots carry "something is coming, here", and the bar above the
  // composer owns the word. Two surfaces said `Working…` a hundred pixels
  // apart until the decision moved next to the bar's own.
  const unresolvedTool = agentWorking ? (toolIndex.unresolvedTools[0] ?? null) : null;
  const workingLabel = workingRowLabel(unresolvedTool?.name);

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
  // …and the CHILD CHATS, which are the parallel work muxpad itself spawns.
  // This cell is the persistent "something is running" indicator, and it read 0
  // through a dozen working children because it counted the harness roster only
  // — the user asked about that twice.
  //
  // `busy` is READ, not asserted. It used to be the literal `true` on every
  // child, on the reasoning that "a child is busy until it delivers" — which is
  // how a chat whose runner had DIED got a spinning row in this list. The list
  // is now already filtered to the running ones (`spawnedLive`), so liveness is
  // settled in exactly one place and this reads the same predicate rather than
  // overriding it with a constant.
  for (const kid of spawnedLive) {
    rosterAgents.push({
      id: `chat:${kid.tabId}`,
      label: kid.tabName,
      steps: 0,
      busy: childIsRunning(kid),
      chat: { workspaceSlug: kid.workspaceSlug, tabSlug: kid.tabSlug },
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

  // THE NUMBER IS THE CHILD CHATS, and the subagents are named separately.
  // `rosterAgents` is a union of two populations — the chats spawned above, and
  // the harness subagents from the two loops before them — and sizing the cell
  // with `rosterAgents.length` made one number stand for both. Reported: the
  // cell read `5 agents` over 2 sidebar rows, and the question that came back
  // was whether it counts "some additional primitive that doesn't show up in
  // the sidebar". It did. `chat` is the discriminator the roster already
  // carries: a child chat has somewhere to navigate to, a subagent does not.
  // See live-status.ts for why the number must equal the rows.
  const rosterChats = rosterAgents.filter((a) => a.chat).length;
  const liveLabel = liveStatusLabel({
    chats: rosterChats,
    subagents: rosterAgents.length - rosterChats,
    turnActive: sending,
  });

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
    // Every mention in the log resolves through this: rows are rendered by a
    // memoized component reached from several call sites, and a resolver
    // threaded as a prop through all of them would be a prop on every event
    // shape in the file. The value is memoized, so the transcript re-renders
    // when the CORPUS lands and not on the frames in between.
    <ChatMentionContext.Provider value={mentionContext}>
      <div className="chat-pane" ref={paneRef}>
        {/* Fixed-position, draws nothing until you take the wheel. Mounted here
          rather than beside a card because the card that opened it may scroll
          away — or be unmounted by a poll — while the modal is still open. */}
        {browserModal}
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
                  scroll.current?.dispatch({ t: 'search-jump' });
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
                    {workingLabel ? (
                      <span className="chat-working-label">{workingLabel}</span>
                    ) : null}
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
            {/* Work this chat DIRECTED at another one. Live furniture at the foot
              of the log, beside the pending queue, because that is what it is:
              a request in flight somewhere else. The spinner is the same 10px
              mark as everywhere else, and it stops when the report lands (which
              is read off the transcript, not watched for). */}
            {directed.map((d) => {
              // LIVE FIRST, snapshot second. `d.chip` is frozen at send time so
              // the card can draw on the first paint after a reload, before
              // `/api/tabs/all` has answered — that is still why it is stored.
              // But it was also the ONLY thing ever rendered, and the comment
              // claiming "the corpus refreshes it when it arrives" had no
              // implementing code: directing work to a done chat left a
              // done-looking card for as long as the card lived, even though the
              // message had just revived its recipient, and a rename or a
              // retirement never reached it either. The tab id is the durable
              // handle; the snapshot is the fallback while there is no corpus.
              const live = corpusById.get(d.tabId);
              return (
                <ChatMentionCard
                  key={d.id}
                  chat={live?.chip ?? d.chip}
                  sub={d.body}
                  working={!d.reportedAt}
                  state={d.reportedAt ? 'reported' : undefined}
                  onOpen={() => openChat(live ?? d)}
                />
              );
            })}
            {/* Work this chat SPAWNED used to be a block RIGHT HERE — one card
              per live child, pinned above the composer for as long as the child
              ran. It is in the transcript now, at the moment of the spawn (see
              `interleaveSpawnCards` in the body memo above), which is what the
              user asked for: an indication in the chat that you launched
              something, scrolling away with the conversation like any other
              entry, and no longer a second copy of what the status cell's
              "2 agents" says in the same eyeful.

              Nothing replaces it here. A card at the foot of the log is furniture
              by construction — it cannot scroll away, so it has to keep earning
              its place forever, and neither a cap nor an age ever made that true
              (see the history in lib/chat-mention). If you are adding a spawn
              card back to this block, the placement is the bug. */}
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
            items={openImage.items}
            index={openImage.index}
            onIndex={(i) => setOpenImage((o) => (o ? { ...o, index: i } : o))}
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
            {/* Absolutely positioned (see ChatMentionPicker.css): the composer
              wrap's measured height is what reserves room at the foot of the
              transcript, so a picker in its flow would scroll the conversation
              every time you typed `@`. */}
            {mentionOpen ? (
              <ChatMentionPicker
                rows={mentionRows}
                cursor={mentionSafeCursor}
                query={mentionRun?.query ?? ''}
                listId={mentionListId}
                searching={mentionSearching}
                onPick={pickMention}
                onHover={setMentionCursor}
              />
            ) : null}
            {/* A SIBLING OF THE PILL, above it — not a child of it.

                It has now been wrong in both directions, so both are written
                down. As its own floating strip it was a second OBJECT: its own
                border, its own background, a 10px gap, 37px of a 119px bar for a
                line you read and almost never press. Moved onto the pill's
                surface to pay that back, it became chrome inside the thing you
                type in — "it's all too tight there" — and, worse, it sat above
                the input INSIDE a bottom-anchored pill, so the one time it
                mattered (a long model id and a folder name at 390px, wrapping)
                it SHOVED THE COMPOSER DOWN.

                Out here it costs the same as it did on the pill: one 16px line
                plus the 6px that separates it, where the pill's own row gap used
                to spend the same 6px on it. Its height is a constant in the
                stylesheet and it can no longer wrap (ChatPane.statusline.test.tsx
                pins both), so it cannot move the composer whatever it says. It
                stays inside `.chat-composer-wrap` deliberately: the wrap is what
                `composerRef` measures, and `.chat-composer-reserve` holds that
                height clear at the foot of the log — a strip positioned outside
                the measurement would float over the last message instead. */}
            <SessionBar
              paneId={paneId}
              folder={folder}
              status={agentStatus}
              {...(session?.assistant ? { assistant: session.assistant } : {})}
              liveLabel={liveLabel}
              agents={rosterAgents}
              onOpenChat={openChat}
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
              {/* No `capture` attribute, deliberately: with one, iOS goes straight
                to the camera. Without it — and with an `accept` that is not
                image-only — the share sheet offers Photo Library, Take Photo,
                AND Choose File / iCloud, which is the native picker rather than
                anything we have to build. */}
              <input
                ref={fileInputRef}
                type="file"
                accept={ATTACHMENT_ACCEPT}
                multiple
                hidden
                onChange={onPickFiles}
              />
              <div className="chat-composer-main">
                <button
                  type="button"
                  className="chat-attach"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading}
                  aria-label="Attach a file"
                  title="Attach a file"
                >
                  {uploading ? (
                    <span className="chat-attach-spin" aria-hidden="true" />
                  ) : (
                    <SvgAttach />
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
                <ChatDraft
                  ref={inputRef}
                  className="chat-input"
                  value={input}
                  // The SAME corpus the log resolves a sent message against, so
                  // the draft and the message cannot disagree about which `@Name`
                  // is a chip — see draftNodes.
                  corpus={corpus}
                  // The combobox arrangement the sidebar's search box uses: the
                  // FIELD keeps focus and points at the active row, so composing
                  // is never interrupted by a list taking the caret. Stated only
                  // while the picker is up — an `aria-activedescendant` pointing
                  // at an id that is not in the document announces nothing.
                  aria={
                    mentionOpen
                      ? {
                          role: 'combobox',
                          'aria-expanded': true,
                          'aria-autocomplete': 'list',
                          'aria-controls': mentionListId,
                          'aria-activedescendant': `${mentionListId}-${mentionSafeCursor}`,
                        }
                      : undefined
                  }
                  onChange={(text, caret) => {
                    setInput(text);
                    syncMentionRun(text, caret);
                    // Editing retires a search highlight. Typing into the
                    // composer means you have stopped reading the result you were
                    // brought here for and started using the chat.
                    clearJump();
                  }}
                  // A caret MOVED by an arrow or a click can land inside an
                  // existing `@…`, which has to reopen that run's picker — the
                  // run is defined by where the caret is, not by the end of the
                  // draft. `keyup` rather than `keydown`: the caret has not moved
                  // yet on the way down.
                  onCaret={(text, caret) => syncMentionRun(text, caret)}
                  onPaste={onPaste}
                  onKeyDown={(e) => {
                    // The picker owns the arrows, Enter, Tab and Escape while it
                    // is up — except mid-composition, where an IME owns Enter and
                    // the arrows to choose a candidate and stealing them there
                    // makes the composer unusable in Japanese/Chinese input.
                    if (mentionOpen && !e.nativeEvent.isComposing) {
                      const n = mentionRows.length;
                      if (e.key === 'ArrowDown') {
                        e.preventDefault();
                        setMentionCursor((c) => (Math.min(c, n - 1) + 1) % n);
                        return;
                      }
                      if (e.key === 'ArrowUp') {
                        e.preventDefault();
                        setMentionCursor((c) => (Math.min(c, n - 1) + n - 1) % n);
                        return;
                      }
                      if (e.key === 'Enter' || e.key === 'Tab') {
                        e.preventDefault();
                        const row = mentionRows[mentionSafeCursor];
                        if (row) pickMention(row);
                        return;
                      }
                      if (e.key === 'Escape') {
                        e.preventDefault();
                        closeMentions(true);
                        return;
                      }
                    }
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
    </ChatMentionContext.Provider>
  );
}

// Everything that draws an ALREADY-ARRIVED message — rows, bubbles, mention
// chips, media, modals — now lives in ChatTranscript.tsx. It holds no socket,
// no session and no turn state, which is what made it separable from the
// lifecycle above.
