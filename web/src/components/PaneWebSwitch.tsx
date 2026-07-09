import type { AppUrl } from '@muxpad/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { subscribe } from '../events';
import { probeUrl, requestFace } from '../lib/face-switch';
import { normalizePaneUrl, usePaneFace } from '../lib/pane-face';
import { addUrlRecent, getUrlRecents } from '../lib/url-recents';
import './PaneWebSwitch.css';

/**
 * THE face menu for a pane — the one place to see and switch what a pane is
 * showing: Terminal, Chat (when a Claude session lives here), any detected
 * serving URL, recently-typed URLs, or a manually entered one.
 *
 * Selection dispatches a muxpad:set-face request that the pane's mounted
 * ShellPaneBody executes; every switch is a pure view flip (the old TUI
 * driver hand-off is gone — TUI panes get a one-way "Continue in Agent tab"
 * handoff instead). Two triggers render this list: PaneWebSwitch below
 * (mobile bar + tabbed strip) and the desktop mosaic chrome's
 * PaneSurfaceSwitch (which appends its pane-KIND conversion items as
 * children).
 *
 * The list renders position:fixed at coordinates measured from the trigger —
 * every host is a scroll/overflow container that would clip an absolutely-
 * positioned child (same lesson as NewKindMenu).
 */
