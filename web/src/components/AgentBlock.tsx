import { attachmentKind } from '@muxpad/shared';
import { useCallback, useEffect, useRef, useState } from 'react';

/** One-line, markdown-stripped snippet for the instant collapse fallback. */
function snippet(text: string): string {
  const s = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*|__|\*|_|#/g, '')
    .replace(/^\s*[-*>]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > 180 ? `${s.slice(0, 180)}…` : s;
}
import { api } from '../api';
import { attachmentUrl } from '../lib/attachments';
import type { AgentBlock as AgentBlockModel } from '../lib/doc-store';
import { DocChat } from './DocChat';
import './AgentBlock.css';

interface Props {
  block: AgentBlockModel;
  /** Is the whole document surface visible (drives autofocus on expand). */
  docActive: boolean;
  onChange: (patch: Partial<AgentBlockModel>) => void;
  onRemove: () => void;
  /** Caret keyed out past this block's edge — move to the adjacent block. */
  onExit: (dir: 'up' | 'down') => void;
  /** Register a focuser so the document can key INTO this block. */
  registerFocuser: (fn: ((edge: 'start' | 'end') => void) | null) => void;
}

/**
 * An agent conversation embedded in a document as a collapsible block. Expanded,
 * it's a light document-native chat (see DocChat) backed by a persistent
 * server-side session. Collapsed, it's a DELIVERABLE card — the question as a
 * title, a one-line summary, and artifact chips — so you're never forced to
 * re-read a wall of chat to know what you got.
 */
export function AgentBlock({
  block,
  docActive,
  onChange,
  onRemove,
  onExit,
  registerFocuser,
}: Props) {
  const expanded = !block.collapsed;
  const [summarizing, setSummarizing] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const chatFocus = useRef<((edge: 'start' | 'end') => void) | null>(null);
  // Latest assistant line, kept live so collapse can show an INSTANT deliverable
  // while the (slower) cheap-model summary is generated.
  const lastAssistant = useRef('');

  const collapse = useCallback(async () => {
    if (block.collapsed) return;
    // Instant fallback: the last assistant line, lightly de-marked. Replaced by
    // the haiku summary the moment it returns — so the card is never blank.
    const instant = snippet(lastAssistant.current);
    onChange({ collapsed: true, ...(instant ? { summary: instant } : {}) });
    setSummarizing(true);
    try {
      const { summary, title, artifacts } = await api.summarizePane(block.paneId);
      onChange({
        ...(summary ? { summary } : {}),
        ...(title ? { title } : {}),
        artifacts,
      });
    } catch {
      // best-effort — keep whatever summary we had
    } finally {
      setSummarizing(false);
    }
  }, [block.collapsed, block.paneId, onChange]);

  const expand = useCallback(() => {
    if (block.collapsed) onChange({ collapsed: false });
  }, [block.collapsed, onChange]);

  // Register how the document keys INTO this block: the composer when open, the
  // header toggle when collapsed (Enter there expands).
  useEffect(() => {
    registerFocuser((edge) => {
      if (expanded && chatFocus.current) chatFocus.current(edge);
      else toggleRef.current?.focus();
    });
    return () => registerFocuser(null);
  }, [expanded, registerFocuser]);

  return (
    <div className={`agent-block ${expanded ? 'is-expanded' : 'is-collapsed'}`}>
      <div className="agent-block-head">
        <button
          ref={toggleRef}
          type="button"
          className="agent-block-toggle"
          aria-label={expanded ? 'Collapse' : 'Expand'}
          onClick={() => (expanded ? void collapse() : expand())}
          onKeyDown={(e) => {
            // Collapsed, the block is one atomic line: arrows move past it.
            if (expanded) return;
            if (e.key === 'ArrowUp') {
              e.preventDefault();
              onExit('up');
            } else if (e.key === 'ArrowDown') {
              e.preventDefault();
              onExit('down');
            }
          }}
        >
          <span className="agent-block-chevron">{expanded ? '▾' : '▸'}</span>
          {expanded ? (
            // Expanded: a neutral label — the question already shows as the first
            // message in the transcript, so repeating it here reads as a bug.
            <span className="agent-block-label">✦ AI</span>
          ) : (
            // Collapsed: the transcript is hidden, so the question IS the title.
            <span className="agent-block-title">{block.title || 'Ask AI'}</span>
          )}
        </button>
        <div className="agent-block-head-actions">
          {summarizing ? <span className="agent-block-summarizing">summarizing…</span> : null}
          <button
            type="button"
            className="agent-block-remove"
            aria-label="Remove block"
            onClick={onRemove}
            title="Remove this agent block"
          >
            ✕
          </button>
        </div>
      </div>

      {expanded ? (
        <div
          className="agent-block-chat"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              void collapse();
            }
          }}
        >
          <DocChat
            paneId={block.paneId}
            active={docActive}
            onExit={onExit}
            registerFocus={(h) => {
              chatFocus.current = h ? h.focus : null;
            }}
            onFirstUser={(text) => {
              if (!block.title) onChange({ title: text.replace(/\s+/g, ' ').trim().slice(0, 80) });
            }}
            onLastAssistant={(text) => {
              lastAssistant.current = text;
            }}
          />
        </div>
      ) : (
        <button type="button" className="agent-block-summary" onClick={expand}>
          {block.summary ? (
            <span className="agent-block-summary-text">{block.summary}</span>
          ) : (
            <span className="agent-block-summary-empty">
              No summary yet — open to continue the conversation.
            </span>
          )}
          {block.artifacts.length > 0 ? (
            <span className="agent-block-artifacts">
              {block.artifacts.map((name) => {
                const url = attachmentUrl(name);
                const kind = attachmentKind(name);
                return kind === 'image' ? (
                  <img key={name} className="agent-block-artifact-thumb" src={url} alt={name} />
                ) : (
                  <span key={name} className="agent-block-artifact-chip" title={name}>
                    {kind === 'video' ? '▶ ' : '📄 '}
                    {name}
                  </span>
                );
              })}
            </span>
          ) : null}
        </button>
      )}
    </div>
  );
}
