import { useEffect, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import type { Workspace } from '@muxpad/shared';

interface WorkspaceDropdownProps {
  workspaces: Workspace[];
  activeSlug: string | null;
}

export function WorkspaceDropdown({ workspaces, activeSlug }: WorkspaceDropdownProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const navigate = useNavigate();

  const active = workspaces.find((w) => w.slug === activeSlug);
  // True iff any non-active workspace is flagging attention. The dropdown
  // trigger gets a small dot in that case so the user knows there's
  // something pending behind the collapsed list.
  const anyOtherAttention = workspaces.some(
    (w) => w.attention && w.slug !== activeSlug,
  );

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
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

  return (
    <div className="ws-tabbar-dropdown" ref={ref}>
      <button
        type="button"
        className="ws-tabbar-dropdown-trigger"
        data-attention={anyOtherAttention ? 'true' : undefined}
        onClick={() => setOpen((v) => !v)}
        title="Switch workspace"
      >
        <span className="ws-tabbar-dropdown-label">{active?.name ?? 'Workspaces'}</span>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M2 4 L5 7 L8 4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="ws-tabbar-dropdown-menu" role="menu">
          {workspaces.map((w) => {
            const isActive = w.slug === activeSlug;
            return (
              <button
                key={w.id}
                type="button"
                className="ws-tabbar-dropdown-item"
                data-active={isActive ? 'true' : undefined}
                data-attention={!isActive && w.attention ? 'true' : undefined}
                onClick={() => {
                  setOpen(false);
                  if (!isActive) void navigate({ to: '/w/$slug', params: { slug: w.slug } });
                }}
              >
                <span className="ws-tabbar-dropdown-item-label">{w.name}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
