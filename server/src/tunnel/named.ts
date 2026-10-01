import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A NAMED Cloudflare tunnel — the answer that is public AND permanent, and the
 * end of the problem the other two candidates only mitigate.
 *
 * WHY THIS IS DIFFERENT FROM THE QUICK TUNNEL, mechanically and not just in
 * degree. A quick tunnel's hostname is ASSIGNED BY CLOUDFLARE AT CONNECT TIME:
 * there is no flag to pin it, the process owns it, and when the process dies the
 * name is released back into the pool and can never be reclaimed. That is why
 * every link built from one has a shelf life measured in deploys.
 *
 * A named tunnel inverts every part of that. You create it once, Cloudflare
 * gives it a stable UUID, `cloudflared tunnel route dns` writes a CNAME from a
 * hostname YOU OWN to `<UUID>.cfargotunnel.com`, and the credentials to serve
 * that UUID sit in a file on disk. Restart cloudflared, reboot the machine,
 * change ISP, get a new IP — the CNAME still points at the same UUID and the same
 * credentials still claim it. The hostname stops being something Cloudflare hands
 * you and becomes something you have.
 *
 * SO MUXPAD DOES NOT DISCOVER IT — IT IS TOLD, ONCE. There is nothing to parse
 * out of cloudflared's output, because the hostname is configuration rather than
 * a result. `muxpad tunnel setup` writes this file; everything else reads it.
 *
 * AND THAT IS WHY NO PLIST IS NEEDED. The hostname lands in the ordinary `tunnel`
 * candidate, `baseDurability()` reads a real domain off the host and classes it
 * `permanent`, and the durability ranking in public-base.ts puts it above the
 * tailnet fallback and the quick tunnel without one line of new precedence code.
 * MUXPAD_PUBLIC_BASE_URL still works and still outranks this, for anyone fronting
 * the public port with something that is not a cloudflared at all.
 */

/** Name of the config file, under `<dataDir>`. Written by `muxpad tunnel setup`. */
export const NAMED_TUNNEL_FILE = 'tunnel.json';

export interface NamedTunnel {
  /** The tunnel's name, as `cloudflared tunnel create <name>` was given it. */
  name: string;
  /** The hostname routed to it — a bare hostname, no scheme and no port. */
  hostname: string;
  /** `~/.cloudflared/<UUID>.json`. Its EXISTENCE is the runnable test. */
  credentialsFile: string;
}

/**
 * One DNS label, or several joined by dots. No scheme, no port, no path, no
 * spaces — because this value becomes the origin of every published link, and
 * a stray scheme downstream produces `https://https://x`.
 */
const HOSTNAME_RE =
  /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i;

/**
 * What may be passed to cloudflared as a tunnel name. Deliberately narrower than
 * what Cloudflare accepts: this string is handed to a spawned process as a
 * positional argument, so anything shell-ish or flag-shaped is refused here
 * rather than trusted to quoting.
 */
const TUNNEL_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/i;

/**
 * The configured named tunnel, or null.
 *
 * NULL IS THE ORDINARY ANSWER and never an exception. A machine that has not run
 * `muxpad tunnel setup` has no named tunnel, and a config file that is
 * half-written, hand-edited or points at credentials that have been deleted is
 * treated exactly the same way — this is read on the publish path, and the
 * fallbacks (the tailnet base, the quick tunnel) are both still there.
 *
 * THE CREDENTIALS CHECK IS THE LOAD-BEARING ONE. The config file is a
 * note-to-self; `~/.cloudflared/<UUID>.json` is what makes the tunnel actually
 * runnable. Believing the note alone would mean announcing a permanent hostname
 * and then crash-looping a cloudflared that cannot authenticate, with every
 * published link pointing at a name nothing is serving — the original bug, with
 * a better-looking hostname on it.
 */
export function readNamedTunnel(
  dataDir: string,
  opts?: { exists?: (path: string) => boolean },
): NamedTunnel | null {
  const exists = opts?.exists ?? existsSync;
  let raw: string;
  try {
    raw = readFileSync(join(dataDir, NAMED_TUNNEL_FILE), 'utf-8');
  } catch {
    return null;
  }
  let parsed: { name?: unknown; hostname?: unknown; credentials_file?: unknown };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const name = typeof parsed?.name === 'string' ? parsed.name : '';
  const hostname = typeof parsed?.hostname === 'string' ? parsed.hostname : '';
  const credentialsFile =
    typeof parsed?.credentials_file === 'string' ? parsed.credentials_file : '';
  if (!TUNNEL_NAME_RE.test(name)) return null;
  if (!HOSTNAME_RE.test(hostname)) return null;
  if (!credentialsFile || !exists(credentialsFile)) return null;
  return { name, hostname, credentialsFile };
}

/**
 * The base url a named tunnel serves.
 *
 * Port 443, implicitly — which is the difference that makes it shareable at all.
 * The tailnet fallback carries `:8443`, and public-base.ts has documented from
 * the start that plenty of corporate, mobile and guest networks block outbound
 * to non-standard HTTPS ports.
 */
export function namedTunnelBaseUrl(t: NamedTunnel): string {
  return `https://${t.hostname}`;
}

/**
 * Argument vector for a NAMED tunnel.
 *
 * Read off the installed binary's own `--help` (cloudflared 2026.8.2), not from
 * memory, because the placement is not guessable:
 *
 *   cloudflared tunnel [tunnel command options] run [run options] [TUNNEL]
 *
 * `--no-autoupdate` is a TUNNEL option, so it goes before `run`; `--url` is a
 * `run` option, so it goes after; the tunnel name is the final positional.
 *
 * NO `--config`, DELIBERATELY. A config file would let cloudflared choose its own
 * ingress, which bypasses both guards that keep the unauthenticated main server
 * off the internet: the port muxpad passes, and run.ts's refusal to tunnel
 * anything that does not answer like the hardened public server. The port is
 * always ours and always on the command line.
 */
export function namedTunnelArgs(t: NamedTunnel, localUrl: string): string[] {
  return ['tunnel', '--no-autoupdate', 'run', '--url', localUrl, t.name];
}

/** Argument vector for a quick tunnel — unchanged, and pinned by a test. */
export function quickTunnelArgs(localUrl: string): string[] {
  return ['tunnel', '--url', localUrl, '--no-autoupdate'];
}
