/**
 * How one message in the transcript is drawn — the rows, the bubbles, the
 * mention chips, the media and the modals.
 *
 * Split out of ChatPane.tsx, which was over 7,000 lines and twice the size of
 * anything else in the repo. Nothing here changed in the move.
 *
 * The seam is a real one rather than an arbitrary cut at a line count: this is
 * everything that renders a message that has ALREADY ARRIVED. It holds no
 * socket, no session and no turn state — give it an event and it returns
 * markup — which is why it can be read, and tested, without the 4,000 lines of
 * lifecycle above it.
 */
import {
  type AgentQuestion,
  type ChatEvent,
  type NoticeEvent,
  type ToolResultEvent,
  type ToolUseEvent,
  summarizeToolInput,
} from '@muxpad/shared';
import { createContext, memo, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { type MessagePart, splitMessageAttachments } from '../lib/attachments';
import {
  type MentionChat,
  parseDirectMarker,
  parseMentions,
  parseReportMarker,
} from '../lib/chat-mention';
import type { SpawnWork } from '../lib/spawn-work';
import { HighlightedText, Markdown } from './ChatMarkdown';
import { ChatMentionCard, ChatMentionPill } from './ChatMentionPicker';
import { CopyablePre } from './CopyablePre';
import { FromAgentMessage } from './FromAgentMessage';
import { SvgAgentGlyph } from './PaneWebSwitch';

/** Open a full-screen image or video. Lives here with the media it opens. */
export type OpenMedia = (m: { url: string; name: string; video: boolean }) => void;

/** A question card the agent is waiting on. */
export type PendingQuestion = { qid: string; questions: AgentQuestion[] };
/**
 * How a rendered message resolves an `@` back to a chat.
 *
 * Default is deliberately inert (no chats, navigation a no-op): a message
 * rendered outside a pane — a test, a future surface — shows the text the user
 * typed rather than throwing, which is the correct degradation for a chip.
 */
interface ChatMentionResolver {
  corpus: readonly MentionChat[];
  open: (chat: { workspaceSlug: string; tabSlug: string }) => void;
  /**
   * WHICH MESSAGES CAME FROM ANOTHER CHAT — event id → sending tab id.
   *
   * Empty by default, which is also the honest answer everywhere the map has
   * not arrived (or the server is too old to have it): every bubble renders as
   * it always has. An absent entry is never an invitation to guess.
   */
  inbound?: ReadonlyMap<string, string> | undefined;
}
export const ChatMentionContext = createContext<ChatMentionResolver>({
  corpus: [],
  open: () => {},
});

/**
 * A user message, which may be a chat talking to a chat.
 *
 * Three shapes, decided by a leading marker (see lib/chat-mention):
 *
 *   a REPORT — an answer coming back from a chat this one directed work to.
 *   a DIRECTION — a request that arrived here FROM another chat, with the block
 *     that told this chat's agent where to send its answer.
 *   anything else — an ordinary bubble, with `@` mentions as chips.
 *
 * Both cards are clickable and go to the chat at the other end of the exchange,
 * which is the whole affordance: a card is the handle on the conversation that
 * is happening somewhere else.
 */
export function MentionMessage({
  eventId,
  text,
  onOpenImage,
  hl,
}: {
  /** This row's transcript id — how a recorded sender finds its bubble. */
  eventId?: string | undefined;
  text: string;
  onOpenImage?: OpenMedia | undefined;
  hl?: readonly string[] | undefined;
}) {
  const { corpus, open, inbound } = useContext(ChatMentionContext);
  const report = parseReportMarker(text);
  const direct = report ? null : parseDirectMarker(text);
  const marker = report?.marker ?? direct?.marker;
  if (!marker) {
    // A FOURTH SHAPE, and the only one that is not in the text: a message
    // another chat DELIVERED here. It carries no marker because nothing was
    // added to it — the prompt the agent received is exactly what was sent, and
    // changing that to decorate the UI would change every worker's behaviour.
    // So the tell is a muxpad-owned row, matched to this bubble upstream.
    const fromTabId = eventId ? inbound?.get(eventId) : undefined;
    if (fromTabId) {
      // The sending chat, looked up LIVE — so a chat renamed since it sent this
      // shows its current name. Null when it has since been deleted, which the
      // card handles by dropping the link rather than the card.
      const sender = corpus.find((c) => c.tabId === fromTabId) ?? null;
      return (
        <FromAgentMessage
          from={sender}
          text={text}
          render={(t) => <UserText text={t} onOpenImage={onOpenImage} hl={hl} />}
          // `hl` is passed to the ONE row a search jump landed on and to no
          // other, so its presence IS "the hit is in this message" — and the
          // hit may well be in the part the preview cuts off.
          forceOpen={!!hl?.length}
          {...(sender ? { onOpen: () => open(sender) } : {})}
        />
      );
    }
    return (
      <div className="chat-bubble" dir="auto">
        <UserText text={text} onOpenImage={onOpenImage} hl={hl} />
      </div>
    );
  }
  // Which chat is at the other end. By pane first (durable), by name second
  // (the attribute the other agent copied), and if neither resolves, the name
  // alone still draws a card — a fresh tile and a chat you cannot click is a
  // better answer than XML.
  const other =
    corpus.find((c) => marker.pane && c.paneIds.includes(marker.pane)) ??
    corpus.find((c) => c.tabName === marker.from);
  const chip = other?.chip ?? { name: marker.from || 'another chat' };
  const body = report ? report.body : (direct?.body.trim() ?? '');
  return (
    <ChatMentionCard
      chat={chip}
      state={report ? 'reported' : 'directed here'}
      body={<MentionedText text={body} hl={hl} />}
      // No `onOpen` at all when the chat did not resolve, instead of one that
      // silently does nothing: the card is then a name and an answer, which is
      // honest. The corpus is now loaded whenever the transcript holds a card
      // (see needsCorpus), so the common unresolved case — a reload into a
      // conversation with an empty composer — no longer happens at all.
      {...(other ? { onOpen: () => open(other) } : {})}
    />
  );
}

/**
 * Prose with `@Name` runs replaced by chips.
 *
 * The chip is rendered from the CORPUS, not from the text: it carries the chat's
 * emoji and its clock, which is the whole reason a mention is worth being a chip
 * rather than bold text. An `@word` that resolves to nothing stays exactly as
 * typed — see parseMentions.
 */
function MentionedText({ text, hl }: { text: string; hl?: readonly string[] | undefined }) {
  const { corpus, open } = useContext(ChatMentionContext);
  const parts = useMemo(() => parseMentions(text, corpus), [text, corpus]);
  if (parts.length === 1 && parts[0]?.kind === 'text')
    return <HighlightedText text={text} hl={hl} />;
  return (
    <>
      {parts.map((part, i) =>
        part.kind === 'text' ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: segments have no identity of their own and the whole run is rebuilt when the text or corpus changes.
          <HighlightedText key={i} text={part.text} hl={hl} />
        ) : (
          <ChatMentionPill
            // biome-ignore lint/suspicious/noArrayIndexKey: see above — the same chat can be mentioned twice in one message.
            key={i}
            chat={part.chat.chip}
            onOpen={() => open(part.chat)}
          />
        ),
      )}
    </>
  );
}

