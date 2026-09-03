import type { AppWithStatus, Artifact, PublicBaseInfo } from '@muxpad/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { req } from '../api';

/**
 * Client for the Hosted view — muxpad's two kinds of hosted thing.
 *
 * POLLED, not evented. An app's state is a MEASURED thing (is there a pty, does
 * the URL answer) rather than a row change, so there is no mutation to emit an
 * event on: the interesting transitions — a server dying, a proxy starting to
 * 502 — happen with nothing in muxpad touching the database. A poll is the
 * honest shape for that, and it also keeps the hidden apps container out of the
 * event bus entirely, which is what guarantees it can never leak into the
 * sidebar. The server's own probe cache collapses several devices' polls onto
 * one round-trip.
 */

export const hostedApi = {
  listApps: () => req<{ apps: AppWithStatus[] }>('/api/apps'),
  startApp: (ref: string) =>
    req<AppWithStatus>(`/api/apps/${encodeURIComponent(ref)}/start`, { method: 'POST' }),
  stopApp: (ref: string) =>
    req<AppWithStatus>(`/api/apps/${encodeURIComponent(ref)}/stop`, { method: 'POST' }),
  removeApp: (ref: string) =>
    req<void>(`/api/apps/${encodeURIComponent(ref)}`, { method: 'DELETE' }),
  listArtifacts: () => req<{ publishes: Artifact[]; base: PublicBaseInfo }>('/api/publish'),
  removeArtifact: (slug: string) =>
    req<void>(`/api/publish/${encodeURIComponent(slug)}`, { method: 'DELETE' }),
};

export interface HostedState {
  apps: AppWithStatus[];
  artifacts: Artifact[];
  /** Where artifact links are built from. null until the first load lands. */
  base: PublicBaseInfo | null;
  /** True only until the FIRST load resolves — a refresh must not blank the
   *  list back to a skeleton every three seconds. */
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

const POLL_MS = 3000;

export function useHosted(): HostedState {
  const [apps, setApps] = useState<AppWithStatus[]>([]);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [base, setBase] = useState<PublicBaseInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const [a, p] = await Promise.all([hostedApi.listApps(), hostedApi.listArtifacts()]);
      if (!alive.current) return;
      setApps(a.apps);
      setArtifacts(p.publishes);
      setBase(p.base ?? null);
      setError(null);
    } catch (err) {
      if (!alive.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (alive.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void refresh();
    // Polling stops while the page is hidden. On iOS the installed PWA is
    // backgrounded constantly; a timer that kept probing there would wake the
    // server (and every app's HTTP handler) for a view nobody is looking at.
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer) return;
      timer = setInterval(() => void refresh(), POLL_MS);
    };
    const stop = () => {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        void refresh(); // catch up immediately, don't wait out a poll interval
        start();
      } else stop();
    };
    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      alive.current = false;
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [refresh]);

  return { apps, artifacts, base, loading, error, refresh };
}

/** Human byte size. Kept tiny and local — one call site. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** `2026-08-30` — absolute, not "3 days ago". A publish date is a fact you
 *  compare against other facts; relative time makes that arithmetic. */
export function formatDate(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * The DETAIL line under an app's name — never the state itself.
 *
 * The state already has a home: the chip beside the name, and the StatusMark in
 * the rail. This line said it a second time ("running" / "running · HTTP 200",
 * "stopped" / "stopped") which is not just redundant — it teaches the eye that
 * this line is a label rather than information, so the one row where it carries
 * a real diagnosis gets skimmed past.
 *
 * Returns null where there is genuinely nothing to add; the row then renders no
 * line at all rather than an empty one.
 */
export function appDetail(app: AppWithStatus): string | null {
  switch (app.state) {
    case 'stopped':
      // Nothing to add: no process, no probe worth reporting. The chip and the
      // Start button already say everything true about this row.
      return null;
    case 'starting':
      return app.pty === false ? 'waiting for its process' : 'not answering yet';
    case 'running':
      // The measurement behind the chip, not the chip again.
      return app.health?.status
        ? `HTTP ${app.health.status} in ${Math.round(app.health.elapsedMs)} ms`
        : null;
    case 'gave_up':
      return 'could not be restarted — open the logs and start it by hand';
    case 'unreachable':
      switch (app.health?.reason) {
        case 'gateway':
          // The case a browser's opaque probe can never see.
          return `proxy is up but the server behind it is not (HTTP ${app.health.status})`;
        case 'timeout':
          return 'did not answer in time';
        default:
          return 'nothing is answering on its URL';
      }
    default:
      return null;
  }
}
