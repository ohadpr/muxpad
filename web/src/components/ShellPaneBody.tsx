import type { PaneSpec } from '@muxpad/shared';
import { useEffect, useRef, useState } from 'react';
import { subscribe } from '../events';
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
  // Server-persisted face, kept live by pane.updated events (the pane prop
  // re-renders with fresh face/face_url) — survives reloads, follows the
  // user across devices.
  const { face, url } = usePaneFace(pane.id, pane.face, pane.face_url);
  const showWeb = face === 'web' && !!url;
  const showChat = face === 'chat';

  // Surface the toggle as soon as the pane has a muxpad-tracked Claude session
  // (launched via `muxpad claude`). This is known the instant the wrapper
  // registers — far faster than the ~10s foreground-cmd poll the old gate used,
  // which made the toggle lag ~7s behind claude starting/stopping. It's sticky:
  // chat stays a valid face of the session for the pane's life (view / drive /
  // resume it), so it never flickers.
  const [hasSession, setHasSession] = useState(false);
  // True while a headless (chat-driven) turn is running for this pane's
  // session — drives the activity dot on the Terminal/Chat toggle.
  const [agentRunning, setAgentRunning] = useState(false);
  // Which surface currently drives the session. 'sdk' = a `muxpad agent`
  // runner lives in the pane — the toggle then only switches the VIEW
  // (chat ⇄ runner log); there is no TUI to kill or relaunch.
  const writerRef = useRef<string>('none');
  // Latest session check, exposed so the event subscription below can fire
  // it immediately instead of waiting out the poll interval.
  const checkRef = useRef<() => void>(() => {});
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Poll cadence with backoff. A pane launched via `muxpad claude` has a
    // session and polls fast (2.5s) to keep the toggle/activity-dot/view-mode
    // in sync. A session-LESS pane (plain shell) 404s forever otherwise, so we
    // back off geometrically up to 30s to kill the console/network spam — while
    // still checking occasionally, since the pane can gain a session later
    // (user runs `muxpad claude`). A found session resets to the fast cadence.
    const FAST = 2500;
    const MAX = 30000;
    let delay = FAST;
    const check = async () => {
      const r = await fetch(`/api/agent-sessions/by-pane/${pane.id}`).catch(() => null);
      if (!alive) return;
      if (!r?.ok) {
        delay = Math.min(delay * 2, MAX);
        return;
      }
      delay = FAST;
      const s = (await r.json().catch(() => null)) as {
        view_mode?: string;
        status?: string;
        writer?: string;
      } | null;
      setHasSession(true);
      setAgentRunning(s?.status === 'running');
      writerRef.current = s?.writer ?? 'none';
      // Face sync now rides the server-persisted pane.face (usePaneFace above)
      // — the session poll only feeds the toggle/activity-dot/writer state.
    };
    const tick = async () => {
      await check();
      if (!alive) return;
      timer = setTimeout(() => void tick(), delay);
    };
    checkRef.current = () => void check();
    void tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [pane.id]);

  // Server-pushed session changes (a runner attached, another device switched
  // the view, a turn started/ended) re-check immediately — the face flips the
  // moment `muxpad agent` registers instead of on the next poll.
  useEffect(() => {
    return subscribe((e) => {
      if (e.type === 'agent_session.updated' && e.pane_id === pane.id) checkRef.current();
    });
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
  // Kept for the setPaneFace local-wins window (a stale poll must not revert
  // a just-made flip; the PATCH echo reconciles).
  const lastSwitch = useRef(0);
  // Transient banner for a failed terminal→chat hand-off (the TUI wouldn't
  // stop): the chat face still opens (viewing is fine) but can't drive yet.
  const [handoffNotice, setHandoffNotice] = useState<string | null>(null);
  const noticeTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(noticeTimer.current), []);
  const showNotice = (text: string) => {
    setHandoffNotice(text);
    window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setHandoffNotice(null), 8000);
  };
  const switchTo = async (target: 'terminal' | 'chat') => {
    if (switching) return;
    setSwitching(true);
    lastSwitch.current = Date.now();
    // setPaneFace below persists the face server-side (PATCH) and the
    // resulting pane.updated event flips every other device's view.
    try {
      if (target === 'chat') {
        // Flip immediately (no flash of the terminal exiting); stop the TUI
        // underneath while the toggle shows "…". If the hand-off FAILS (the
        // TUI wouldn't die / server unreachable), keep the chat face — viewing
        // is legitimate — but say so: chat can't drive until the TUI is gone.
        // An SDK runner pane skips the takeover entirely: the runner is
        // already the chat driver, this is purely a view flip.
        setPaneFace(pane.id, { face: 'chat', url });
        if (writerRef.current !== 'sdk') {
          const r = await fetch(`/api/agent-sessions/${pane.id}/takeover`, {
            method: 'POST',
          }).catch(() => null);
          if (!r?.ok) {
            showNotice(
              'Terminal is still running Claude — chat is read-only until you exit it there.',
            );
          }
        }
      } else if (writerRef.current === 'sdk') {
        // Runner pane: the terminal face is the runner's activity log —
        // reveal it as-is; never type a relaunch command at it.
        setPaneFace(pane.id, { face: 'terminal', url });
      } else {
        // Only relaunch if Claude ISN'T already running in the pane — otherwise
        // the command would be typed INTO the live TUI as a prompt (bug). Same
        // for any other foreground program (vim, a running build, ssh): typing
        // a command into those is worse than doing nothing, so we only type
        // when the pane is sitting at its shell prompt. If Claude is already
        // there (e.g. a take-over failed, or we're just peeking), reveal the
        // terminal as-is.
        const fgRes = await fetch(`/api/agent-sessions/${pane.id}/foreground`).catch(() => null);
        const fg = fgRes?.ok
          ? ((await fgRes.json()) as { isClaude?: boolean; foreground?: string | null })
          : null;
        const fgCmd = (fg?.foreground ?? '').trim();
        const atShellPrompt =
          !fgCmd || /(^|[/\s-])(zsh|bash|fish|dash|sh|nu|tcsh|csh|ksh|pwsh|xonsh)$/.test(fgCmd);
        if (!fg?.isClaude && atShellPrompt) {
          const res = await fetch(`/api/agent-sessions/by-pane/${pane.id}`).catch(() => null);
          const s = res?.ok ? ((await res.json()) as { current_sid?: string | null }) : null;
          if (s?.current_sid) {
            await sendPaneInput(pane.id, `muxpad claude --resume ${s.current_sid}\r`);
            await new Promise((r) => setTimeout(r, 1200));
          }
        } else if (!fg?.isClaude && !atShellPrompt) {
          showNotice(
            'Another program is in the terminal — resume Claude manually when it is free.',
          );
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
          {agentRunning ? <span className="shell-pane-agent-dot" aria-hidden="true" /> : null}
          {switching ? '…' : showChat ? 'Terminal' : 'Chat'}
        </button>
      ) : null}
      {handoffNotice ? <div className="shell-pane-handoff-notice">{handoffNotice}</div> : null}
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
