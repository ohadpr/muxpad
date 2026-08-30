import type { UrlHealth, UrlHealthReason } from '@muxpad/shared';
import { api } from '../api';

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

/** Why the web face believes what it believes. Everything in {@link UrlHealth}
 *  plus 'opaque' — the browser's own no-cors probe, which knows only that
 *  *something* answered. */
export type LivenessReason = UrlHealthReason | 'opaque';

export interface UrlLiveness {
  alive: boolean;
  reason: LivenessReason;
  /** Real status when the server probe produced one; null otherwise. */
  status: number | null;
}

/**
 * What to do with the server's verdict.
 *
 *  - 'dead'     — the server saw a GATEWAY status (502/503/504). A proxy
 *                 answering "my backend is gone" is the ONE case the page can
 *                 never see for itself (opaque responses have no status), so
 *                 this is authoritative and the browser gets no say.
 *  - 'alive'    — the server reached it. Includes 401/403/404/500: the app is
 *                 up and its own page beats our "nothing is responding".
 *  - 'fallback' — the SERVER couldn't reach it (unreachable/timeout). That is
 *                 not the same as "the user can't reach it": a pane URL on the
 *                 viewer's LAN or VPN may be reachable from this browser and
 *                 not from the muxpad host. Ask the browser before condemning.
 */
export function serverVerdict(h: UrlHealth): 'dead' | 'alive' | 'fallback' {
  if (h.reason === 'gateway') return 'dead';
  if (h.alive) return 'alive';
  return 'fallback';
}

export interface ProbeUrlLiveDeps {
  /** Server-side probe. Rejects when the endpoint itself is unavailable. */
  health?: (paneId: string, url: string) => Promise<UrlHealth>;
  /** The browser's opaque probe (this module's {@link probeUrl}). */
  opaque?: (url: string) => Promise<boolean>;
}

/**
 * The web face's real liveness question: "should I mount the iframe?"
 *
 * Server first (it can read statuses; see serverVerdict), browser second and
 * only when the server's answer is inconclusive. Never throws: a broken
 * health endpoint degrades to exactly the behaviour we had before it existed,
 * which is the right failure mode — losing the 502 detection is a regression,
 * declaring every app dead because our own API hiccuped is an outage.
 */
export async function probeUrlLive(
  paneId: string,
  url: string,
  deps: ProbeUrlLiveDeps = {},
): Promise<UrlLiveness> {
  const health = deps.health ?? ((id: string, u: string) => api.paneUrlHealth(id, u));
  const opaque = deps.opaque ?? ((u: string) => probeUrl(u));
  let h: UrlHealth | null = null;
  try {
    h = await health(paneId, url);
  } catch {
    h = null; // endpoint missing / 403 / muxpad API blip → browser decides
  }
  if (h) {
    const verdict = serverVerdict(h);
    if (verdict !== 'fallback') {
      return { alive: verdict === 'alive', reason: h.reason, status: h.status };
    }
  }
  const ok = await opaque(url);
  // On agreement (both say dead) keep the server's reason — 'timeout' tells the
  // user something 'opaque' cannot.
  if (ok) return { alive: true, reason: 'opaque', status: null };
  return { alive: false, reason: h?.reason ?? 'unreachable', status: h?.status ?? null };
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