/**
 * A folded run of consecutive actions (tool calls + thinking) — long
 * agentic stretches read as one summarizable step, not a wall of rows.
 * The header names the mix ("14 actions · Bash ×6 · Edit ×4"), flags
 * failures, and expands in place to the ordinary per-action rows.
 */
export function ActionGroup({
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
export const ChatRow = memo(function ChatRow({
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
      // A directed request and the report that answers it are REAL delivered
      // messages (muxpad never writes a transcript), so both arrive here as
      // user bubbles carrying a marker block. Rendering them as cards is not
      // decoration: without it the chat shows a wall of XML, which is what the
      // cron marker's own expander exists to prevent.
      return (
        <div className="chat-turn chat-turn-user" data-eid={anchorId} data-search-hit={found}>
          <MentionMessage eventId={event.id} text={event.text} onOpenImage={onOpenImage} hl={hl} />
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
export function UserText({
  text,
  onOpenImage,
  hl,
}: {
  text: string;
  onOpenImage?: OpenMedia | undefined;
  hl?: readonly string[] | undefined;
}) {
  const parts = splitMessageAttachments(text);
  if (parts.length === 1 && parts[0]?.kind === 'text') return <MentionedText text={text} hl={hl} />;
  return (
    <>
      {renderMessageParts(
        parts,
        (t, key) => (
          <span key={key}>
            <MentionedText text={t} hl={hl} />
          </span>
        ),
        (m) => onOpenImage?.(m),
      )}
    </>
  );
}

/**
 * THE WORKER'S WORK, inside its card.
 *
 * Rendered with `AssistantText` and not with the card's plain `body`, because a
 * research worker's final turn IS assistant prose: markdown, and
 * `/attachments/…` paths that become an inline gallery. Through the plain body it
 * would arrive as a wall of literal `##` and `-` (that path sets
 * `white-space: pre-wrap`, which actively fights a markdown renderer).
 *
 * THREE STATES AND NO FOURTH. An expansion must never open onto a blank: that
 * reads as "the work is gone" while claiming to have found it. So a pruned
 * transcript says so in words — Claude prunes its own on a retention window, and
 * the locator this uses never looks at the archive's byte copy, so an old
 * worker's expansion WILL be unreadable one day — and the card's head is still
 * the way into the chat itself.
 */
export function SpawnWorkBody({
  work,
  onOpenImage,
}: {
  /** `undefined` not asked yet, `null` in flight. */
  work: SpawnWork | null | undefined;
  onOpenImage?: OpenMedia | undefined;
}) {
  if (!work) return <span className="chat-mention-card-cut">Fetching what it said…</span>;
  if (work.kind === 'gone') {
    return <span className="chat-mention-card-cut">{work.reason}. Open the chat to look.</span>;
  }
  return (
    <>
      <AssistantText text={work.text} onOpenImage={onOpenImage} />
      {/* Never silent about a bound. A read that stops without saying so reads as
          a report that ends mid-sentence. */}
      {work.truncated ? (
        <span className="chat-mention-card-cut">
          Cut off here — open the chat for the rest of it.
        </span>
      ) : null}
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
export function ImageModal({
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: one-time listener set up on mount; every value it acts on is read through a live ref, so re-subscribing on each change would detach and reattach for nothing
  useEffect(() => {
    computeFit();
    window.addEventListener('resize', computeFit);
    return () => window.removeEventListener('resize', computeFit);
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: stable listeners driven by refs — `apply` is recreated per render and listing it would tear down and rebuild the listener set on every keystroke
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
  }, []);

  return (
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
            key={`${it.url}-${i}`}
            type="button"
            className={`chat-gallery-item${video ? ' -video' : ''}`}
            title={it.name}
            onClick={() => onOpen({ url: it.url, name: it.name, video })}
          >
            {video ? (
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
export function AgentLaunchCard({
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
export type ToolDetail = { use?: ToolUseEvent | undefined; result?: ToolResultEvent | undefined };

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
export const ToolRow = memo(function ToolRow({
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
export function RosterSpinner() {
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
export function QuestionCard({
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
export function ToolModal({ detail, onClose }: { detail: ToolDetail; onClose: () => void }) {
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
