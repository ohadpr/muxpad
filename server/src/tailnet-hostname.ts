import { promises as dns } from 'node:dns';
import { networkInterfaces } from 'node:os';

/**
 * THIS MACHINE'S TAILNET NAME, WITHOUT TOUCHING TAILSCALE.
 *
 * Tailscale here is a Mac App Store install: the only CLI lives inside the
 * sandboxed app bundle at /Applications/Tailscale.app (see tailscale-bin.ts),
 * there is no PATH entry and there is not going to be one, and every exec of
 * that binary reads the app's own container — which is exactly what makes macOS
 * put up "node would like to access data from other apps". So `tailscale status
 * --json` is not a cheap way to learn the hostname. It is a modal dialog.
 *
 * It is also unnecessary. The machine already knows its tailnet name twice over,
 * through ordinary system interfaces that no sandbox guards:
 *
 *   1. tailscaled assigns this host an address in 100.64.0.0/10 (CGNAT) on a
 *      utun interface. Reading interface config is not privileged.
 *   2. MagicDNS answers the PTR for it with the full name. On macOS Tailscale
 *      installs itself into the resolver (/etc/resolv.conf here lists
 *      `nameserver 100.100.100.100`), so an ordinary reverse lookup resolves it.
 *
 * Verified on the affected machine: 100.64.0.1 → example-host.example-tailnet.ts.net,
 * matching its persisted base exactly, with no prompt.
 *
 * WHY NOT `scutil --get LocalHostName`, which is also prompt-free: on this
 * machine it answers `home`, while the tailnet name is `example-host`. The two
 * are unrelated settings, so composing LocalHostName with the tailnet suffix
 * would mint `home.example-tailnet.ts.net` — a wrong host and a public link that
 * cannot work. The PTR is the machine's actual tailnet identity rather than a
 * guess assembled from parts.
 *
 * WHAT THIS DOES NOT DO: ensure the Funnel mapping. Only the real CLI can create
 * one, so on a machine where Funnel has never been set up this yields a
 * correctly-shaped :8443 url that nothing is listening behind. That is caught
 * where it should be — the publish path probes the base and warns when it does
 * not answer — and it is a one-time setup step, not a reason to exec on every
 * publish. See scripts/muxpad's publish_base_url for the CLI's last resort.
 */

export interface TailnetHostnameDeps {
  interfaces?: () => ReturnType<typeof networkInterfaces>;
  reverse?: (ip: string) => Promise<string[]>;
}

/**
 * 100.64.0.0/10 — Tailscale's address space. Checked numerically rather than by
 * prefix match: `100.5.x` and `100.200.x` are ORDINARY public addresses, and
 * treating all of 100/8 as tailnet would reverse-resolve a stranger's host and
 * then believe whatever name came back.
 */
function isTailscaleAddress(ip: string): boolean {
  const parts = ip.split('.');
  if (parts.length !== 4) return false;
  const nums = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : Number.NaN));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  return nums[0] === 100 && (nums[1] as number) >= 64 && (nums[1] as number) <= 127;
}

/**
 * A PTR answer is only believed when it is a `*.ts.net` name. Anything else
 * means MagicDNS is off, or something else on the network answered the PTR for
 * CGNAT space — and a hostname from that source would build a dead public link.
 *
 * `endsWith('.ts.net')`, so a name that merely CONTAINS the string
 * (`ts.net.attacker.example`) is refused, and so is a bare `ts.net` with no
 * machine part.
 */
function isTailnetName(name: string): boolean {
  return name.length > 0 && name.length <= 253 && name.endsWith('.ts.net');
}

/**
 * The full tailnet FQDN (no trailing dot), or null. NEVER throws and never
 * execs: this runs on the publish path, where the honest answer to "I could not
 * work it out" is to fall through to the next tier, not to fail the publish.
 */
export async function tailnetHostname(deps: TailnetHostnameDeps = {}): Promise<string | null> {
  const ifaces = deps.interfaces ?? networkInterfaces;
  const reverse = deps.reverse ?? ((ip: string) => dns.reverse(ip));

  let address: string | null = null;
  try {
    for (const addrs of Object.values(ifaces())) {
      for (const a of addrs ?? []) {
        if (isTailscaleAddress(a.address)) {
          address = a.address;
          break;
        }
      }
      if (address) break;
    }
  } catch {
    return null;
  }
  if (!address) return null;

  try {
    const names = await reverse(address);
    for (const raw of names ?? []) {
      const name = String(raw).replace(/\.+$/, '').toLowerCase();
      if (isTailnetName(name)) return name;
    }
  } catch {
    // ENOTFOUND / ESERVFAIL is the normal answer when tailscaled is down.
    return null;
  }
  return null;
}
