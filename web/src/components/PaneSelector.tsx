import { useEffect, useRef, useState } from 'react';
import './PaneSelector.css';

export interface PaneSelectorProps {
  paneIds: string[];
  activeId: string | null;
  /** User-visible label for the pane (OSC title / fg command / "Pane N"). */
  paneLabel: (paneId: string) => string;
  onSelect: (paneId: string) => void;
}

/**
 * Pane chooser for the single-pane (mobile / narrow) workspace view.
 * Only rendered when there's >1 pane in the active tab — the single-pane
 * case has no pane row at all, and new-pane creation lives on the tab
 * bar's "+" via a `muxpad:add-pane` event. So this component is purely
 * a switcher: dropdown trigger + menu of panes.
 */
export function PaneSelector({ paneIds, activeId, paneLabel, onSelect }: PaneSelectorProps) {
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
    </div>
  );
}
