import type { ChatAction } from '@muxpad/shared';
import { useState } from 'react';
import { type ActionRun, runSummary } from '../lib/action-runs';
import './ActionCard.css';
import { ActionCard } from './ActionCard';

/**
 * A RUN OF READS, AS ONE ROW.
 *
 * Fifteen cards, each saying it had searched for something, with the answer to
 * the question below all of them — "this can easily become overwhelming", and
 * the right comparison was already on screen two rows up: the tool calls were
 * folded into `5 actions · Bash ×5`.
 *
 * So this borrows that fold's shape deliberately rather than inventing a
 * second one. The difference the reader asked for is a MARK: these are not
 * Bash, they are calls out of this machine into something of yours, and the
 * glyph is what says so at a glance. The reasoning for which acts may fold at
 * all is in lib/action-runs — writes never do.
 */
export function ActionRunCard({ run }: { run: ActionRun }) {
  const [expanded, setExpanded] = useState(false);
  const failed = run.actions.filter((a: ChatAction) => a.state === 'failed').length;
  return (
    <div className="chat-msg chat-action-group action-run">
      <button
        type="button"
        className="chat-action-group-head"
        aria-expanded={expanded}
        onClick={() => setExpanded((o) => !o)}
      >
        <span
          className={`chat-action-group-chevron${expanded ? ' is-open' : ''}`}
          aria-hidden="true"
        >
          ›
        </span>
        {/* THE MARK. A fold that looks exactly like the Bash fold says these
            are the same kind of thing, and they are not: a tool call stays on
            this machine, and every one of these left it. */}
        <span className="action-run__mark" aria-hidden="true">
          <ConnectorGlyph />
        </span>
        <span className="chat-action-group-count">{runSummary(run)}</span>
        {failed > 0 ? <span className="chat-action-group-failed">{failed} failed</span> : null}
      </button>
      {expanded ? (
        <div className="action-run__list">
          {run.actions.map((a) => (
            <ActionCard key={a.id} action={a} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** An inert local glyph — an outward arrow leaving a tray. */
function ConnectorGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" role="img" aria-label="connector">
      <path
        d="M2 9.5v3A1.5 1.5 0 0 0 3.5 14h9a1.5 1.5 0 0 0 1.5-1.5v-3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <path
        d="M8 1.8v7.4M5.2 6.4 8 9.2l2.8-2.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
