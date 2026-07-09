import { useEffect, useRef, useState } from 'react';

/**
 * The "create a tab/pane" control: ONE quiet trigger at rest that expands
 * IN PLACE into two identically-styled kind choices (Terminal / Agent).
 *
 * This shape survived several rejected iterations: a floating popup menu
 * (extra hop, mixed icon/no-icon rows), bare +/✳ glyphs (cryptic), and a
 * standing pair of labeled chips (two controls under every workspace, and
 * the mismatched icons made them read as unrelated actions). One control
 * at rest keeps the chrome quiet; the kind labels exist only for the
 * moment of choice, styled the same, so both clearly read as flavors of
 * the same "new" action. Escape or clicking elsewhere collapses.
 *
 * Styling is the caller's: both homes (sidebar tree, desktop tab strip)
 * pass their own class names so the control inherits the local chrome.
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
  useEffect(() => {
    if (!choosing) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setChoosing(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setChoosing(false);
    };
    document.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [choosing]);
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
        onClick={() => pick('agent')}
      >
        Agent
      </button>
    </div>
  );
}
