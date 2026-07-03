import type { PaneSpec } from '@muxpad/shared';
import { useEffect, useRef, useState } from 'react';
import { getPaneFace, setPaneFace, usePaneFace } from '../lib/pane-face';
import { sendPaneInput } from '../lib/pane-input';
import { ChatPane } from './ChatPane';
import { XtermPane } from './XtermPane';
import './ShellPaneBody.css';

/**
 * Body of a shell pane that can switch its visible face between the terminal
 * and a web view of an app the pane serves — without adding a second pane.
 *
 * Both faces stay mounted; we toggle visibility with `hidden` (display:none).
 * That's the whole point: the terminal (and its WebSocket / scrollback) keeps
 * running underneath while you look at the web view, so flipping back is
 * instant and the dev server never loses its controlling view. The XtermPane
 * is told it's inactive while the web face is up (paneActive=false) so it
 * stops driving the shared PTY size — same mounted-but-hidden contract the
 * mobile pane-switcher already relies on.
 *
 * The web iframe is mounted as soon as a URL has ever been chosen (even while
 * the terminal face is showing) so toggling to web doesn't reload the app.
 * The chrome's PaneWebSwitch owns the face state; this component just renders
 * it. "Back to terminal" lives in that switch — always available here because
 * a ShellPaneBody, by definition, has a terminal behind it.
 */
export function ShellPaneBody({
  pane,
  onExit,
  autoFocus,
  paneActive = true,
}: {
  pane: PaneSpec;
  onExit: () => void;
  autoFocus?: boolean | undefined;
  paneActive?: boolean | undefined;
}) {
  const { face, url } = usePaneFace(pane.id);
  const showWeb = face === 'web' && !!url;
  const showChat = face === 'chat';

  // Surface the toggle as soon as the pane has a muxpad-tracked Claude session
  // (launched via `muxpad claude`). This is known the instant the wrapper
  // registers — far faster than the ~10s foreground-cmd poll the old gate used,
  // which made the toggle lag ~7s behind claude starting/stopping. It's sticky:
  // chat stays a valid face of the session for the pane's life (view / drive /
  // resume it), so it never flickers.
  const [hasSession, setHasSession] = useState(false);
  useEffect(() => {
    let alive = true;
    const check = async () => {
      const r = await fetch(`/api/agent-sessions/by-pane/${pane.id}`).catch(() => null);
      if (!alive || !r?.ok) return;
      const s = (await r.json().catch(() => null)) as { view_mode?: string } | null;
      setHasSession(true);
      // A poll can be in flight across a local toggle and return the pre-switch
      // view_mode; don't let that revert the face — the server catches up in a
      // couple seconds. Skip the sync briefly after a local switch.
      if (Date.now() - lastSwitch.current < 4000) return;
      // Sync THIS device's terminal/chat face to the session's SHARED view-mode
      // so a switch on one device shows up on the others — mobile no longer
      // lands on an empty terminal after a desktop switch to chat. The 'web'
      // face is device-local; never override it here.
      const local = getPaneFace(pane.id);
      if (
        local.face !== 'web' &&
        (s?.view_mode === 'chat' || s?.view_mode === 'terminal') &&
        s.view_mode !== local.face
      ) {
        setPaneFace(pane.id, { face: s.view_mode, url: local.url });
      }
    };
    void check();
    const iv = setInterval(() => void check(), 2500);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, [pane.id]);

  // Lazily mount the chat face on first use, then keep it mounted-but-hidden
  // (same contract as the web face) so its /ws/chat stays open and flipping
  // back is instant. Panes never viewed as chat pay nothing.
  const [chatMounted, setChatMounted] = useState(false);
  useEffect(() => {
    if (showChat) setChatMounted(true);
  }, [showChat]);

  // The single toggle switches the view AND what drives the session underneath:
  //   → chat: stop the Claude TUI (server SIGTERM) so chat becomes the driver.
  //   → terminal: relaunch `muxpad claude --resume <sid>` in the pane's shell.
  // We await the hand-off before flipping so the target view is always live.
  const [switching, setSwitching] = useState(false);
  const lastSwitch = useRef(0);
  const switchTo = async (target: 'terminal' | 'chat') => {
    if (switching) return;
    setSwitching(true);
    lastSwitch.current = Date.now();
    // Record the SHARED view-mode first (fast) so other devices follow, and so
    // this device's own poll doesn't revert the face mid-handoff.
    void fetch(`/api/agent-sessions/${pane.id}/view-mode`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: target }),
    }).catch(() => {});
    try {
      if (target === 'chat') {
        // Flip immediately (no flash of the terminal exiting); stop the TUI
        // underneath while the toggle shows "…".
        setPaneFace(pane.id, { face: 'chat', url });
        await fetch(`/api/agent-sessions/${pane.id}/takeover`, { method: 'POST' }).catch(() => {});
      } else {
        // Only relaunch if Claude ISN'T already running in the pane — otherwise
        // the command would be typed INTO the live TUI as a prompt (bug). If it's
        // already there (e.g. a take-over failed, or we're just peeking), reveal
        // the terminal as-is.
        const fgRes = await fetch(`/api/agent-sessions/${pane.id}/foreground`).catch(() => null);
        const fg = fgRes?.ok ? ((await fgRes.json()) as { isClaude?: boolean }) : null;
        if (!fg?.isClaude) {
          const res = await fetch(`/api/agent-sessions/by-pane/${pane.id}`).catch(() => null);
          const s = res?.ok ? ((await res.json()) as { current_sid?: string | null }) : null;
          if (s?.current_sid) {
            await sendPaneInput(pane.id, `muxpad claude --resume ${s.current_sid}\r`);
            await new Promise((r) => setTimeout(r, 1200));
          }
        }
        setPaneFace(pane.id, { face: 'terminal', url });
      }
    } finally {
      setSwitching(false);
    }
  };

  return (
    <div className="shell-pane-body">
      {showChat || hasSession ? (
        <button
          type="button"
          className="shell-pane-chat-toggle"
          onClick={() => switchTo(showChat ? 'terminal' : 'chat')}
          disabled={switching}
          title={showChat ? 'Switch to terminal' : 'Switch to chat'}
        >
          {switching ? '…' : showChat ? 'Terminal' : 'Chat'}
        </button>
      ) : null}
      <div className="shell-pane-face" hidden={showWeb || showChat}>
        <XtermPane
          paneId={pane.id}
          onExit={onExit}
          autoFocus={autoFocus}
          foregroundCmd={pane.foreground_cmd ?? null}
          paneActive={paneActive && !showWeb && !showChat}
        />
      </div>
      {url ? (
        <div className="shell-pane-face" hidden={!showWeb}>
          <iframe
            // Keying on the url means picking a different app reloads the
            // iframe; toggling face (same url) does not.
            key={url}
            className="shell-pane-web"
            src={url}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
            referrerPolicy="no-referrer"
            title={url}
          />
        </div>
      ) : null}
      {chatMounted ? (
        <div className="shell-pane-face" hidden={!showChat}>
          <ChatPane paneId={pane.id} active={showChat} />
        </div>
      ) : null}
    </div>
  );
}