export function PaneFaceMenuList({
  paneId,
  appUrls,
  startupCmd,
  at,
  onClose,
  children,
}: {
  paneId: string;
  appUrls: AppUrl[];
  startupCmd?: string | null | undefined;
  /** Viewport coords for the fixed-position menu (measured from the trigger). */
  at: { top: number; left: number };
  onClose: () => void;
  /** Extra menu items appended after a separator (e.g. kind conversion). */
  children?: React.ReactNode;
}) {
  const { face, url } = usePaneFace(paneId);
  const isAgent = startupCmd?.startsWith('muxpad agent') ?? false;
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (typing) inputRef.current?.focus();
  }, [typing]);

  // Chat is offered when the pane tracks a Claude session. One fetch per
  // menu-open (this component mounts on open) — no standing poll.
  const [session, setSession] = useState<{ writer: string; running: boolean } | null>(null);
  useEffect(() => {
    let alive = true;
    void fetch(`/api/agent-sessions/by-pane/${paneId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((s: { writer?: string; status?: string } | null) => {
        if (alive && s) {
          setSession({ writer: s.writer ?? 'none', running: s.status === 'running' });
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [paneId]);

  // Reachability, checked once per open for every URL on offer. true = alive,
  // false = nothing answered, undefined = still checking (rendered neutral).
  const recents = useMemo(
    () => getUrlRecents(paneId).filter((u) => !appUrls.some((a) => a.url === u)),
    [paneId, appUrls],
  );
  const [alive, setAlive] = useState<Record<string, boolean>>({});
  useEffect(() => {
    let on = true;
    const targets = [...new Set([...appUrls.map((a) => a.url), ...recents])];
    for (const target of targets) {
      void probeUrl(target).then((ok) => {
        if (on) setAlive((m) => ({ ...m, [target]: ok }));
      });
    }
    return () => {
      on = false;
    };
  }, [appUrls, recents]);

  const pick = (nextFace: 'terminal' | 'web' | 'chat', nextUrl?: string) => {
    requestFace({ paneId, face: nextFace, url: nextUrl ?? null });
    onClose();
  };
  const commitDraft = () => {
    const next = normalizePaneUrl(draft);
    if (!next) return;
    addUrlRecent(paneId, next);
    pick('web', next);
  };

  // Chat is agent-pane-only: the runner is the one chat driver (migration 14
  // reset any legacy non-agent pane persisted on the chat face).
  const showChat = isAgent;
  const urlItem = (target: string, label: string, sub?: string, badge?: string) => {
    const active = face === 'web' && url === target;
    const dead = alive[target] === false;
    return (
      <button
        key={target}
        type="button"
        role="menuitem"
        className={`pane-web-switch-item${active ? ' is-active' : ''}${dead ? ' is-dead' : ''}`}
        onClick={() => pick('web', target)}
        title={dead ? `${target} — nothing is responding here right now` : target}
      >
        <SvgGlobe />
        <span className="pane-web-switch-item-label">
          {label}
          {sub ? <span className="pane-web-switch-item-sub"> {sub}</span> : null}
        </span>
        {dead ? (
          <span className="pane-web-switch-note">offline</span>
        ) : badge ? (
          <span className="pane-web-switch-badge">{badge}</span>
        ) : null}
      </button>
    );
  };

  return (
    <div
      className="pane-web-switch-menu is-fixed"
      role="menu"
      style={{ top: at.top, left: at.left }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="pane-web-switch-head">View</div>
      {(() => {
        // Every face is a VIEW over the same pane — nothing is lost by
        // switching. Chat exists only on agent panes (their runner is the
        // one chat driver); a TUI session pane instead offers a one-way
        // handoff into a fresh agent tab. Items that invite doubt explain
        // themselves in a second line.
        const terminalItem = (
          <button
            key="face-terminal"
            type="button"
            role="menuitem"
            className={`pane-web-switch-item${face === 'terminal' ? ' is-active' : ''}`}
            onClick={() => pick('terminal')}
          >
            <SvgTerminalGlyph />
            <span className="pane-web-switch-item-text">
              <span className="pane-web-switch-item-label">
                {isAgent ? 'Agent log' : 'Terminal'}
              </span>
              {isAgent ? (
                <span className="pane-web-switch-item-desc">
                  Peek at the agent’s raw output — the chat keeps running
                </span>
              ) : null}
            </span>
          </button>
        );
        const chatItem = showChat ? (
          <button
            key="face-chat"
            type="button"
            role="menuitem"
            className={`pane-web-switch-item${face === 'chat' ? ' is-active' : ''}`}
            onClick={() => pick('chat')}
          >
            <span className="pane-web-switch-glyph" aria-hidden="true">
              ✳
            </span>
            <span className="pane-web-switch-item-label">Chat</span>
            {session?.running ? <span className="pane-web-switch-dot" aria-hidden="true" /> : null}
          </button>
        ) : null;
        // A tracked TUI session: offer the handoff instead of a chat face.
        const handoffItem =
          !isAgent && session !== null ? (
            <button
              key="handoff"
              type="button"
              role="menuitem"
              className="pane-web-switch-item"
              onClick={() => {
                window.dispatchEvent(
                  new CustomEvent('muxpad:handoff-to-agent', { detail: { paneId } }),
                );
                onClose();
              }}
            >
              <span className="pane-web-switch-glyph" aria-hidden="true">
                ✳
              </span>
              <span className="pane-web-switch-item-text">
                <span className="pane-web-switch-item-label">Continue in Agent tab</span>
                <span className="pane-web-switch-item-desc">
                  The running Claude writes its context to a handoff file, a new agent tab picks it
                  up, and this terminal closes itself
                </span>
              </span>
            </button>
          ) : null;
        // Chat is an agent pane's home face — it sorts first there.
        return isAgent ? [chatItem, terminalItem] : [terminalItem, chatItem, handoffItem];
      })()}
      {appUrls.length > 0 ? (
        <div className="pane-web-switch-head">
          {appUrls.length === 1 ? 'Serving' : `Serving · ${appUrls.length}`}
        </div>
      ) : null}
      {appUrls.map((a) =>
        urlItem(
          a.url,
          a.label ?? hostLabel(a.url),
          a.label ? hostLabel(a.url) : undefined,
          a.source === 'marker' ? 'app' : undefined,
        ),
      )}
      {recents.length > 0 ? <div className="pane-web-switch-head">Recent</div> : null}
      {recents.map((u) => urlItem(u, hostLabel(u)))}
      {typing ? (
        <input
          ref={inputRef}
          className="pane-web-switch-input"
          value={draft}
          placeholder="https://…"
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitDraft();
          }}
        />
      ) : (
        <button
          type="button"
          role="menuitem"
          className="pane-web-switch-item pane-web-switch-manual"
          onClick={() => {
            setDraft(face === 'web' ? (url ?? '') : '');
            setTyping(true);
          }}
        >
          Enter URL…
        </button>
      )}
      {children}
    </div>
  );
}

/**
 * Face-menu trigger for the mobile bar and the desktop tabbed strip: one
 * button showing the CURRENT face (never a silent toggle — with three faces
 * "flip" is ambiguous, so every change is an explicit menu pick). Lights up
 * accent when a detected app is being served and the pane isn't showing it.
 */
export function PaneWebSwitch({
  paneId,
  appUrls,
  startupCmd,
}: {
  paneId: string;
  appUrls: AppUrl[];
  startupCmd?: string | null | undefined;
}) {
  const { face, url } = usePaneFace(paneId);
  const [menuAt, setMenuAt] = useState<{ top: number; left: number } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const isAgent = startupCmd?.startsWith('muxpad agent') ?? false;

  // A `muxpad claude` pane on its terminal face with no web URLs offers
  // nothing visible — but it HAS a chat face, and hiding the trigger there
  // strands the user in the terminal. One fetch on mount (no poll) plus the
  // agent_session.updated push keeps this sticky-true once a session exists.
  const [hasSession, setHasSession] = useState(false);
  useEffect(() => {
    let aliveFlag = true;
    const check = () =>
      void fetch(`/api/agent-sessions/by-pane/${paneId}`)
        .then((r) => {
          if (aliveFlag && r.ok) setHasSession(true);
        })
        .catch(() => {});
    check();
    const unsub = subscribe((e) => {
      if (e.type === 'agent_session.updated' && e.pane_id === paneId) check();
    });
    return () => {
      aliveFlag = false;
      unsub();
    };
  }, [paneId]);

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
    // Fixed coords go stale on any scroll/resize — just close.
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [menuAt]);

  // Nothing to offer: no faces beyond the terminal itself.
  if (appUrls.length === 0 && !url && !isAgent && !hasSession && face === 'terminal') return null;

  const showWeb = face === 'web' && !!url;
  const showChat = face === 'chat';
  const available = !showWeb && appUrls.length > 0;

  const toggle = () => {
    if (menuAt) {
      setMenuAt(null);
      return;
    }
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setMenuAt({ top: rect.bottom + 4, left: clampMenuLeft(rect.left) });
  };

  return (
    <div className="pane-web-switch" ref={wrapRef} onMouseDown={(e) => e.stopPropagation()}>
      <button
        ref={triggerRef}
        type="button"
        className={`pane-web-switch-main${showWeb || showChat ? ' is-web' : ''}${available ? ' is-available' : ''}`}
        title="Pane view — terminal, chat, or web"
        aria-label="Pane view — terminal, chat, or web"
        aria-haspopup="menu"
        aria-expanded={menuAt !== null}
        onClick={toggle}
      >
        {showChat ? (
          <span className="pane-web-switch-glyph" aria-hidden="true">
            ✳
          </span>
        ) : showWeb ? (
          <SvgGlobe />
        ) : (
          <SvgTerminalGlyph />
        )}
        <span className="pane-web-switch-label">
          {showChat ? 'Chat' : showWeb ? 'Web' : 'Terminal'}
        </span>
        {available ? <span className="pane-web-switch-dot" aria-hidden="true" /> : null}
        <span className="pane-web-switch-chevron" aria-hidden="true">
          ▾
        </span>
      </button>
      {menuAt ? (
        <PaneFaceMenuList
          paneId={paneId}
          appUrls={appUrls}
          startupCmd={startupCmd}
          at={menuAt}
          onClose={() => setMenuAt(null)}
        />
      ) : null}
    </div>
  );
}

/**
 * Clamp a fixed-position menu's left coordinate so its widest possible box
 * (max-width 320px + padding) stays inside the viewport — triggers living at
 * the right edge (pane chrome, tab strip) would otherwise push it offscreen.
 */
export function clampMenuLeft(left: number): number {
  return Math.max(8, Math.min(left, window.innerWidth - 336));
}

/** Best-effort short label for a URL (host:port, no scheme). */
export function hostLabel(raw: string): string {
  try {
    const u = new URL(raw);
    return u.port ? `${u.hostname}:${u.port}` : u.hostname;
  } catch {
    return raw;
  }
}

function SvgGlobe() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <circle cx="7" cy="7" r="5.2" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <ellipse
        cx="7"
        cy="7"
        rx="2.4"
        ry="5.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.0"
      />
      <line x1="1.8" y1="7" x2="12.2" y2="7" stroke="currentColor" strokeWidth="1.0" />
    </svg>
  );
}

function SvgTerminalGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <rect
        x="1"
        y="2"
        width="12"
        height="10"
        rx="1.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.1"
      />
      <path
        d="M3.6 5.4 L5.6 7 L3.6 8.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <line
        x1="6.4"
        y1="9.2"
        x2="10.4"
        y2="9.2"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}
