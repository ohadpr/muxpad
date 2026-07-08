import { useEffect, useRef, useState } from 'react';
import './NewKindMenu.css';

export type NewKind = 'terminal' | 'agent';

/**
 * The one "+" control for creating things: a small menu offering the kinds a
 * container can hold — a Terminal or a chat-native ✳ Agent. Used by the
 * sidebar (new tab in a workspace) and the pane strip (new pane in a tab), so
 * every creation surface offers the same choices.
 *
 * The list renders position:fixed at coordinates measured from the trigger —
 * both hosts are scroll/overflow containers that would clip an absolutely-
 * positioned child. Scrolling or resizing while open just closes it.
 */
export function NewKindMenu({
  className,
  label,
  title,
  disabled,
  onPick,
}: {
  /** Class for the trigger button (host-specific styling). */
  className: string;
  /** Trigger content, e.g. "+" or "+ New tab". */
  label: string;
  title: string;
  disabled?: boolean | undefined;
  onPick: (kind: NewKind) => void;
}) {
  const [menuAt, setMenuAt] = useState<{ top: number; left: number } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!menuAt) return;
    const close = () => setMenuAt(null);
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey);
    // The fixed coords go stale if anything scrolls/resizes — just close.
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [menuAt]);

  const toggle = () => {
    if (menuAt) {
      setMenuAt(null);
      return;
    }
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setMenuAt({ top: rect.bottom + 4, left: rect.left });
  };

  const pick = (kind: NewKind) => {
    setMenuAt(null);
    onPick(kind);
  };

  return (
    <div className="new-kind-menu" ref={wrapRef}>
      <button
        ref={triggerRef}
        type="button"
        className={className}
        title={title}
        aria-label={title}
        aria-haspopup="menu"
        aria-expanded={menuAt !== null}
        disabled={disabled}
        onClick={toggle}
      >
        {label}
      </button>
      {menuAt ? (
        <div
          className="new-kind-menu-list"
          role="menu"
          style={{ top: menuAt.top, left: menuAt.left }}
        >
          <button type="button" role="menuitem" onClick={() => pick('terminal')}>
            Terminal
          </button>
          <button type="button" role="menuitem" onClick={() => pick('agent')}>
            <span aria-hidden="true">✳ </span>Agent
          </button>
        </div>
      ) : null}
    </div>
  );
}
