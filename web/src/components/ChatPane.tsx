import type { ChatEvent, ToolResultEvent, ToolUseEvent } from '@muxpad/shared';
import { type ChangeEvent, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api } from '../api';
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
  | { t: 'session'; session: (SessionMeta & Record<string, unknown>) | null }
  | { t: 'events'; phase: 'history' | 'live'; events: ChatEvent[] }
  | { t: 'turn-start' }
  | { t: 'stream'; delta: string }
  | { t: 'turn-done'; ok: boolean; error?: string }
  | { t: 'blocked'; reason: string }
  | { t: 'error'; message: string };

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
  const [connected, setConnected] = useState(false);
  const byId = useRef(new Map<string, ChatEvent>());
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);
  const wsRef = useRef<WebSocket | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
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

  useEffect(() => {
    byId.current = new Map();
    setEvents([]);
    setSession(undefined);
    setSending(false);
    setNotice(null);
    setOptimisticUser(null);
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/ws/chat/${paneId}`);
    wsRef.current = ws;
    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    ws.onmessage = (ev) => {
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
      } else if (msg.t === 'events') {
        for (const e of msg.events) byId.current.set(e.id, e);
        setEvents(Array.from(byId.current.values()));
      } else if (msg.t === 'turn-start') {
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
        setSending(false);
        setNotice(msg.message);
      }
    };
    return () => {
      wsRef.current = null;
      ws.close();
    };
  }, [paneId]);

  const sendMessage = () => {
    const text = input.trim();
    if (!text || sending) return;
    pendingText.current = text; // held for a silent takeover-and-resend if blocked
    takeoverTried.current = false;
    setOptimisticUser(text); // show it immediately, don't wait for the transcript
    wsRef.current?.send(JSON.stringify({ t: 'send', text }));
    setInput('');
    setNotice(null);
    setSending(true);
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

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    pinnedToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
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
            Start one with <code>muxpad claude</code> in the terminal.
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
    return events.map((e) => <ChatRow key={e.id} event={e} />);
  }, [session, connected, events, stale, optimisticUser, sending]);

  return (
    <div className="chat-pane">
      <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
        <div className="chat-list">
          {body}
          {optimisticUser ? (
            <div className="chat-turn chat-turn-user">
              <div className="chat-bubble">{optimisticUser}</div>
            </div>
          ) : null}
          {(sending || streamingText) && session?.current_sid ? (
            <div className="chat-turn chat-turn-assistant">
              <div className="chat-avatar" aria-hidden="true">
                ✳
              </div>
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
      {session?.current_sid ? (
        <div className="chat-composer-wrap">
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
              disabled={sending || uploading}
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
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  sendMessage();
                }
              }}
              placeholder={sending ? 'Claude is working…' : 'Message Claude…'}
              rows={1}
              disabled={sending}
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
      <div className="chat-footer">
        <span className="chat-footer-status">
          <span className={`chat-dot ${connected ? 'on' : 'off'}`} />
          {session?.current_sid ? (
            <span>driven from {session.writer === 'headless' ? 'chat' : 'terminal'}</span>
          ) : (
            <span>read-only</span>
          )}
        </span>
      </div>
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
          <div className="chat-avatar" aria-hidden="true">
            ✳
          </div>
          <div className="chat-msg">
            <Markdown text={event.text} />
          </div>
        </div>
      );
    case 'thinking':
      return (
        <div className="chat-turn chat-turn-assistant">
          <div className="chat-gutter" aria-hidden="true" />
          <div className="chat-thinking">{event.text}</div>
        </div>
      );
    case 'tool_use':
      return <ToolUseCard event={event} />;
    case 'tool_result':
      return <ToolResultCard event={event} />;
    default:
      return null;
  }
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

function ToolUseCard({ event }: { event: ToolUseEvent }) {
  return (
    <div className="chat-turn chat-turn-assistant">
      <div className="chat-gutter" aria-hidden="true" />
      <div className="chat-tool">
        <span className="chat-tool-name">{event.name || 'tool'}</span>
        <span className="chat-tool-arg">{summarizeToolInput(event.name, event.input)}</span>
      </div>
    </div>
  );
}

function ToolResultCard({ event }: { event: ToolResultEvent }) {
  return (
    <div className="chat-turn chat-turn-assistant">
      <div className="chat-gutter" aria-hidden="true" />
      <div className={`chat-tool-result ${event.ok ? '' : 'error'}`}>
        {event.diff ? (
          <DiffView diff={event.diff} />
        ) : event.text ? (
          <pre className="chat-tool-out">{event.text.slice(0, 4000)}</pre>
        ) : (
          <span className="chat-tool-ok">{event.ok ? 'done' : 'error'}</span>
        )}
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
