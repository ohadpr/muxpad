/**
 * The "create a tab/pane" control: one quiet "+" that creates the house chat
 * and lands you in it. No chooser, no question — the alternatives live in the
 * new chat's own "open instead:" strip, which costs nothing until you want
 * one. (Formerly NewTabChooser, back when "+" opened a full-screen picker.)
 *
 * Styling is the caller's: both homes (sidebar tree, desktop tab strip)
 * pass their own class names so the control inherits the local chrome.
 */
export function NewTabButton({
  idleLabel,
  idleTitle,
  idleClassName,
  disabled,
  onCreate,
}: {
  idleLabel: string;
  idleTitle: string;
  idleClassName: string;
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
