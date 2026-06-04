import { useEffect, useRef, useState } from 'react';
import './PaneSelector.css';

export interface PaneSelectorProps {
  paneIds: string[];
  activeId: string | null;
  /** User-visible label for the pane (OSC title / fg command / "Pane N"). */
  paneLabel: (paneId: string) => string;
  /** Whether the pane has rung BEL since last interaction. */
  paneAttention: (paneId: string) => boolean;
  onSelect: (paneId: string) => void;
}

/**
 * Pane chooser for the single-pane (mobile / narrow) workspace view.
 * Only rendered when there's >1 pane in the active tab — the single-pane
 * case has no pane row at all, and new-pane creation lives on the tab
 * bar's "+" via a `muxpad:add-pane` event. So this component is purely
 * a switcher: dropdown trigger + menu of panes.
 */
export function PaneSelector({
  paneIds,
  activeId,
  paneLabel,
  paneAttention,
  onSelect,
}: PaneSelectorProps) {
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
  // How many *other* panes are flagging attention. Same chevron-pill
  // pattern as TabBarDropdown / WorkspaceSwitcher — signal lives on the
  // chevron ("more inside"), not on the trigger label.
  const otherAttentionCount = paneIds.reduce(
    (n, id) => (paneAttention(id) && id !== activeId ? n + 1 : n),
    0,
  );

  return (
    <div className="pane-selector">
      <div className="pane-selector-dropdown" ref={dropdownRef}>
        <button
          type="button"
          className="pane-selector-trigger"
          onClick={() => setOpen((v) => !v)}
          title={
            otherAttentionCount > 0
              ? `${otherAttentionCount} other ${otherAttentionCount === 1 ? 'pane needs' : 'panes need'} attention`
              : 'Switch pane'
          }
        >
          <span className="pane-selector-trigger-label">{activeName}</span>
          <span
            className="pane-selector-chevron"
            data-attention={otherAttentionCount > 0 ? 'true' : undefined}
          >
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
            {otherAttentionCount > 0 && (
              <span
                className="pane-selector-count"
                aria-label={`${otherAttentionCount} other ${otherAttentionCount === 1 ? 'pane needs' : 'panes need'} attention`}
              >
                {otherAttentionCount}
              </span>
            )}
          </span>
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
                <span className="pane-selector-item-label">
                  <span className="pane-selector-item-label-text">{paneLabel(id)}</span>
                  {paneAttention(id) && (
                    // Render on the active row too — visiting a pane
                    // doesn't auto-clear its own attention; the dot is a
                    // real signal that something inside still wants you.
                    <span className="badge-dot -inline" aria-label="needs attention" />
                  )}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
