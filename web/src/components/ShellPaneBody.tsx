import type { PaneSpec } from '@muxpad/shared';
import { useEffect, useRef, useState } from 'react';
import { isMixedContentUrl, probeUrl } from '../lib/face-switch';
import { isSelfOriginUrl, setPaneFace, usePaneFace } from '../lib/pane-face';
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

  // Lazily mount the chat face on first use, then keep it mounted-but-hidden
  // (same contract as the web face) so its /ws/chat stays open and flipping
  // back is instant. Panes never viewed as chat pay nothing.
  const [chatMounted, setChatMounted] = useState(false);
  useEffect(() => {
    if (showChat) setChatMounted(true);
  }, [showChat]);

  // Executes face switches requested by the chrome's face menu
  // (muxpad:set-face). Every switch is a pure VIEW flip — chat exists only
  // on agent panes (their runner is always the driver), the terminal is
  // never typed at, and web is an overlay. (The old TUI driver hand-off and
  // the later one-way agent handoff were both dropped — agent tabs are
  // created fresh.)
  const switchTo = (target: 'terminal' | 'web' | 'chat', targetUrl?: string) => {
    // setPaneFace persists server-side (PATCH); the resulting pane.updated
    // event flips every other device's view too.
    setPaneFace(pane.id, {
      face: target,
      url: target === 'web' ? (targetUrl ?? url) : url,
    });
  };

  // Face switches arrive from the chrome's face menu as window events (the
  // menu lives in a different subtree). Ref-bound so the handler always sees
  // the freshest closure without re-subscribing per render.
  const switchToRef = useRef(switchTo);
  switchToRef.current = switchTo;
  useEffect(() => {
    const onSetFace = (e: Event) => {
      const d = (e as CustomEvent<{ paneId: string; face: string; url?: string | null }>).detail;
      if (d?.paneId !== pane.id) return;
      if (d.face === 'terminal' || d.face === 'web' || d.face === 'chat') {
        void switchToRef.current(d.face, d.url ?? undefined);
      }
    };
    window.addEventListener('muxpad:set-face', onSetFace);
    return () => window.removeEventListener('muxpad:set-face', onSetFace);
  }, [pane.id]);

  // Dead-URL detection for the web face: a stopped dev server otherwise
  // renders as an unexplained blank iframe. Probe while the web face is
  // showing; when nothing answers, swap in a notice with a way out. Re-probes
  // on an interval so restarting the server heals the view by itself.
  const [webDead, setWebDead] = useState(false);
  // Bumped to force the web iframe to reload (chrome's "Reload page" item /
  // PaneWebSwitch / PaneSurfaceSwitch dispatch `muxpad:reload-url-pane`). The
  // url-keyed iframe otherwise only reloads when the URL itself changes — so a
  // flaky local muxpad-serve app couldn't be reloaded from the web face at all.
  const [reloadNonce, setReloadNonce] = useState(0);
  useEffect(() => {
    const onReload = (e: Event) => {
      const d = (e as CustomEvent<{ paneId: string }>).detail;
      if (d?.paneId !== pane.id) return;
      setWebDead(false); // give the iframe a fresh chance if it was showing dead
      setReloadNonce((n) => n + 1);
    };
    window.addEventListener('muxpad:reload-url-pane', onReload);
    return () => window.removeEventListener('muxpad:reload-url-pane', onReload);
  }, [pane.id]);
  // Mixed content is a distinct failure from a dead server: an https muxpad
  // page can't embed (or even probe) a plain-http URL, so probing would
  // misdiagnose a healthy server as stopped. Branch before the probe and
  // render a notice that names the real problem.
  const webBlocked = showWeb && !!url && isMixedContentUrl(url);
  useEffect(() => {
    if (!showWeb || !url || isSelfOriginUrl(url) || isMixedContentUrl(url)) {
      setWebDead(false);
      return;
    }
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = async () => {
      const ok = await probeUrl(url);
      if (!alive) return;
      setWebDead(!ok);
      // Dead → retry every 3s so recovery is quick; alive → occasional
      // re-check catches a server that dies while you look at it.
      timer = setTimeout(() => void check(), ok ? 15000 : 3000);
    };
    void check();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [showWeb, url]);

  return (
    <div className="shell-pane-body">
      <div className="shell-pane-face" hidden={showWeb || showChat}>
        <XtermPane
          paneId={pane.id}
          onExit={onExit}
          autoFocus={autoFocus}
          foregroundCmd={pane.foreground_cmd ?? null}
          paneActive={paneActive && !showWeb && !showChat}
        />
      </div>
      {url && !isSelfOriginUrl(url) ? (
        <div className="shell-pane-face" hidden={!showWeb}>
          {webBlocked ? (
            <div className="shell-pane-web-blocked">
              <div>
                This muxpad page is https, so the browser refuses to embed plain-http {url}. Serve
                the app over https (e.g. tailscale serve) to view it here, or open it in its own
                tab.
              </div>
              <button
                type="button"
                className="shell-pane-web-back"
                onClick={() => window.open(url, '_blank', 'noopener')}
              >
                Open in browser tab
              </button>
              <button
                type="button"
                className="shell-pane-web-back"
                onClick={() => switchTo('terminal')}
              >
                Back to terminal
              </button>
            </div>
          ) : webDead ? (
            <div className="shell-pane-web-blocked">
              <div>Nothing is responding at {url} — the server may have stopped.</div>
              <button
                type="button"
                className="shell-pane-web-back"
                onClick={() => switchTo('terminal')}
              >
                Back to terminal
              </button>
            </div>
          ) : (
            <iframe
              // Keying on the url means picking a different app reloads the
              // iframe; toggling face (same url) does not. The nonce lets an
              // explicit "Reload page" remount it without changing the url.
              key={`${url}#${reloadNonce}`}
              className="shell-pane-web"
              src={url}
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
              referrerPolicy="no-referrer"
              title={url}
            />
          )}
        </div>
      ) : url ? (
        // muxpad-inside-muxpad recursively boots the whole client per nesting
        // level until the browser exhausts resources — never mount it. (The
        // iframe is mounted even while another face is showing, so this bomb
        // would go off on every device holding the pane, whatever face it's
        // on. main.tsx has a boot-time backstop too.)
        <div className="shell-pane-face" hidden={!showWeb}>
          <div className="shell-pane-web-blocked">
            muxpad can’t embed itself — pick a different URL for this pane’s web view.
          </div>
        </div>
      ) : null}
      {chatMounted ? (
        <div className="shell-pane-face" hidden={!showChat}>
          <ChatPane
            paneId={pane.id}
            active={showChat}
            agentNative={pane.startup_cmd?.startsWith('muxpad agent') ?? false}
          />
        </div>
      ) : null}
    </div>
  );
}
