import type { ChatEvent, NoticeEvent, ToolResultEvent, ToolUseEvent } from '@muxpad/shared';
import { type ChangeEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api } from '../api';
import { isMobileLayout } from '../lib/mobile-layout';
import './ChatPane.css';

// Assistant + streaming text is rendered as GitHub-flavored markdown. No raw
// HTML is allowed through (no rehype-raw) so user/model content can't inject
// markup — react-markdown escapes everything by default. Links open safely in
// a new tab; everything else is styled from the .chat-md-* rules in the CSS.
const MD_COMPONENTS: Components = {
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer noopener" />,
};

/** Renders (possibly partial/streaming) markdown for assistant messages. */
function Markdown({ text }: { text: string }) {
  return (
    <div className="chat-md">
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

interface SessionMeta {
  current_sid: string | null;
  writer: string;
  view_mode: string;
  assistant: string;
}

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
    }
  | { t: 'events'; phase: 'history' | 'live' | 'older'; events: ChatEvent[] }
  | { t: 'older-done'; hasMore: boolean }
  | { t: 'send-ack' }
  | { t: 'turn-start' }
  | { t: 'stream'; delta: string }
  | { t: 'turn-done'; ok: boolean; error?: string }
  | { t: 'blocked'; reason: string }
  | { t: 'error'; message: string };

/**
 * Drop transcript-confirmed assistant text from the head of the streaming
 * preview. The preview accumulates every text delta of the turn; once a
 * message lands in the transcript (rendered as a real event), its copy must
 * leave the preview or it shows twice — the "every message doubled while a
 * turn runs" bug. Deltas always precede the transcript line (same ordered
 * stdout + tail poll lag), so the landed text is a prefix of the preview.
 */
function consumeStreamedText(preview: string, landed: string[]): string {
  let p = preview;
  for (const text of landed) {
    const t = p.trimStart();
    if (t.startsWith(text)) p = t.slice(text.length);
    else if (t && text.startsWith(t.trimEnd())) p = ''; // preview lagged behind — it's all stale
  }
  return p;
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
export function ChatPane({ paneId, active }: { paneId: string; active: boolean }) {
  // undefined = still connecting; null = connected but no agent session.
  const [session, setSession] = useState<SessionMeta | null | undefined>(undefined);
  const [events, setEvents] = useState<ChatEvent[]>([]);
  // Ordered event list (source of truth for `events`). The server sends the
  // recent tail first, then older batches on demand — which must be PREPENDED,
  // so we keep an explicit array rather than relying on Map insertion order.
  const ordered = useRef<ChatEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const byId = useRef(new Set<string>()); // seen event ids, for dedupe
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);
  const wsRef = useRef<WebSocket | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
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
  // For the send↔takeover race: if a send lands before the toggle's hand-off
  // finished, we silently take over and resend the held text (once).
  const pendingText = useRef('');
  const takeoverTried = useRef(false);
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

  useEffect(() => {
    byId.current = new Set();
    ordered.current = [];
    setEvents([]);
    setSession(undefined);
    setSending(false);
    setNotice(null);
    setOptimisticUser(null);
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
      if (msg.t === 'session') {
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
          if (msg.streamText) setStreamingText(msg.streamText);
        }
      } else if (msg.t === 'events') {
        const fresh = msg.events.filter((e) => !byId.current.has(e.id));
        if (fresh.length) {
          for (const e of fresh) byId.current.add(e.id);
          // Assistant text that just landed in the transcript leaves the
          // streaming preview, or it would render twice until turn end.
          if (msg.phase === 'live') {
            const landed = fresh
              .filter((e): e is Extract<ChatEvent, { kind: 'assistant' }> => e.kind === 'assistant')
              .map((e) => e.text);
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
        setNotice(msg.ok ? null : (msg.error ?? 'turn failed'));
      } else if (msg.t === 'blocked') {
        acked.current = true;
        window.clearTimeout(sendWatchdog.current);
        // The terminal hand-off hasn't finished (raced the toggle). Silently
        // finish taking over, then resend — once — so the user never sees it.
        if (takeoverTried.current) {
          setSending(false);
          setNotice('Could not take over from the terminal — exit Claude there and retry.');
        } else {
          takeoverTried.current = true;
          setSending(true);
          fetch(`/api/agent-sessions/${paneId}/takeover`, { method: 'POST' })
            .then((r) => {
              if (r.ok && pendingText.current) {
                // Re-arm delivery tracking — this resend can die on a zombie
                // socket exactly like a composer send.
                armSendWatchdog(pendingText.current);
                wsRef.current?.send(JSON.stringify({ t: 'send', text: pendingText.current }));
              } else {
                setSending(false);
                setNotice('Could not take over from the terminal — exit Claude there and retry.');
              }
            })
            .catch(() => {
              setSending(false);
              setNotice('Could not take over from the terminal.');
            });
        }
      } else if (msg.t === 'error') {
        acked.current = true;
        window.clearTimeout(sendWatchdog.current);
        setSending(false);
        // The send was rejected — its message never reaches the transcript,
        // so the optimistic bubble would otherwise stick around forever.
        setOptimisticUser(null);
        pendingText.current = '';
        setNotice(msg.message);
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
            setNotice('Connection dropped before the message was sent — try again.');
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

    return () => {
      cancelled = true;
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
  // fires a `send` frame — the composer AND the blocked-takeover resend.
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
      setNotice('Message not delivered — reconnecting. Try again.');
      try {
        wsRef.current?.close();
      } catch {
        // already closing
      }
    }, 6000);
  };

  const sendMessage = () => {
    const text = input.trim();
    if (!text || sending) return;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      // Don't fire into a dead socket (the browser would drop it silently).
      // Keep the text in the composer, kick a reconnect, let the user retry.
      setNotice('Reconnecting — try again in a moment.');
      reconnectNow.current();
      return;
    }
    pendingText.current = text; // held for a silent takeover-and-resend if blocked
    takeoverTried.current = false;
    setOptimisticUser(text); // show it immediately, don't wait for the transcript
    ws.send(JSON.stringify({ t: 'send', text }));
    setInput('');
    setNotice(null);
    setSending(true);
    armSendWatchdog(text);
  };
  const stop = () => wsRef.current?.send(JSON.stringify({ t: 'stop' }));

  // Photo picker → upload via the same attachments endpoint the TUI composer
  // uses, then append the returned path(s) to the message so Claude reads the
  // image. accept="image/*" with no `capture` → the OS sheet offers library +
  // camera. Empty-type files (HEIC / some Android providers) are kept.
  const onPickImages = async (e: ChangeEvent<HTMLInputElement>) => {
    const el = e.target;
    const files = Array.from(el.files ?? []).filter(
      (f) => f.type === '' || f.type.startsWith('image/'),
    );
    el.value = ''; // reset so re-picking the same file still fires onChange
    if (files.length === 0) return;
    setUploading(true);
    const paths: string[] = [];
    for (const f of files) {
      try {
        const { path } = await api.uploadAttachment(paneId, f, f.name || 'image.png');
        paths.push(path);
      } catch {
        // drop this one; the rest still upload
      }
    }
    setUploading(false);
    if (paths.length === 0) return;
    setInput((prev) => `${prev}${prev && !prev.endsWith(' ') ? ' ' : ''}${paths.join(' ')} `);
    inputRef.current?.focus();
  };

  // Keep pinned to the bottom as new events arrive, unless the user scrolled up.
  // `events` is a deliberate trigger dependency (we re-scroll on new events)
  // even though the body reads it only via the DOM.
  // biome-ignore lint/correctness/useExhaustiveDependencies: events/streamingText/optimisticUser are the scroll triggers
  useEffect(() => {
    const el = scrollRef.current;
    if (el && active && pinnedToBottom.current) el.scrollTop = el.scrollHeight;
  }, [events, streamingText, optimisticUser, active]);

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
      if (openTool) return;
      const input = inputRef.current;
      if (!input || document.activeElement === input) return;
      const ae = document.activeElement as HTMLElement | null;
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable))
        return;
      input.focus(); // the character then lands in the now-focused textarea
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, openTool]);

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
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    pinnedToBottom.current = nearBottom;
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
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  };

  // Grace timer: a present session with no transcript after a while → likely ended.
  useEffect(() => {
    setStale(false);
    if (!connected || !session?.current_sid || events.length > 0) return;
    const t = setTimeout(() => setStale(true), 8000);
    return () => clearTimeout(t);
  }, [connected, session?.current_sid, events.length]);

  // Drop the optimistic user bubble once the real one lands from the transcript.
  useEffect(() => {
    if (optimisticUser && events.some((e) => e.kind === 'user' && e.text === optimisticUser)) {
      setOptimisticUser(null);
    }
  }, [events, optimisticUser]);

  const body = useMemo(() => {
    if (session === undefined)
      return (
        <div className="chat-empty">
          <div className="chat-empty-spinner" aria-hidden="true" />
          <p>{connected ? 'Loading conversation…' : 'Connecting…'}</p>
        </div>
      );
    if (session === null || !session.current_sid)
      return (
        <div className="chat-empty">
          <div className="chat-empty-mark" aria-hidden="true">
            ✳
          </div>
          <p className="chat-empty-title">No Claude session here yet</p>
          <p className="chat-empty-hint">
            Start one with <code>muxpad agent</code> (chat-native) or <code>muxpad claude</code> in
            the terminal.
          </p>
        </div>
      );
    if (events.length === 0 && !optimisticUser && !sending)
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
                <code>muxpad claude</code>.
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
    // Pair each tool_use with its tool_result (by id) so the collapsed row can
    // open both in one modal; the standalone result row is then suppressed.
    const resultFor = new Map<string, ToolResultEvent>();
    for (const e of events)
      if (e.kind === 'tool_result' && e.toolUseId) resultFor.set(e.toolUseId, e);
    const consumed = new Set<string>();
    for (const e of events)
      if (e.kind === 'tool_use') {
        const r = resultFor.get(e.toolUseId);
        if (r) consumed.add(r.id);
      }
    return (
      <>
        {loadingOlder ? (
          <div className="chat-load-earlier-spinner" aria-hidden="true">
            <div className="chat-empty-spinner" />
          </div>
        ) : null}
        {events.map((e) => {
          if (e.kind === 'tool_use')
            return (
              <ToolRow
                key={e.id}
                use={e}
                result={resultFor.get(e.toolUseId)}
                onOpen={setOpenTool}
              />
            );
          // Result already shown by its tool_use row above.
          if (e.kind === 'tool_result' && consumed.has(e.id)) return null;
          if (e.kind === 'tool_result')
            return <ToolRow key={e.id} result={e} onOpen={setOpenTool} />;
          return <ChatRow key={e.id} event={e} />;
        })}
      </>
    );
  }, [session, connected, events, stale, optimisticUser, sending, loadingOlder]);

  // The agent is working when: we're driving a turn (`sending`), tokens are
  // streaming, OR the newest event is a tool_use still awaiting its result (a
  // step is mid-run — covers between-steps gaps and opening chat on an already-
  // running turn, where there's no local `sending` flag). Self-clears when the
  // result lands or the turn ends.
  const lastEvent = events[events.length - 1];
  const pendingTool =
    lastEvent?.kind === 'tool_use' &&
    !events.some((e) => e.kind === 'tool_result' && e.toolUseId === lastEvent.toolUseId);
  const agentWorking = Boolean((sending || streamingText || pendingTool) && session?.current_sid);

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
              <div className="chat-bubble">{optimisticUser}</div>
            </div>
          ) : null}
          {agentWorking ? (
            <div className="chat-turn chat-turn-assistant">
              {streamingText ? (
                <div className="chat-msg">
                  <Markdown text={streamingText} />
                  <span className="chat-cursor" aria-hidden="true" />
                </div>
              ) : (
                <div className="chat-msg chat-working" aria-label="Claude is working">
                  <span className="chat-typing" aria-hidden="true">
                    <i />
                    <i />
                    <i />
                  </span>
                </div>
              )}
            </div>
          ) : null}
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
      {session?.current_sid ? (
        <div className="chat-composer-wrap" ref={composerRef}>
          {notice ? <div className="chat-notice">{notice}</div> : null}
          <div className="chat-composer">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={onPickImages}
            />
            <button
              type="button"
              className="chat-attach"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              aria-label="Add photo"
              title="Add photo"
            >
              {uploading ? <span className="chat-attach-spin" aria-hidden="true" /> : <SvgCamera />}
            </button>
            <textarea
              ref={inputRef}
              className="chat-input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                // Desktop: Enter sends, Shift+Enter = newline. Mobile: the
                // on-screen Return key inserts a newline (send is the button) —
                // otherwise every line break fires off a message.
                if (e.key === 'Enter' && !e.shiftKey && !isMobileLayout()) {
                  e.preventDefault();
                  sendMessage();
                }
              }}
              placeholder="Message Claude…"
              rows={1}
            />
            {sending ? (
              <button
                type="button"
                className="chat-send is-stop"
                onClick={stop}
                aria-label="Stop"
                title="Stop"
              >
                <span className="chat-send-glyph" aria-hidden="true" />
              </button>
            ) : (
              <button
                type="button"
                className="chat-send"
                onClick={sendMessage}
                disabled={!input.trim()}
                aria-label="Send"
                title="Send"
              >
                <span className="chat-send-glyph" aria-hidden="true">
                  ↑
                </span>
              </button>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ChatRow({ event }: { event: ChatEvent }) {
  switch (event.kind) {
    case 'user':
      return (
        <div className="chat-turn chat-turn-user">
          <div className="chat-bubble">{event.text}</div>
        </div>
      );
    case 'assistant':
      return (
        <div className="chat-turn chat-turn-assistant">
          <div className="chat-msg">
            <Markdown text={event.text} />
          </div>
        </div>
      );
    case 'thinking':
      return (
        <div className="chat-turn chat-turn-assistant">
          <div className="chat-thinking">{event.text}</div>
        </div>
      );
    case 'notice':
      return <NoticeCard event={event} />;
    // tool_use / tool_result are rendered as collapsed ToolRows in the body map
    // (paired into one row), never through ChatRow.
    default:
      return null;
  }
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

function summarizeToolInput(name: string, input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const o = input as Record<string, unknown>;
  const pick = (k: string) => (typeof o[k] === 'string' ? (o[k] as string) : undefined);
  return (
    pick('command') ??
    pick('file_path') ??
    pick('path') ??
    pick('pattern') ??
    pick('url') ??
    pick('description') ??
    JSON.stringify(o).slice(0, 200)
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
function ToolRow({
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
