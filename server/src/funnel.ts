import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tailscaleBins } from './tailscale-bin.js';

/**
 * Tailscale Funnel management for the public artifact server
 * (docs/plans/2026-08-28-muxpad-publish.md §3).
 *
 * The funnel exposes the PUBLIC static port (never the main :7777 UI — that
 * is tailnet-served and unauthenticated) to the whole internet as
 * `https://<machine-dnsname>:8443/`. `funnel --bg` is idempotent on
 * tailscaled's side, so re-running it on every cold ensure() is safe; we
 * still cache the resolved base URL so a publish after the first doesn't
 * exec anything.
 *
 * Funnel being down/missing must never fail a publish: ensure() degrades to
 * the local URL plus a `warning` instead of throwing.
 *
 * KNOWN LIMITATION: under launchd (how the live daemon runs) the macOS
 * Tailscale app CLI refuses to run at all ("The Tailscale GUI failed to
 * start", CLIError 3) — it only works from user shells. So server-side
 * discovery here is best-effort for dev/non-launchd runs; the production
 * path is the CLI discovering the base url in the pane shell and passing a
 * `public_base_url` hint, which routes/publish.ts persists in the globals
 * KV and falls back to when ensure() warns.
 *
 * Because that failure is the NORMAL case in production, it is cached as firmly
 * as a success: one attempt per process, either way. An exec here is not free —
 * with no `tailscale` on PATH it runs the app-bundle binary, which reads another
 * app's container and makes macOS prompt the user (see tailscale-bin.ts). The
 * attempt is also remembered ACROSS processes, in public-base.ts.
 */

/** The public HTTPS port funnel listens on (one of 443/8443/10000). */
export const FUNNEL_PORT = 8443;

export interface FunnelState {
  /** URL base to prefix slugs with, no trailing slash. */
  baseUrl: string;
  /** Present when the funnel could not be ensured; baseUrl is then local. */
  warning?: string;
}

export interface Funnel {
  ensure(): Promise<FunnelState>;
}

export type ExecFn = (cmd: string, args: string[]) => Promise<{ stdout: string }>;

/**
 * A Funnel that never execs anything and always answers with the local
 * public-port URL + a fixed warning. Used when MUXPAD_NO_FUNNEL=1 (tests,
 * isolated instances) and as the createApp default when no publish deps are
 * wired — so no test path can ever expose anything publicly by accident.
 */
export function localFunnel(publicPort: number, warning: string): Funnel {
  return {
    ensure: async () => ({ baseUrl: `http://127.0.0.1:${publicPort}`, warning }),
  };
}

const defaultExec: ExecFn = async (cmd, args) => {
  // `tailscale status --json` grows with peer count — give it real headroom
  // over execFile's 1 MB default.
  const { stdout } = await promisify(execFile)(cmd, args, { maxBuffer: 10 * 1024 * 1024 });
  return { stdout };
};

export function createTailscaleFunnel(opts: {
  publicPort: number;
  exec?: ExecFn;
  bins?: string[];
  /** Injectable for tests; defaults to process.env. Read for the bin override. */
  env?: Record<string, string | undefined>;
}): Funnel {
  const exec = opts.exec ?? defaultExec;
  const bins = opts.bins ?? tailscaleBins(opts.env);
  let resolvedBin: string | null = null;
  let baseUrl: string | null = null;
  // The FAILURE is cached as hard as the success, and that is the fix for the
  // reported bug rather than an optimisation. Under launchd the app-bundle CLI
  // never works (CLIError 3), so an uncached failure meant two execs on every
  // single publish, and two chances for macOS to ask about reading another
  // app's data. One process, one attempt, whichever way it goes.
  //
  // Per-process only — which is the right scope HERE, because a restarted
  // daemon genuinely should re-check. What must not be re-checked on every
  // command is persisted a layer up, in public-base.ts.
  let failed: FunnelState | null = null;

  // Try candidates in order; only a missing binary (ENOENT) falls through to
  // the next one — a real tailscale error (funnel not permitted, logged out)
  // should surface as the warning, not get retried against the same daemon
  // via a different binary path.
  async function run(args: string[]): Promise<string> {
    const candidates = resolvedBin ? [resolvedBin] : bins;
    let lastErr: unknown = new Error('no tailscale binary configured');
    for (const bin of candidates) {
      try {
        const { stdout } = await exec(bin, args);
        resolvedBin = bin;
        return stdout;
      } catch (err) {
        lastErr = err;
        if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err;
      }
    }
    throw lastErr;
  }

  return {
    async ensure(): Promise<FunnelState> {
      if (baseUrl) return { baseUrl };
      if (failed) return failed;
      try {
        // Idempotent: tailscaled treats a repeat --bg mapping as a no-op.
        await run([
          'funnel',
          '--bg',
          `--https=${FUNNEL_PORT}`,
          `http://127.0.0.1:${opts.publicPort}`,
        ]);
        const out = await run(['status', '--json']);
        const dns = String(JSON.parse(out)?.Self?.DNSName ?? '').replace(/\.+$/, '');
        if (!dns) throw new Error('tailscale status --json has no Self.DNSName');
        baseUrl = `https://${dns}:${FUNNEL_PORT}`;
        return { baseUrl };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failed = {
          baseUrl: `http://127.0.0.1:${opts.publicPort}`,
          warning: `tailscale funnel unavailable — URL is local-only: ${message}`,
        };
        return failed;
      }
    },
  };
}
