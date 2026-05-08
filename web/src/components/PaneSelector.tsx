import { useEffect, useRef, useState } from 'react';
import { useHorizontalOverflow } from '../use-overflow';
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
 * Renders as a horizontal strip of buttons by default; collapses to a
 * single dropdown trigger when the strip would overflow horizontally.
 *
 * Mirrors the tab-bar dropdown collapse so behavior is consistent
 * across "too many things to fit in a row".
 */
export function PaneSelector({ paneIds, activeId, paneLabel, onSelect, onAdd }: PaneSelectorProps) {
  const { ref, overflowing } = useHorizontalOverflow<HTMLDivElement>([paneIds.length]);
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
      <div className="pane-selector-strip" ref={ref} data-collapsed={overflowing ? 'true' : undefined}>
        {paneIds.map((id) => (
          <button
            key={id}
            type="button"
            className="mobile-tab"
            data-active={id === activeId}
            onClick={() => onSelect(id)}
          >
            {paneLabel(id)}
          </button>
        ))}
        <button
          type="button"
          className="mobile-tab mobile-tab-add"
          onClick={onAdd}
          title="New pane"
          aria-label="New pane"
        >
          +
        </button>
      </div>
      {overflowing && (
        <div className="pane-selector-dropdown" ref={dropdownRef}>
          <button
            type="button"
            className="pane-selector-trigger"
            onClick={() => setOpen((v) => !v)}
            title="Switch pane"
          >
            <span className="pane-selector-trigger-label">{activeName}</span>
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <path d="M2 4 L5 7 L8 4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
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
              <button
                type="button"
                className="pane-selector-item pane-selector-item-add"
                onClick={() => {
                  setOpen(false);
                  onAdd();
                }}
              >
                + New pane
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
