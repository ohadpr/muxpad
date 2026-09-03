import { type PaneStatus, rollupStatus } from '@muxpad/shared';
import { useRouterState } from '@tanstack/react-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { announceOverlayOpen, onOtherOverlayOpen } from '../lib/overlays';
import { useTabs } from '../tabs';
import { useWorkspaces, visibleWorkspaces } from '../workspaces';
import { NavTree } from './NavTree';
import { StatusMark } from './StatusMark';
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
  const panelRef = useRef<HTMLDivElement | null>(null);

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

  // Top-bar overlays are mutually exclusive: announce when we open (closing any
  // other, e.g. the pane face menu) and close if a different one opens. Stops
  // the two dropdowns from ever stacking / hiding under each other.
  useEffect(() => {
    if (!open) return;
    announceOverlayOpen('nav-sheet');
    return onOtherOverlayOpen('nav-sheet', close);
  }, [open, close]);

  // On open, focus the tree on where you ARE: scroll the active tab into view
  // (its workspace expands by default), falling back to the active workspace
  // row if its tabs are collapsed. Two rAFs so the panel has mounted and laid
  // out; instant scroll so it doesn't fight the slide-in animation.
  useEffect(() => {
    if (!open) return;
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        const panel = panelRef.current;
        const target =
          panel?.querySelector('.navtree-tab-row[data-active="true"]') ??
          panel?.querySelector('[data-active="true"]');
        target?.scrollIntoView({ block: 'center', behavior: 'auto' });
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [open]);

  // What the CLOSED trigger says about everything it's hiding. It used to carry
  // exactly one bit — "attention in some OTHER workspace" — rendered as a
  // chevron recolour, so mobile chrome could not tell you that anything was
  // working anywhere (D10). It now shows the same status rail as every other
  // surface, rolled up across other workspaces AND the other tabs of this one
  // (both are folded away behind this single control).
  //
  // Server-computed `status` is what makes this possible at all: a collapsed
  // workspace has nothing mounted to observe its tabs, which is precisely why
  // the old signal was limited to the one flag the workspace list carried.
  //
  // FIVE states, not three. This used to test for 'blocked' and 'working' by
  // hand and let everything else fall through to 'idle' — so a DEAD runner
  // (restarts exhausted) and a DONE-but-unread turn both rendered as "nothing
  // happening", and the trigger showed no mark at all for a pane that had
  // crashed. Fold through the shared rollup instead, so this control speaks
  // the same vocabulary as every other surface and can never silently
  // re-collapse when a status is added.
  // Hidden system containers are excluded: the apps container holds long-lived
  // server panes whose pty output makes them read as `working` forever, so the
  // breadcrumb would announce "1 working elsewhere" while the panel it opens
  // shows nothing — the tree it lists is already filtered.
  const elsewhere = [
    ...visibleWorkspaces(workspaces).filter((w) => w.slug !== activeWorkspaceSlug),
    ...activeWorkspaceTabs.filter((t) => t.slug !== activeTabSlug),
  ];
  const triggerStatus = rollupStatus(
    elsewhere.map(
      (x): PaneStatus =>
        // `attention` is the raw BEL bit an older server sends without `status`.
        x.attention === true ? 'blocked' : (x.status ?? 'idle'),
    ),
  );
  const counts = (s: PaneStatus) =>
    elsewhere.filter((x) => (x.attention === true ? 'blocked' : (x.status ?? 'idle')) === s).length;
  const triggerTitle =
    triggerStatus === 'blocked'
      ? `${counts('blocked')} elsewhere waiting on you`
      : triggerStatus === 'working'
        ? `${counts('working')} working elsewhere`
        : triggerStatus === 'dead'
          ? `${counts('dead')} elsewhere stopped`
          : triggerStatus === 'ready'
            ? `${counts('ready')} elsewhere ready for you`
            : 'Switch workspace / tab';

  // A hidden workspace has no user-facing name worth showing in the
  // breadcrumb (it's plumbing), so fall back to the tab alone. Nothing
  // routes there by default any more — the resident-pane primitive is gone —
  // but a direct URL can still land on one.
  const triggerLabel = activeWorkspace?.hidden ? (
    <span className="mns-trigger-tab">{activeTab?.name ?? '—'}</span>
  ) : activeWorkspace ? (
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
        title={triggerTitle}
        aria-expanded={open}
      >
        <span className="mns-trigger-label">{triggerLabel}</span>
        {triggerStatus !== 'idle' && (
          <span className="mns-trigger-status" role="img" aria-label={triggerTitle}>
            <StatusMark status={triggerStatus} />
          </span>
        )}
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
            ref={panelRef}
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
