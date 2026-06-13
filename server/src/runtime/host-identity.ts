import { execFile } from 'node:child_process';
import { lookup as dnsLookup } from 'node:dns/promises';
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
// "All interfaces" bind addresses: valid to listen on, but NOT loadable as a
// destination in a browser. When we can't rewrite to a tailnet name we must
// swap these for a concrete loopback host or the web face would fail to load.
const UNSPECIFIED_HOSTS = new Set(['0.0.0.0', '::']);

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

/**
 * Lowercase a URL host and strip the brackets Node's URL API wraps around IPv6
 * literals: `new URL('http://[::1]:3000').hostname` → `[::1]`. Our host sets
 * (LOCAL_HOSTS, the identity set, UNSPECIFIED_HOSTS) all store the bare form,
 * so every membership check must compare against the unbracketed host or an
 * IPv6 server URL — e.g. Python 3.14's default `http://[::]:8000/` banner —
 * never matches and the app is silently dropped before it's even probed.
 */
export function normalizeHost(host: string): string {
  const lower = host.toLowerCase();
  return lower.startsWith('[') && lower.endsWith(']') ? lower.slice(1, -1) : lower;
}

/**
 * Is this IP literal non-publicly-routable — loopback, RFC1918 private,
 * link-local, or CGNAT (100.64/10, where Tailscale and other overlay VPNs
 * hand out addresses)? A server at such an address is on this machine or a
 * network the viewer shares, never the public internet. This is the
 * first-principles definition of "local" — no dependency on any specific VPN
 * or tool being installed.
 */
export function isPrivateAddress(ip: string): boolean {
  const h = normalizeHost(ip);
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const octets = v4.slice(1).map(Number);
    if (octets.some((n) => n > 255)) return false;
    const [a, b] = octets as [number, number, number, number];
    if (a === 127 || a === 10) return true; // loopback, private
    if (a === 192 && b === 168) return true; // private
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 169 && b === 254) return true; // link-local
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT (Tailscale et al.)
    return false;
  }
  if (h === '::1') return true; // loopback
  if (h.startsWith('fe80')) return true; // link-local
  if (h.startsWith('fc') || h.startsWith('fd')) return true; // unique-local (incl. Tailscale fd7a)
  return false;
}

/**
 * True iff a printed URL's host denotes a server on this machine or a network
 * the viewer shares — the gate that keeps github/docs/registry URLs out of the
 * dropdown. A local form or private-range IP literal passes immediately; a
 * hostname (a *.local box, a tailnet MagicDNS name, a LAN alias) is resolved
 * once and accepted iff it points at a private address. github.com resolves to
 * a public IP and is rejected. Listening is confirmed separately by the probe.
 */
export async function isSelfHost(host: string): Promise<boolean> {
  const h = normalizeHost(host);
  if (LOCAL_HOSTS.has(h) || isPrivateAddress(h)) return true;
  const address = await resolveWithTimeout(h);
  return address !== null && isPrivateAddress(address);
}

// Cap how long a hostname resolution may stall the (server-side) detection
// refresh path. dns.lookup → getaddrinfo has no built-in timeout and a
// non-resolving name can hang for the OS resolver's full retry budget
// (seconds); a pane printing bogus hostnames must not wedge detection. On
// timeout we treat the host as "not resolved" (→ not self).
const DNS_LOOKUP_TIMEOUT_MS = 500;

function resolveWithTimeout(
  host: string,
  timeoutMs = DNS_LOOKUP_TIMEOUT_MS,
): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (addr: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(addr);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    timer.unref?.();
    dnsLookup(host).then(
      ({ address }) => done(address),
      () => done(null),
    );
  });
}

/**
 * Rewrite a same-machine URL to a viewer-reachable form: a `localhost`-style
 * host becomes this node's Tailscale name (so a phone over the tailnet can
 * reach it) when one exists. Already-tailnet or non-local hosts pass through.
 * Returns the original string on any parse failure — never throws.
 */
export async function toReachableUrl(rawUrl: string, now = Date.now()): Promise<string> {
  const identity = await getIdentity(now);
  try {
    const u = new URL(rawUrl);
    const host = normalizeHost(u.hostname);
    if (!LOCAL_HOSTS.has(host)) return rawUrl;
    if (identity.tailnetName) {
      // Prefer the tailnet name — reachable from any device on the tailnet.
      u.hostname = identity.tailnetName;
      return u.toString();
    }
    if (UNSPECIFIED_HOSTS.has(host)) {
      // No tailnet to rewrite to, but 0.0.0.0/:: won't load in a browser —
      // swap for loopback so the local (same-machine) viewer can reach it.
      // Match the probe's address family (see probeTargets): an IPv6 `::`
      // bind may be v6-only, so a 127.0.0.1 URL would fail to load even
      // though the probe confirmed it listening via ::1. URL hostnames take
      // the bracketed IPv6 form.
      u.hostname = host === '::' ? '[::1]' : '127.0.0.1';
      return u.toString();
    }
    return rawUrl;
  } catch {
    return rawUrl;
  }
}

/**
 * Is something accepting TCP connections for this candidate right now? The
 * candidate's own host decides where to dial — probing a fixed loopback is
 * wrong for a server bound to a concrete interface:
 *
 *   - an unspecified bind (0.0.0.0 / ::) can't be connected to directly, so we
 *     probe the matching loopback — a server bound to all interfaces is
 *     listening there too;
 *   - any concrete host (127.0.0.1, ::1, this node's Tailscale IP/name, a LAN
 *     IP) is dialed as-is. A dev server bound ONLY to e.g. the Tailscale IP is
 *     not on 127.0.0.1, so the old loopback-only probe reported it down and the
 *     app never surfaced.
 *
 * isSelfHost has already gated the host to this machine. Short timeout;
 * resolves true if any target connects, false on every error/timeout so a
 * closed port is just "not listening", never a throw.
 */
export function probeListening(host: string, port: number, timeoutMs = 400): Promise<boolean> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return Promise.resolve(false);
  const targets = probeTargets(host);
  return Promise.all(targets.map((t) => connectOnce(t, port, timeoutMs))).then((rs) =>
    rs.some(Boolean),
  );
}

/** Where to actually dial for a candidate host (see probeListening). */
function probeTargets(host: string): string[] {
  const h = normalizeHost(host);
  if (h === '0.0.0.0') return ['127.0.0.1'];
  if (h === '::') return ['::1'];
  return [h];
}

/** Resolve true iff a TCP connection to host:port completes within timeoutMs. */
function connectOnce(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
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
    socket.connect(port, host);
  });
}
