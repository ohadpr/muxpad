import type { AppUrl } from '@muxpad/shared';
import { useEffect, useRef, useState } from 'react';
import { normalizePaneUrl, setPaneFace, usePaneFace } from '../lib/pane-face';
import './PaneWebSwitch.css';

/**
 * Pane-chrome control for the terminal⇄web face toggle. Appears only when the
 * pane is serving at least one detected app (or has been pointed at a URL
 * before). The main button flips faces; the caret opens a dropdown to pick
 * among multiple apps, type a URL by hand, or jump back to the terminal.
 *
 * The detection heuristic is deliberately non-authoritative — we never
 * auto-flip; the human picks here. That's why "enter URL manually" is always
 * offered: if detection missed the server entirely, you're never stuck.
 */
export function PaneWebSwitch({ paneId, appUrls }: { paneId: string; appUrls: AppUrl[] }) {
  const { face, url } = usePaneFace(paneId);
  const [open, setOpen] = useState(false);
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState('');
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current?.contains(e.target as Node)) return;
      setOpen(false);
      setTyping(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        setTyping(false);
      }
    };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  useEffect(() => {
    if (typing) inputRef.current?.focus();
  }, [typing]);

  // Nothing to offer: no detected apps and never pointed anywhere.
  if (appUrls.length === 0 && !url) return null;

  const showWeb = face === 'web' && !!url;

  const flipToWeb = (target: string) => {
    setPaneFace(paneId, { face: 'web', url: target });
    setOpen(false);
    setTyping(false);
  };
  const flipToTerminal = () => {
    setPaneFace(paneId, { face: 'terminal', url });
    setOpen(false);
    setTyping(false);
  };
  // Main button: flip to the current/first app, or back to the terminal.
  const onMainClick = () => {
    if (showWeb) flipToTerminal();
    else flipToWeb(url ?? appUrls[0]?.url ?? '');
  };
  const commitDraft = () => {
    const next = normalizePaneUrl(draft);
    if (next) flipToWeb(next);
  };

  return (
    <div className="pane-web-switch" ref={wrapRef} onMouseDown={(e) => e.stopPropagation()}>
      <button
        type="button"
        className={`pane-web-switch-main${showWeb ? ' is-web' : ''}`}
        title={showWeb ? 'Back to terminal' : 'View web app'}
        aria-label={showWeb ? 'Back to terminal' : 'View web app'}
        onClick={onMainClick}
      >
        {showWeb ? <SvgTerminalGlyph /> : <SvgGlobe />}
        <span className="pane-web-switch-label">{showWeb ? 'Terminal' : 'Web'}</span>
      </button>
      <button
        type="button"
        className="pane-web-switch-caret"
        title="Choose web app"
        aria-label="Choose web app"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        ▾
      </button>
      {open ? (
        <div className="pane-web-switch-menu" role="menu">
          {appUrls.map((a) => (
            <button
              key={a.url}
              type="button"
              role="menuitem"
              className={`pane-web-switch-item${url === a.url && showWeb ? ' is-active' : ''}`}
              onClick={() => flipToWeb(a.url)}
              title={a.url}
            >
              <SvgGlobe />
              <span className="pane-web-switch-item-label">{a.label ?? hostLabel(a.url)}</span>
              {a.source === 'marker' ? <span className="pane-web-switch-badge">app</span> : null}
            </button>
          ))}
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
                setDraft(url ?? '');
                setTyping(true);
              }}
            >
              Enter URL…
            </button>
          )}
          {showWeb ? (
            <button
              type="button"
              role="menuitem"
              className="pane-web-switch-item pane-web-switch-back"
              onClick={flipToTerminal}
            >
              <SvgTerminalGlyph />
              <span className="pane-web-switch-item-label">Back to terminal</span>
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Best-effort short label for a URL (host:port, no scheme). */
function hostLabel(raw: string): string {
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
