import { execFile } from 'node:child_process';
import net from 'node:net';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * "Is this URL one of MY web apps?" lives here. The whole app-url feature
 * hinges on telling a real local dev server apart from the flood of URLs
 * a terminal prints (Claude Code docs links, npm funding URLs, git
 * remotes, …). Those are categorically different from a dev server in two
 * ways this module checks:
 *
 *   1. host identity — a dev server's URL points at THIS machine
 *      (localhost, or this node's own Tailscale name/IP). github.com,
 *      docs.anthropic.com etc. match none of those.
 *   2. actually listening — something is really accepting connections on
 *      that port right now. A `localhost:3000` merely *mentioned* in output
 *      fails this; the server you're running passes it.
 *
 * Only a candidate that clears BOTH is offered. The probe must run here
 * (daemon-side, on the host) because only the host can connect to its own
 * localhost — which is also why detection can't live in the browser.
 */

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '::']);

// Cache the Tailscale self-identity (DNSName + IPs). `tailscale status` is a
// subprocess; we don't want to spawn it per detected URL. Refreshed lazily
// once the TTL lapses — the tailnet name/IP effectively never changes for a
// given host, so a long TTL is fine.
const IDENTITY_TTL_MS = 5 * 60_000;
interface SelfIdentity {
  /** Lowercased host strings that mean "this machine". */
  hosts: Set<string>;
  /** This node's MagicDNS name (no trailing dot), or null if not on a tailnet. */
  tailnetName: string | null;
}
let cached: { identity: SelfIdentity; at: number } | null = null;
let inflight: Promise<SelfIdentity> | null = null;

interface TailscaleStatus {
  Self?: { DNSName?: string; TailscaleIPs?: string[] };
}

async function loadTailscaleIdentity(): Promise<{ name: string | null; ips: string[] }> {
  try {
    const { stdout } = await execFileAsync('tailscale', ['status', '--json'], {
      timeout: 1500,
      maxBuffer: 4 * 1024 * 1024,
    });
    const status = JSON.parse(stdout) as TailscaleStatus;
    const dns = status.Self?.DNSName ?? '';
    // DNSName comes fully-qualified with a trailing dot — strip it.
    const name = dns ? dns.replace(/\.$/, '').toLowerCase() : null;
    const ips = status.Self?.TailscaleIPs ?? [];
    return { name, ips };
  } catch {
    // No tailscale binary, not logged in, or timed out — local identity only.
    return { name: null, ips: [] };
  }
}

async function computeIdentity(): Promise<SelfIdentity> {
  const { name, ips } = await loadTailscaleIdentity();
  const hosts = new Set<string>(LOCAL_HOSTS);
  if (name) hosts.add(name);
  for (const ip of ips) hosts.add(ip.toLowerCase());
  return { hosts, tailnetName: name };
}

async function getIdentity(now: number): Promise<SelfIdentity> {
  if (cached && now - cached.at < IDENTITY_TTL_MS) return cached.identity;
  if (inflight) return inflight;
  inflight = computeIdentity()
    .then((identity) => {
      cached = { identity, at: now };
      return identity;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** True iff `host` resolves to this machine (local form or this node's tailnet id). */
export async function isSelfHost(host: string, now = Date.now()): Promise<boolean> {
  const identity = await getIdentity(now);
  return identity.hosts.has(host.toLowerCase());
}

/**
 * Rewrite a same-machine URL to a viewer-reachable form: a `localhost`-style
 * host becomes this node's Tailscale name (so a phone over the tailnet can
 * reach it) when one exists. Already-tailnet or non-local hosts pass through.
 * Returns the original string on any parse failure — never throws.
 */
export async function toReachableUrl(rawUrl: string, now = Date.now()): Promise<string> {
  const identity = await getIdentity(now);
  if (!identity.tailnetName) return rawUrl;
  try {
    const u = new URL(rawUrl);
    if (!LOCAL_HOSTS.has(u.hostname.toLowerCase())) return rawUrl;
    u.hostname = identity.tailnetName;
    return u.toString();
  } catch {
    return rawUrl;
  }
}

/**
 * Is something accepting TCP connections on this port of the host right now?
 * Always probes 127.0.0.1 — every candidate is same-machine by construction
 * (isSelfHost gated it), and the host can always reach its own loopback even
 * when the server bound only to localhost. Short timeout; resolves false on
 * any error so a closed port is just "not listening", never a throw.
 */
export function probeListening(port: number, timeoutMs = 400): Promise<boolean> {
  return new Promise((resolve) => {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      resolve(false);
      return;
    }
    const socket = new net.Socket();
    let settled = false;
    const done = (listening: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(listening);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, '127.0.0.1');
  });
}
