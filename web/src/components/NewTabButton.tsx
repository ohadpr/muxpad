/**
 * The "create a tab/pane" control: one quiet "+" that creates a new Chat
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
  expanded,
  onCreate,
}: {
  idleLabel: string;
  idleTitle: string;
  idleClassName: string;
  disabled?: boolean;
  /** Set only where the button opens something instead of creating outright —
   *  the sidebar's flat view, where it asks which workspace first. Omitted
   *  everywhere else, so a button that simply creates makes no claim to
   *  control a disclosure. */
  expanded?: boolean;
  onCreate: () => void;
}) {
  return (
    <button
      type="button"
      className={idleClassName}
      title={idleTitle}
      disabled={disabled}
      {...(expanded === undefined ? {} : { 'aria-expanded': expanded })}
      onClick={() => onCreate()}
    >
      {idleLabel}
    </button>
  );
}
