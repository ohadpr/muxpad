/**
 * Window-event contract for switching a pane's face (terminal | web | chat).
 *
 * Face menus live in the pane CHROME (tab strip, mosaic title bar, mobile
 * bar), but the pane's mounted body owns its faces — so menus REQUEST a face
 * here and ShellPaneBody executes the flip. Same pattern as
 * muxpad:focus-pane / muxpad:send-input. Every switch is a pure view flip
 * (the old TUI driver hand-off and the later agent handoff are both gone).
 */
export interface SetFaceDetail {
  paneId: string;
  face: 'terminal' | 'web' | 'chat';
  /** Target URL when face is 'web'. */
  url?: string | null;
}

export function requestFace(detail: SetFaceDetail): void {
  window.dispatchEvent(new CustomEvent<SetFaceDetail>('muxpad:set-face', { detail }));
}

/**
 * Reachability probe for web-face URLs. mode:'no-cors' resolves (opaque) when
 * ANYTHING answers at the address — any status, any origin — and rejects only
 * on network failure (nothing listening, DNS, refused). Exactly the "is the
 * dev server up" signal the face menu and the dead-URL notice need.
 */
export async function probeUrl(url: string, timeoutMs = 1500): Promise<boolean> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    await fetch(url, { mode: 'no-cors', cache: 'no-store', signal: ctl.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * True when THIS page is https but `raw` is plain http on a non-loopback
 * host — the browser then blocks both the iframe embed and the probeUrl
 * fetch as mixed content, no matter how alive the server is. Callers must
 * branch BEFORE probing: for these URLs a failed probe means "blocked",
 * not "offline", and showing "offline" sends the user debugging a server
 * that is actually fine (observed with tailscale-served https muxpad +
 * http dev-server app URLs). Loopback hosts are exempt — browsers treat
 * http://localhost as potentially trustworthy even from secure contexts.
 */
export function isMixedContentUrl(raw: string): boolean {
  if (window.location.protocol !== 'https:') return false;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:') return false;
    return !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  } catch {
    return false;
  }
}
