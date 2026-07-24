import { useRef, useState } from 'react';
import { AGENT_BACKENDS, type AgentBackendId } from '../lib/agent-backend';
import { useDismissable } from '../lib/use-dismissable';
import { AgentBackendLogo } from './AgentLogos';

/**
 * The "create a tab/pane" control: ONE quiet trigger at rest that expands
 * IN PLACE. Two levels:
 *   1. Terminal · Agent          — the kind of pane.
 *   2. (under Agent) the harness  — Claude · Codex · Cursor, each with its
 *      brand mark, since which agent CLI drives the session is a real choice
 *      now, not a hidden default.
 *
 * Keeping the harness picker one step in (rather than four flat buttons) keeps
 * the common case — "new terminal" / "new agent" — a single glance, and only
 * surfaces the harness logos once you've committed to an agent. Escape or a
 * click elsewhere collapses; the leading ‹ steps back from harness to kind.
 *
 * Styling is the caller's: both homes (sidebar tree, desktop tab strip) pass
 * their own class names so the control inherits the local chrome.
 */
type Stage = 'closed' | 'kind' | 'agent';

export function NewTabChooser({
  idleLabel,
  idleTitle,
  idleClassName,
  choicesClassName,
  choiceClassName,
  disabled,
  onCreate,
}: {
  idleLabel: string;
  idleTitle: string;
  idleClassName: string;
  choicesClassName: string;
  choiceClassName: string;
  disabled?: boolean;
  onCreate: (kind: 'terminal' | 'agent', backend?: AgentBackendId) => void;
}) {
  const [stage, setStage] = useState<Stage>('closed');
  const ref = useRef<HTMLDivElement | null>(null);
  useDismissable(stage !== 'closed', ref, () => setStage('closed'));

  if (stage === 'closed') {
    return (
      <button
        type="button"
        className={idleClassName}
        title={idleTitle}
        disabled={disabled}
        onClick={() => setStage('kind')}
      >
        {idleLabel}
      </button>
    );
  }

  const pick = (kind: 'terminal' | 'agent', backend?: AgentBackendId) => {
    setStage('closed');
    onCreate(kind, backend);
  };
  const logoBtnStyle = { display: 'inline-flex', alignItems: 'center', gap: '6px' } as const;

  return (
    <div className={choicesClassName} ref={ref}>
      {stage === 'kind' ? (
        <>
          <button
            type="button"
            className={choiceClassName}
            disabled={disabled}
            onClick={() => pick('terminal')}
          >
            Terminal
          </button>
          <button
            type="button"
            className={choiceClassName}
            disabled={disabled}
            onClick={() => setStage('agent')}
          >
            Agent
          </button>
        </>
      ) : (
        <>
          <button
            type="button"
            className={choiceClassName}
            title="Back"
            aria-label="Back to Terminal / Agent"
            onClick={() => setStage('kind')}
          >
            ‹
          </button>
          {AGENT_BACKENDS.map((b) => (
            <button
              key={b.id}
              type="button"
              className={choiceClassName}
              style={logoBtnStyle}
              disabled={disabled}
              title={`New ${b.label} agent`}
              onClick={() => pick('agent', b.id)}
            >
              <AgentBackendLogo backend={b.id} size={14} />
              {b.label}
            </button>
          ))}
        </>
      )}
    </div>
  );
}
