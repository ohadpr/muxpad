import type { ChatEvent, ToolResultEvent, ToolUseEvent } from '@muxpad/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import './ChatPane.css';

interface SessionMeta {
  current_sid: string | null;
  writer: string;
  view_mode: string;
  assistant: string;
}

type ServerMsg =
  | { t: 'session'; session: (SessionMeta & Record<string, unknown>) | null }
  | { t: 'events'; phase: 'history' | 'live'; events: ChatEvent[] };

/**
 * Read-only chat view of the Claude session tracked in a pane. Connects to
 * /ws/chat/:paneId, replays the transcript as chat, then streams live turns.
 * Dedupes by event id (the server may re-emit history after a compaction
 * rewrite). Driving/switching is a later phase — this is the mobile-friendly
 * mirror of a session that's still driven from its terminal.
 */
export function ChatPane({ paneId, active }: { paneId: string; active: boolean }) {
  // undefined = still connecting; null = connected but no agent session.
  const [session, setSession] = useState<SessionMeta | null | undefined>(undefined);
  const [events, setEvents] = useState<ChatEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const byId = useRef(new Map<string, ChatEvent>());
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);

  useEffect(() => {
    byId.current = new Map();
    setEvents([]);
    setSession(undefined);
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/ws/chat/${paneId}`);
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
      }
    };
    return () => {
      ws.close();
    };
  }, [paneId]);

  // Keep pinned to the bottom as new events arrive, unless the user scrolled up.
  // `events` is a deliberate trigger dependency (we re-scroll on new events)
  // even though the body reads it only via the DOM.
  // biome-ignore lint/correctness/useExhaustiveDependencies: events is the scroll trigger
  useEffect(() => {
    const el = scrollRef.current;
    if (el && active && pinnedToBottom.current) el.scrollTop = el.scrollHeight;
  }, [events, active]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    pinnedToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  const body = useMemo(() => {
    if (session === undefined)
      return <div className="chat-empty">{connected ? 'Loading…' : 'Connecting…'}</div>;
    if (session === null || !session.current_sid)
      return (
        <div className="chat-empty">
          <p>No Claude session in this pane yet.</p>
          <p className="chat-empty-hint">
            Start one with <code>muxpad claude</code> in the terminal.
          </p>
        </div>
      );
    if (events.length === 0)
      return <div className="chat-empty">Waiting for the first message…</div>;
    return events.map((e) => <ChatRow key={e.id} event={e} />);
  }, [session, connected, events]);

  return (
    <div className="chat-pane">
      <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
        <div className="chat-list">{body}</div>
      </div>
      <div className="chat-footer">
        <span className={`chat-dot ${connected ? 'on' : 'off'}`} />
        {session?.current_sid ? (
          <span>view · driven from {session.writer === 'headless' ? 'chat' : 'terminal'}</span>
        ) : (
          <span>read-only</span>
        )}
      </div>
    </div>
  );
}

function ChatRow({ event }: { event: ChatEvent }) {
  switch (event.kind) {
    case 'user':
      return (
        <div className="chat-row user">
          <div className="chat-bubble user">{event.text}</div>
        </div>
      );
    case 'assistant':
      return (
        <div className="chat-row assistant">
          <div className="chat-bubble assistant">{event.text}</div>
        </div>
      );
    case 'thinking':
      return (
        <div className="chat-row assistant">
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
    <div className="chat-row assistant">
      <div className="chat-tool">
        <span className="chat-tool-name">{event.name || 'tool'}</span>
        <span className="chat-tool-arg">{summarizeToolInput(event.name, event.input)}</span>
      </div>
    </div>
  );
}

function ToolResultCard({ event }: { event: ToolResultEvent }) {
  return (
    <div className="chat-row assistant">
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
