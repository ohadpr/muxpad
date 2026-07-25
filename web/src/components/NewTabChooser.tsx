/**
 * The "create a tab/pane" control: one quiet "+" that always opens the
 * in-pane chooser (Claude / Codex / Cursor, with Terminal + Web view below).
 * Kind is no longer picked in the menubar.
 *
 * Styling is the caller's: both homes (sidebar tree, desktop tab strip)
 * pass their own class names so the control inherits the local chrome.
 */
export function NewTabChooser({
  idleLabel,
  idleTitle,
  idleClassName,
  disabled,
  onCreate,
}: {
  idleLabel: string;
  idleTitle: string;
  idleClassName: string;
  /** Kept for call-site compatibility; unused now that choices don't expand. */
  choicesClassName?: string;
  choiceClassName?: string;
  disabled?: boolean;
  onCreate: () => void;
}) {
  return (
    <button
      type="button"
      className={idleClassName}
      title={idleTitle}
      disabled={disabled}
      onClick={() => onCreate()}
    >
      {idleLabel}
    </button>
  );
}
