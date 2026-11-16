import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A browser that is NOT on this Mac — reached over CDP instead of spawned.
 *
 * WHY. muxpad drives chrome-headless-shell because a full Chrome bundle on macOS
 * raises permission prompts on the owner's physical screen (see findChrome.ts).
 * That binary is also the most fingerprintable browser there is, so bot checks
 * fail that a real browser passes. A real, headful browser has to run somewhere
 * that has no screen the owner can see — a Linux VM, another machine — and the
 * host has to be able to DIAL it rather than launch it. This is that seam; a VM
 * is one thing that can sit behind it.
 *
 * THE PROTOCOL is a provider, not a bare CDP url, because isolation is per
 * session: every chat has its own profile, cookies and pages, and one shared
 * Chrome would let any agent attach to any other chat's tabs. So a provider is
 * asked for THIS profile's browser and answers with its endpoint:
 *
 *   POST   {provider}/browsers/{profile}  → 200 { "cdp": "http://host:port" }
 *   DELETE {provider}/browsers/{profile}  → stop it (best-effort)
 *
 * The provider owns how — one Chrome per profile inside one VM is the intended
 * shape — and the host treats `cdp` exactly as it treats a Chrome it spawned.
 *
 * OFF BY DEFAULT. Opt in by writing `{ "provider": "http://…" }` to
 * `<dataDir>/browser-remote.json`; delete the file to opt out. A file rather
 * than an environment variable because the hosts are started by the app
 * registry, whose environment nobody controls from a shell, and a file can be
 * flipped without restarting the server.
 *
 * AND IT FALLS BACK. A provider that is down, slow or wrong must not break
 * browsing: every failure here is a reason logged and the local headless shell
 * started exactly as before.
 */

export const REMOTE_CONFIG_FILE = 'browser-remote.json';

/** Long enough for a lazily-started VM's warm path; a cold one falls back. */
export const REMOTE_ACQUIRE_TIMEOUT_MS = 15_000;

export interface RemoteBrowserConfig {
  provider: string;
}

/** The opt-in, or null. A malformed file is treated as absent, never as an error. */
export function readRemoteConfig(
  dataDir: string,
  read: (path: string) => string = (p) => readFileSync(p, 'utf8'),
): RemoteBrowserConfig | null {
  let raw: unknown;
  try {
    raw = JSON.parse(read(join(dataDir, REMOTE_CONFIG_FILE)));
  } catch {
    return null;
  }
  const provider = (raw as { provider?: unknown } | null)?.provider;
  if (typeof provider !== 'string') return null;
  try {
    const url = new URL(provider);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return { provider: url.toString().replace(/\/$/, '') };
  } catch {
    return null;
  }
}

export type BrowserEndpoint =
  | { kind: 'remote'; endpoint: string }
  | { kind: 'local'; reason: string | null };

/**
 * Which browser this host should drive. Never throws: anything short of a
 * provider that answered AND a CDP endpoint that answered is `local`.
 */
export async function chooseBrowserEndpoint(opts: {
  config: RemoteBrowserConfig | null;
  profile: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<BrowserEndpoint> {
  if (!opts.config) return { kind: 'local', reason: null };
  const doFetch = opts.fetchImpl ?? fetch;
  const deadline = AbortSignal.timeout(opts.timeoutMs ?? REMOTE_ACQUIRE_TIMEOUT_MS);
  const where = `${opts.config.provider}/browsers/${encodeURIComponent(opts.profile)}`;
  let endpoint: string;
  try {
    const res = await doFetch(where, { method: 'POST', signal: deadline });
    if (!res.ok) return { kind: 'local', reason: `provider answered ${res.status}` };
    const body = (await res.json()) as { cdp?: unknown };
    if (typeof body.cdp !== 'string') return { kind: 'local', reason: 'provider gave no cdp url' };
    const url = new URL(body.cdp);
    if (url.protocol !== 'http:' && url.protocol !== 'https:')
      return { kind: 'local', reason: 'provider cdp url is not http' };
    endpoint = url.toString().replace(/\/$/, '');
  } catch (err) {
    return {
      kind: 'local',
      reason: `provider unreachable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  // A provider that says yes is not a browser that answers. Check before
  // committing to it — a host attached to nothing is a black viewer.
  try {
    const res = await doFetch(`${endpoint}/json/version`, { signal: deadline });
    if (!res.ok) return { kind: 'local', reason: `remote CDP answered ${res.status}` };
    await res.arrayBuffer().catch(() => undefined);
  } catch (err) {
    return {
      kind: 'local',
      reason: `remote CDP unreachable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return { kind: 'remote', endpoint };
}

/** Tell the provider this profile's browser is no longer wanted. Best-effort. */
export async function releaseRemoteBrowser(
  config: RemoteBrowserConfig,
  profile: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  try {
    await fetchImpl(`${config.provider}/browsers/${encodeURIComponent(profile)}`, {
      method: 'DELETE',
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    // The provider's own idle stop is the backstop.
  }
}
