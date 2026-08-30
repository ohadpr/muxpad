import { existsSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface Config {
  host: string;
  port: number;
  dataDir: string;
  /**
   * Unix-domain socket path where ptyd listens. The main server connects to
   * this via PtydClient; ptyd binds it on startup. Defaults to
   * `<dataDir>/ptyd.sock` so a custom data dir keeps the socket alongside
   * the database. Override via MUXPAD_PTYD_SOCKET for split deployments.
   */
  ptydSocketPath: string;
  /**
   * Second listener serving ONLY `<dataDir>/public/` — the internet-facing
   * artifact host behind Tailscale Funnel (see public-server.ts). Kept on a
   * dedicated port precisely so the funnel never touches the main
   * unauthenticated UI port.
   */
  publicPort: number;
  /**
   * Bind address for the public static server. 127.0.0.1 by default — the
   * funnel proxies to loopback, so nothing else needs to reach it directly.
   */
  publicHost: string;
  /**
   * MUXPAD_NO_FUNNEL=1 disables all tailscale exec on publish (isolated /
   * test instances). Publishes then return the local URL + a warning.
   */
  funnelEnabled: boolean;
  /**
   * MUXPAD_PUBLIC_BASE_URL — the origin published artifact links are built
   * from, overriding every discovered value. This is where a PERMANENT domain
   * belongs: Tailscale Funnel's :8443 is blocked outbound on many real
   * networks, so a discovered funnel url produces links that work for the
   * publisher and fail for the recipient. See public-base.ts for the full
   * precedence chain (and `muxpad publish --set-base` for an ephemeral tunnel,
   * which is a database pin rather than config).
   */
  publicBaseUrl?: string;
}

export function loadConfig(): Config {
  // One-time migration from the pre-rename data dir. If ~/.webagents holds
  // a real DB and the user doesn't have a meaningful ~/.muxpad yet, rename
  // in place so existing workspaces + panes carry over without surprise
  // data loss. We treat ~/.muxpad as "doesn't count" if it has no db.sqlite
  // — this catches the case where a stale daemon (or this very startup
  // racing) created an empty new dir before the migration could run.
  const home = homedir();
  const newDir = join(home, '.muxpad');
  const legacyDir = join(home, '.webagents');
  const legacyHasDb = existsSync(join(legacyDir, 'db.sqlite'));
  const newHasDb = existsSync(join(newDir, 'db.sqlite'));
  if (!process.env.MUXPAD_DATA_DIR && legacyHasDb && !newHasDb) {
    try {
      // Drop an empty placeholder if it exists; otherwise rename will fail.
      if (existsSync(newDir)) rmSync(newDir, { recursive: true, force: true });
      renameSync(legacyDir, newDir);
    } catch {
      // ignore — startup will create the new dir below
    }
  }

  const dataDir = process.env.MUXPAD_DATA_DIR ?? newDir;
  return {
    // Default to localhost. Tailscale users should set MUXPAD_HOST to their
    // tailnet IP (e.g. `tailscale ip -4`); Tailscale-only is the v1 access
    // boundary and there is no auth. NEVER default to 0.0.0.0.
    host: process.env.MUXPAD_HOST ?? '127.0.0.1',
    port: Number(process.env.MUXPAD_PORT ?? 7777),
    dataDir,
    ptydSocketPath: process.env.MUXPAD_PTYD_SOCKET ?? join(dataDir, 'ptyd.sock'),
    publicPort: Number(process.env.MUXPAD_PUBLIC_PORT ?? 7778),
    publicHost: process.env.MUXPAD_PUBLIC_HOST ?? '127.0.0.1',
    funnelEnabled: process.env.MUXPAD_NO_FUNNEL !== '1',
    ...(process.env.MUXPAD_PUBLIC_BASE_URL
      ? { publicBaseUrl: process.env.MUXPAD_PUBLIC_BASE_URL }
      : {}),
  };
}
