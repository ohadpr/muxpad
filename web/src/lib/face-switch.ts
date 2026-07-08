/**
 * Window-event contract for switching a pane's face (terminal | web | chat).
 *
 * Face menus live in the pane CHROME (tab strip, mosaic title bar, mobile
 * bar), but the pane's mounted body owns its faces — so menus REQUEST a face
 * here and ShellPaneBody executes the flip. Same pattern as
 * muxpad:focus-pane / muxpad:send-input. Every switch is a pure view flip;
 * the old TUI driver hand-off (takeover / relaunch) was dropped in favor of
 * the one-way agent handoff (lib/agent-handoff.ts).
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
