/**
 * WHERE THE `tailscale` BINARY COMES FROM — the one policy, stated once.
 *
 * There used to be two independent resolvers: this list inline in funnel.ts,
 * and `find_tailscale` in scripts/muxpad. They disagreed on the thing that
 * matters — funnel.ts ignored MUXPAD_TAILSCALE_BIN entirely — so an override
 * that kept the CLI off the real binary did nothing for the server.
 *
 * PRECEDENCE:
 *   MUXPAD_TAILSCALE_BIN   exclusive. See below.
 *   tailscale              on PATH. The normal install.
 *   the app bundle         /Applications/Tailscale.app/…, the Mac App Store
 *                          install, which ships no PATH entry.
 *
 * THE APP BUNDLE IS THE EXPENSIVE ONE. That binary reads the Tailscale app's
 * own container, which is what makes macOS put up "node would like to access
 * data from other apps" — a modal, on the machine running muxpad, every single
 * exec. So nothing here is about picking the fastest binary: it is about
 * knowing which candidate costs a prompt, so callers can avoid needing it at
 * all. The caching that does that lives in funnel.ts (per process) and
 * public-base.ts (persisted); this module only answers "which path".
 *
 * WHY THE OVERRIDE IS EXCLUSIVE — a set-but-missing MUXPAD_TAILSCALE_BIN
 * resolves to NOTHING rather than falling through to PATH or the bundle. The
 * override's main job is keeping tests off the real binary, and a test that
 * silently fell through would exec real tailscale: expose a funnel publicly,
 * and pop the prompt. "The binary I named, or none" is the only safe reading.
 * scripts/muxpad's find_tailscale follows the same rule, and
 * tailscale-bin.test.ts asserts the two still agree.
 */

/** The Mac App Store install's CLI. Reaching into it is what costs a prompt. */
export const TAILSCALE_APP_BIN = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';

/**
 * Candidate binaries in preference order. Callers try them in turn and only
 * fall through on ENOENT (a real tailscale error must surface, not get retried
 * against the same daemon under another name).
 */
export function tailscaleBins(env: Record<string, string | undefined> = process.env): string[] {
  const override = env.MUXPAD_TAILSCALE_BIN;
  if (override) return [override];
  return ['tailscale', TAILSCALE_APP_BIN];
}
