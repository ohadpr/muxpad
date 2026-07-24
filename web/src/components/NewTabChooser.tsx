import { useRef, useState } from 'react';
import { useDismissable } from '../lib/use-dismissable';

/**
 * The "create a tab/pane" control: ONE quiet trigger at rest that expands in
 * place into Terminal · Agent. Picking Agent creates a chat pane with NO harness
 * chosen yet — the harness picker (Claude / Codex / Cursor) lives INSIDE the
 * agent chat's empty state, not here, so the tab bar stays two choices.
 *
 * Styling is the caller's: both homes (sidebar tree, desktop tab strip) pass
 * their own class names so the control inherits the local chrome.
 */
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
  onCreate: (kind: 'terminal' | 'agent') => void;
}) {
  const [choosing, setChoosing] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useDismissable(choosing, ref, () => setChoosing(false));

  if (!choosing) {
    return (
      <button
        type="button"
        className={idleClassName}
        title={idleTitle}
        disabled={disabled}
        onClick={() => setChoosing(true)}
      >
        {idleLabel}
      </button>
    );
  }
  const pick = (kind: 'terminal' | 'agent') => {
    setChoosing(false);
    onCreate(kind);
  };
  return (
    <div className={choicesClassName} ref={ref}>
      <button type="button" className={choiceClassName} disabled={disabled} onClick={() => pick('terminal')}>
        Terminal
      </button>
      <button type="button" className={choiceClassName} disabled={disabled} onClick={() => pick('agent')}>
        Agent
      </button>
    </div>
  );
}
