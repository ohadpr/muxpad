import type { ChatEvent, ToolResultEvent, ToolUseEvent } from '@muxpad/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { getPaneFace, setPaneFace } from '../lib/pane-face';
import { sendPaneInput } from '../lib/pane-input';
import './ChatPane.css';

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
  | { t: 'turn-done'; ok: boolean; error?: string }
  | { t: 'blocked'; reason: string }
  | { t: 'took-over' }
  | { t: 'error'; message: string };

/**
 * Chat view of the Claude session tracked in a pane. Connects to
 * /ws/chat/:paneId, replays the transcript as chat, then streams live turns
 * (dedupes by event id — the server may re-emit history after a compaction
 * rewrite). You can also drive the session from here: the composer runs a
 * headless turn. While a Claude TUI is driving the session, the composer is
 * blocked and offers a one-click "Take over" that stops the terminal.
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
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // Held so that if the first send is blocked by a live TUI, we can transparently
  // take over (stop the terminal) and auto-resend it — no user-facing step.
  const pendingText = useRef<string>('');

  useEffect(() => {
    byId.current = new Map();
    setEvents([]);
    setSession(undefined);
    setSending(false);
    setNotice(null);
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
      } else if (msg.t === 'turn-done') {
        setSending(false);
        setNotice(msg.ok ? null : (msg.error ?? 'turn failed'));
      } else if (msg.t === 'blocked') {
        // A Claude TUI is driving. Transparently take over (stop the terminal);
        // the pending message auto-sends on 'took-over'. Stay in the working
        // state — no CTA, the user just sees their message start.
        wsRef.current?.send(JSON.stringify({ t: 'takeover' }));
        setSending(true);
      } else if (msg.t === 'took-over') {
        const pending = pendingText.current;
        if (pending) {
          pendingText.current = '';
          wsRef.current?.send(JSON.stringify({ t: 'send', text: pending }));
          setInput('');
          setSending(true);
        } else {
          setSending(false);
        }
      } else if (msg.t === 'error') {
        setSending(false);
        // Don't lose the user's message if the hand-off failed.
        if (pendingText.current) {
          setInput(pendingText.current);
          pendingText.current = '';
        }
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
    pendingText.current = text; // kept so a take-over can auto-resend it
    wsRef.current?.send(JSON.stringify({ t: 'send', text }));
    setInput('');
    setNotice(null);
    setSending(true);
  };
  const stop = () => wsRef.current?.send(JSON.stringify({ t: 'stop' }));

  // Hand the session back to the real terminal: type `muxpad claude --resume
  // <sid>` into the pane's shell, then flip this pane's face to the terminal.
  // Safe + reliable (it's a launch, not a fragile TUI-exit). Only meaningful
  // when no claude TUI is already running the pane.
  const resumeInTerminal = async () => {
    const sid = session?.current_sid;
    if (!sid) return;
    await sendPaneInput(paneId, `muxpad claude --resume ${sid}\r`);
    setPaneFace(paneId, { face: 'terminal', url: getPaneFace(paneId).url });
  };

  // Keep pinned to the bottom as new events arrive, unless the user scrolled up.
  // `events` is a deliberate trigger dependency (we re-scroll on new events)
  // even though the body reads it only via the DOM.
  // biome-ignore lint/correctness/useExhaustiveDependencies: events is the scroll trigger
  useEffect(() => {
    const el = scrollRef.current;
    if (el && active && pinnedToBottom.current) el.scrollTop = el.scrollHeight;
  }, [events, active]);

  // Auto-grow the composer like ChatGPT: reset to content height, capped by CSS
  // max-height (the textarea keeps scrolling past that). `input` is the trigger
  // (we measure the DOM, not read it), so keep it in the dep list.
  // biome-ignore lint/correctness/useExhaustiveDependencies: input is the resize trigger
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [input]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    pinnedToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

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
    if (events.length === 0)
      return (
        <div className="chat-empty">
          <div className="chat-empty-spinner" aria-hidden="true" />
          <p>Waiting for the first message…</p>
        </div>
      );
    return events.map((e) => <ChatRow key={e.id} event={e} />);
  }, [session, connected, events]);

  return (
    <div className="chat-pane">
      <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
        <div className="chat-list">{body}</div>
      </div>
      {session?.current_sid ? (
        <div className="chat-composer-wrap">
          {notice ? <div className="chat-notice">{notice}</div> : null}
          <div className="chat-composer">
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
        {session?.current_sid ? (
          <button
            type="button"
            className="chat-resume"
            onClick={resumeInTerminal}
            title="Relaunch this session in the terminal"
          >
            Resume in terminal ▸
          </button>
        ) : null}
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
          <div className="chat-msg">{event.text}</div>
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
