import type { AgentQuestion, ChatEvent } from '@muxpad/shared';
import { forwardRef, useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { splitMessageAttachments } from '../lib/attachments';
import './DocChat.css';

/**
 * A DELIBERATELY light chat renderer for the document surface. Unlike ChatPane
 * (a full self-contained app — model menu, status meter, queue, its own scroll
 * viewport), this is a document-native element: it renders the conversation as
 * flowing prose that grows to fit (the DOCUMENT scrolls, not the chat), hides
 * the agent's "work" (thinking / tool calls) behind an opt-in toggle, and lets
 * the caret key in and out of it like any other block.
 *
 * It speaks the same /ws/chat/:paneId protocol so the session, persistence, and
 * server-side turn machinery are identical — only the presentation is lighter.
 */

interface FocusHandle {
  focus: (edge: 'start' | 'end') => void;
}

interface Props {
  paneId: string;
  active: boolean;
  /** Caret left the chat past its top/bottom edge — move to the adjacent block. */
  onExit: (dir: 'up' | 'down') => void;
  /** Register a focuser so the document can key INTO this chat's composer. */
  registerFocus?: (h: FocusHandle | null) => void;
  /** First user message (used as the block's title before it's ever collapsed). */
  onFirstUser?: (text: string) => void;
  /** Latest assistant text — an instant summary fallback while haiku runs. */
  onLastAssistant?: (text: string) => void;
}

type PendingQuestion = { qid: string; questions: AgentQuestion[] };

export function DocChat({
  paneId,
  active,
  onExit,
  registerFocus,
  onFirstUser,
  onLastAssistant,
}: Props) {
  const [events, setEvents] = useState<ChatEvent[]>([]);
  const [stream, setStream] = useState('');
  const [running, setRunning] = useState(false);
  const [showWork, setShowWork] = useState(false);
  const [connected, setConnected] = useState(false);
  // Optimistic echo: the just-sent message shown instantly, before the server
  // round-trips it back as a committed transcript event.
  const [pending, setPending] = useState<string | null>(null);
  const [question, setQuestion] = useState<PendingQuestion | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const seen = useRef<Set<string>>(new Set());
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const firstUserSent = useRef(false);

  const mergeEvents = useCallback((batch: ChatEvent[], phase: string) => {
    setEvents((prev) => {
      if (phase === 'history') {
        seen.current = new Set(batch.map((e) => e.id));
        return batch;
      }
      const add = batch.filter((e) => !seen.current.has(e.id));
      for (const e of add) seen.current.add(e.id);
      return phase === 'older' ? [...add, ...prev] : [...prev, ...add];
    });
    // A committed user message means our optimistic echo can drop.
    if (batch.some((e) => e.kind === 'user')) setPending(null);
  }, []);

  useEffect(() => {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/ws/chat/${paneId}`);
    wsRef.current = ws;
    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    ws.onmessage = (ev) => {
      let m: Record<string, unknown>;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      switch (m.t) {
        case 'session':
          if (m.turnRunning) setRunning(true);
          if (typeof m.streamText === 'string') setStream(m.streamText);
          if (m.question) setQuestion(m.question as PendingQuestion);
          break;
        case 'events':
          mergeEvents((m.events as ChatEvent[]) ?? [], m.phase as string);
          break;
        case 'turn-start':
          setRunning(true);
          setStream('');
          break;
        case 'stream':
          setStream((s) => s + (m.delta as string));
          break;
        case 'turn-done':
          setRunning(false);
          setStream(''); // committed assistant event arrives via an `events` frame
          break;
        case 'question':
          setQuestion({ qid: m.qid as string, questions: m.questions as AgentQuestion[] });
          break;
        case 'question-done':
          setQuestion((q) => (q?.qid === m.qid ? null : q));
          break;
      }
    };
    const ping = setInterval(() => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: 'ping' }));
    }, 20_000);
    return () => {
      clearInterval(ping);
      ws.close();
      wsRef.current = null;
    };
  }, [paneId, mergeEvents]);

  // Surface the first user line (title) and the latest assistant line (instant
  // summary fallback) up to the owning block.
  useEffect(() => {
    if (!firstUserSent.current) {
      const firstUser = events.find((e) => e.kind === 'user');
      if (firstUser && 'text' in firstUser) {
        firstUserSent.current = true;
        onFirstUser?.(firstUser.text);
      }
    }
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e && e.kind === 'assistant') {
        onLastAssistant?.(e.text);
        break;
      }
    }
  }, [events, onFirstUser, onLastAssistant]);

  useEffect(() => {
    if (registerFocus) {
      registerFocus({ focus: () => composerRef.current?.focus() });
      return () => registerFocus(null);
    }
  }, [registerFocus]);

  // Keep the tail in view while a turn streams (gentle: 'nearest' won't yank the
  // page when the latest content is already visible).
  // biome-ignore lint/correctness/useExhaustiveDependencies: stream/events/question are the scroll triggers
  useEffect(() => {
    if (active && (running || pending)) endRef.current?.scrollIntoView({ block: 'nearest' });
  }, [stream, events.length, question, running, pending, active]);

  const send = useCallback(
    (text: string) => {
      const ws = wsRef.current;
      if (!text.trim() || !ws || ws.readyState !== ws.OPEN) return;
      ws.send(JSON.stringify({ t: 'send', text }));
      setPending(text);
      if (!firstUserSent.current) {
        firstUserSent.current = true;
        onFirstUser?.(text);
      }
    },
    [onFirstUser],
  );

  const stop = useCallback(() => {
    wsRef.current?.send(JSON.stringify({ t: 'stop' }));
  }, []);

  const hasWork = events.some(
    (e) => e.kind === 'thinking' || e.kind === 'tool_use' || e.kind === 'tool_result',
  );

  const answer = useCallback((q: PendingQuestion, questionText: string, label: string) => {
    wsRef.current?.send(
      JSON.stringify({
        t: 'answer',
        qid: q.qid,
        answers: q.questions.map((qq) => ({
          question: qq.question,
          answers: qq.question === questionText ? [label] : [],
        })),
      }),
    );
    setQuestion((cur) => (cur?.qid === q.qid ? null : cur));
  }, []);

  return (
    <div className="doc-chat">
      <div className="doc-chat-log">
        {events.length === 0 && !stream && !pending ? (
          <div className="doc-chat-hint">Ask anything — the reply lands here.</div>
        ) : null}
        {events.map((e) => {
          const el = renderEvent(e, showWork);
          return el ? <div key={e.id}>{el}</div> : null;
        })}
        {pending ? (
          <div className="doc-chat-msg doc-chat-user">{renderRich(pending, false)}</div>
        ) : null}
        {stream ? (
          <div className="doc-chat-msg doc-chat-assistant">
            {renderRich(stream, true)}
            <span className="doc-chat-caret" />
          </div>
        ) : running ? (
          <div className="doc-chat-thinking-dot">…</div>
        ) : null}

        {question ? (
          <div className="doc-chat-question">
            {question.questions.map((q) => (
              <div key={q.question} className="doc-chat-q">
                <div className="doc-chat-q-text">{q.question}</div>
                <div className="doc-chat-q-opts">
                  {q.options.map((o) => (
                    <button
                      key={o.label}
                      type="button"
                      className="doc-chat-q-opt"
                      title={o.description}
                      onClick={() => answer(question, q.question, o.label)}
                    >
                      {o.label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : null}
        <div ref={endRef} />
      </div>

      <div className="doc-chat-composer-wrap">
        <Composer
          ref={composerRef}
          disabled={!connected}
          onSend={send}
          onExit={onExit}
          active={active}
        />
        <span className="doc-chat-send-hint" aria-hidden="true">
          ⏎
        </span>
      </div>

      <div className="doc-chat-foot">
        {/* Only offer "show work" when there's actually hidden work (thinking /
            tool calls) — otherwise the toggle looks broken (nothing to reveal). */}
        {hasWork ? (
          <button
            type="button"
            className="doc-chat-work-toggle"
            onClick={() => setShowWork((v) => !v)}
          >
            {showWork ? 'hide work' : 'show work'}
          </button>
        ) : null}
        {running ? (
          <button type="button" className="doc-chat-stop" onClick={stop}>
            ■ stop
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** Render one transcript event, or null to omit it. "Work" (thinking + tool
 *  calls) is hidden unless the reader opts in — the deliverable is the prose. */
function renderEvent(e: ChatEvent, showWork: boolean): JSX.Element | null {
  switch (e.kind) {
    case 'user':
      return <div className="doc-chat-msg doc-chat-user">{renderRich(e.text, false)}</div>;
    case 'assistant':
      return <div className="doc-chat-msg doc-chat-assistant">{renderRich(e.text, true)}</div>;
    case 'notice':
      return <div className="doc-chat-notice">{e.text}</div>;
    case 'thinking':
      return showWork ? <div className="doc-chat-work">💭 {e.text}</div> : null;
    case 'tool_use':
      return showWork ? <div className="doc-chat-work">⚙ {e.name}</div> : null;
    case 'tool_result':
      return showWork ? <div className="doc-chat-work">{e.ok ? '✓' : '✗'} tool result</div> : null;
    default:
      return null;
  }
}

/** Prose with inline image/file attachments. Assistant text renders as markdown
 *  (bold/lists/code/tables); user text stays literal. */
function renderRich(text: string, asMarkdown: boolean): JSX.Element {
  const parts = splitMessageAttachments(text);
  return (
    <>
      {parts.map((p, i) => {
        if (p.kind === 'text') {
          return asMarkdown ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: stable positional split of one immutable message
            <ReactMarkdown key={`t${i}`} remarkPlugins={[remarkGfm]}>
              {p.text}
            </ReactMarkdown>
          ) : (
            // biome-ignore lint/suspicious/noArrayIndexKey: stable positional split of one immutable message
            <span key={`t${i}`}>{p.text}</span>
          );
        }
        if (p.kind === 'media' && p.media === 'image')
          return <img key={p.name} className="doc-chat-img" src={p.url} alt={p.name} />;
        return (
          <a key={p.name} className="doc-chat-file" href={p.url} target="_blank" rel="noreferrer">
            {p.name}
          </a>
        );
      })}
    </>
  );
}

/** A one-line-growing composer. Enter sends; Shift+Enter newlines; ArrowUp at the
 *  very start / ArrowDown at the very end key out to the adjacent block. */
const Composer = forwardRef<
  HTMLTextAreaElement,
  {
    disabled: boolean;
    onSend: (text: string) => void;
    onExit: (dir: 'up' | 'down') => void;
    active: boolean;
  }
>(function Composer({ disabled, onSend, onExit, active }, ref) {
  const grow = (el: HTMLTextAreaElement) => {
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  };
  return (
    <textarea
      ref={ref}
      className="doc-chat-composer"
      placeholder={disabled ? 'connecting…' : 'Message…'}
      rows={1}
      disabled={disabled}
      onInput={(e) => grow(e.currentTarget)}
      onKeyDown={(e) => {
        const el = e.currentTarget;
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          const text = el.value.trim();
          if (text) {
            onSend(text);
            el.value = '';
            el.style.height = 'auto';
          }
          return;
        }
        const caret = el.selectionStart ?? 0;
        const collapsed = caret === (el.selectionEnd ?? caret);
        if (e.key === 'ArrowUp' && collapsed && caret === 0) {
          e.preventDefault();
          onExit('up');
        } else if (e.key === 'ArrowDown' && collapsed && caret === el.value.length) {
          e.preventDefault();
          onExit('down');
        }
      }}
      // biome-ignore lint/a11y/noAutofocus: expanding a chat block should land the caret in it
      autoFocus={active}
    />
  );
});
