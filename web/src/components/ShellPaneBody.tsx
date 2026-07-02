import type { PaneSpec } from '@muxpad/shared';
import { useEffect, useState } from 'react';
import { setPaneFace, usePaneFace } from '../lib/pane-face';
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

  // Chat is a face of a *recognized agent* (Claude today), not of every shell.
  // Only surface the toggle when the pane is running one — or when we're already
  // in chat, so you can always get back to the terminal.
  const isAgent = /\bclaude\b/i.test(pane.foreground_cmd ?? '');

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
  const switchTo = async (target: 'terminal' | 'chat') => {
    if (switching) return;
    setSwitching(true);
    try {
      if (target === 'chat') {
        await fetch(`/api/agent-sessions/${pane.id}/takeover`, { method: 'POST' }).catch(() => {});
      } else {
        const res = await fetch(`/api/agent-sessions/by-pane/${pane.id}`).catch(() => null);
        const s = res?.ok ? ((await res.json()) as { current_sid?: string | null }) : null;
        if (s?.current_sid) {
          await sendPaneInput(pane.id, `muxpad claude --resume ${s.current_sid}\r`);
        }
      }
    } finally {
      setSwitching(false);
      setPaneFace(pane.id, { face: target, url });
    }
  };

  return (
    <div className="shell-pane-body">
      {showChat || isAgent ? (
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
