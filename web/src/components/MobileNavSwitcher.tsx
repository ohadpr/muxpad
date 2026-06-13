import { useRouterState } from '@tanstack/react-router';
import { useCallback, useEffect, useState } from 'react';
import { useTabs } from '../tabs';
import { useWorkspaces } from '../workspaces';
import { NavTree } from './NavTree';
import './MobileNavSwitcher.css';

interface Props {
  activeWorkspaceSlug: string;
}

/**
 * Mobile-only chrome trigger that replaces the desktop's separate
 * WorkspaceSwitcher + TabBar with a single breadcrumb-style trigger
 * (`Workspace › Tab ▾`) opening a full-width PANEL that drops down
 * from directly under the chrome bar.
 *
 * The panel hosts the same NavTree the desktop sidebar uses — one
 * navigator, two presentations. Top-anchored so the surface visibly
 * originates from the trigger you just tapped (a bottom sheet read as
 * disconnected: tap at the top, something appears at the bottom). The
 * chrome bar stays undimmed above it, so the breadcrumb doubles as the
 * panel's anchor — tap it again to close. Replaces the old 280px
 * anchored popover, which fought the viewport for width.
 */
export function MobileNavSwitcher({ activeWorkspaceSlug }: Props) {
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);

  const { workspaces } = useWorkspaces();
  const activeWorkspace = workspaces.find((w) => w.slug === activeWorkspaceSlug);
  const { tabs: activeWorkspaceTabs } = useTabs(activeWorkspace?.id ?? '');

  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const tabMatch = pathname.match(/^\/w\/[^/]+\/t\/([^/]+)/);
  const activeTabSlug = tabMatch?.[1] ? decodeURIComponent(tabMatch[1]) : null;
  const activeTab = activeWorkspaceTabs.find((t) => t.slug === activeTabSlug);

  const close = useCallback(() => {
    // The slide-out animation's end unmounts the sheet. If the user
    // prefers reduced motion the CSS disables the animation, so there's
    // no animationend to wait for — unmount immediately.
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setOpen(false);
    } else {
      setClosing(true);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, close]);

  const anyOtherWorkspaceAttention = workspaces.some(
    (w) => w.attention && w.slug !== activeWorkspaceSlug,
  );

  const triggerLabel = activeWorkspace ? (
    <>
      <span className="mns-trigger-ws">{activeWorkspace.name}</span>
      <span className="mns-trigger-sep" aria-hidden="true">
        ›
      </span>
      <span className="mns-trigger-tab">{activeTab?.name ?? '—'}</span>
    </>
  ) : (
    'Workspaces'
  );

  return (
    <div className="mns">
      <button
        type="button"
        className="mns-trigger"
        onClick={() => (open ? close() : setOpen(true))}
        data-attention={anyOtherWorkspaceAttention ? 'true' : undefined}
        title="Switch workspace / tab"
        aria-expanded={open}
      >
        <span className="mns-trigger-label">{triggerLabel}</span>
        <span className="mns-trigger-chevron">
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
        </span>
      </button>
      {open && (
        <>
          <button
            type="button"
            className="mns-scrim"
            data-closing={closing ? 'true' : undefined}
            onClick={close}
            aria-label="Close navigator"
            tabIndex={-1}
          />
          {/* Presentational shell — the NavTree inside is the semantic
              <nav>. Not role="dialog": no focus trap / form semantics,
              just a disclosure surface dismissed via scrim or Escape. */}
          <div
            className="mns-panel"
            data-closing={closing ? 'true' : undefined}
            onAnimationEnd={(e) => {
              if (closing && e.target === e.currentTarget) {
                setOpen(false);
                setClosing(false);
              }
            }}
          >
            <NavTree
              variant="sheet"
              activeWorkspaceSlug={activeWorkspaceSlug}
              activeTabSlug={activeTabSlug}
              onNavigate={close}
            />
          </div>
        </>
      )}
    </div>
  );
}
