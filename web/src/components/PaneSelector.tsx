import { useEffect, useRef, useState } from 'react';
import './PaneSelector.css';

export interface PaneSelectorProps {
  paneIds: string[];
  activeId: string | null;
  /** User-visible label for the pane (OSC title / fg command / "Pane N"). */
  paneLabel: (paneId: string) => string;
  onSelect: (paneId: string) => void;
  onAdd: () => void;
}

/**
 * Pane chooser for the single-pane (mobile / narrow) workspace view.
 * Always renders as a single dropdown trigger — the previous "pills
 * when they fit, dropdown when they overflow" mode was visually noisy
 * with two rows of chrome already at the top of the mobile UI. A
 * dropdown is consistent with the tab-bar collapsed mode and keeps the
 * pane row compact regardless of pane count.
 */
export function PaneSelector({ paneIds, activeId, paneLabel, onSelect, onAdd }: PaneSelectorProps) {
  const [open, setOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!dropdownRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const activeName = activeId ? paneLabel(activeId) : '—';

  return (
    <div className="pane-selector">
      <div className="pane-selector-dropdown" ref={dropdownRef}>
        <button
          type="button"
          className="pane-selector-trigger"
          onClick={() => setOpen((v) => !v)}
          title="Switch pane"
        >
          <span className="pane-selector-trigger-label">{activeName}</span>
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path
              d="M2 4 L5 7 L8 4"
              stroke="currentColor"
              strokeWidth="1.5"
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        {open && (
          <div className="pane-selector-menu" role="menu">
            {paneIds.map((id) => (
              <button
                key={id}
                type="button"
                className="pane-selector-item"
                data-active={id === activeId ? 'true' : undefined}
                onClick={() => {
                  setOpen(false);
                  onSelect(id);
                }}
              >
                {paneLabel(id)}
              </button>
            ))}
          </div>
        )}
      </div>
      {/* "+" outside the dropdown trigger so it visually + behaviourally
          mirrors the tab bar's new-tab button — single tap creates a
          pane without opening the menu. Uses the same .ws-tab-add class
          to share styling and stay in sync. */}
      <button
        type="button"
        className="ws-tab-add"
        onClick={onAdd}
        title="New pane"
        aria-label="New pane"
      >
        +
      </button>
    </div>
  );
}
