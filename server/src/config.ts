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
  };
}
