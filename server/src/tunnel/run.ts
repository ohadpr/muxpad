import { spawn } from 'node:child_process';
import { TUNNEL_HEALTHY_RUN_MS, parseQuickTunnelUrl, tunnelBackoffMs } from './cloudflared.js';

/**
 * `muxpad tunnel --port <public port>` — the process that IS the tunnel.
 *
 * It runs inside the tunnel app's pane, so ptyd owns it and it outlives every
 * main-server restart (see TunnelApp.ts for why that is the decisive property).
 * Its job is narrow and it is the only place in muxpad that knows what
 * cloudflared's output looks like:
 *
 *   1. refuse to tunnel anything that is not the hardened public server;
 *   2. run `cloudflared tunnel --url http://127.0.0.1:<port>`;
 *   3. read the minted hostname out of its output and ANNOUNCE it;
 *   4. the moment cloudflared exits, RETRACT it — then back off and restart,
 *      which mints a different hostname, which is announced in turn.
 *
 * (3) and (4) are the feature. Supervision without them keeps a dead name
 * pinned with perfect uptime.
 *
 * WHY THE ANNOUNCE IS AN HTTP CALL TO THE MAIN SERVER rather than a direct
 * database write: policy belongs on the server. The server decides whether a
 * tunnel url may be pinned at all (MUXPAD_PUBLIC_BASE_URL outranks it), owns
 * the precedence chain, and owns the app row. This process reports a fact and
 * is told nothing else.
 *
 * EVERY ANNOUNCE IS BEST-EFFORT. The main server restarting is normal — it is
 * the case this whole design exists to survive — so a failed call is logged and
 * retried on the heartbeat, never fatal.
 */

/** How often a live url is re-announced. */
export const TUNNEL_ANNOUNCE_INTERVAL_MS = 30_000;

/**
 * The heartbeat is not belt-and-braces; it closes a real hole. The tunnel
 * outlives the main server, so a main-server restart wipes nothing but LOSES
 * the announce it never received if it was down when the url was minted. Left
 * to itself, muxpad would then have a perfectly healthy tunnel it had no idea
 * about. Re-stating the url on a slow interval means the gap closes by itself
 * within half a minute, with no coordination and nothing to remember.
 */

export interface TunnelChild {
  /** Raw output chunks — stdout and stderr merged, as they arrive. */
  onOutput(cb: (chunk: string) => void): void;
  /** Resolves when the process is gone. */
  exited: Promise<{ code: number | null; signal: string | null }>;
  kill(): void;
}

export interface TunnelRunnerDeps {
  /** The port to expose. MUST be the public static server's. */
  publicPort: number;
  /** Main-server base, e.g. `http://127.0.0.1:7777`. */
  apiUrl: string;
  /** This pane's id — the ownership token the server records with the url. */
  paneId?: string | null;
  /** Resolved cloudflared path, or null when it is not installed. */
  bin: string | null;
  spawnChild?: (bin: string, args: string[]) => TunnelChild;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (msg: string) => void;
  /** Where cloudflared's own bytes go. Defaults to this process's stdout — so
   *  `muxpad app logs tunnel` is cloudflared verbatim, not a reformatting. */
  out?: (chunk: string) => void;
  /** Test hook: stop after this many cloudflared exits. Undefined = forever. */
  maxRuns?: number;
  announceIntervalMs?: number;
}

export type TunnelRunOutcome = 'no-binary' | 'refused' | 'stopped' | 'max-runs';

export interface TunnelRunner {
  run(): Promise<TunnelRunOutcome>;
  stop(): void;
}

/**
 * Positively identify the thing about to be put on the open internet.
 *
 * DECISION 5, ENFORCED RATHER THAN DOCUMENTED. The main muxpad app has no
 * authentication — its own source says "reachability IS authorization" — and it
 * serves a terminal. Exposing it would be unrecoverable. So the target is not
 * merely checked against a blocklist of ports; it must ANSWER LIKE THE PUBLIC
 * SERVER: root 404s (public-server.ts serves nothing at `/` on purpose, so
 * knowing the hostname reveals nothing) and every response, 404s included,
 * carries the sandbox CSP.
 *
 * A positive fingerprint rather than `port !== 7777` because the blocklist is
 * wrong in exactly the case that matters: an isolated instance, a
 * MUXPAD_PORT override, a future second app. The main server answers `/` with
 * 200 and the SPA and carries no sandbox header, so it can never pass this.
 */
export async function verifyPublicTarget(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  let res: Response;
  try {
    res = await fetchImpl(`${url}/`, { method: 'GET', redirect: 'manual' });
  } catch (err) {
    return { ok: false, reason: `nothing is listening on ${url} (${(err as Error).message})` };
  }
  const csp = res.headers.get('content-security-policy') ?? '';
  if (res.status !== 404 || !csp.startsWith('sandbox')) {
    return {
      ok: false,
      reason: `${url} does not look like muxpad's public artifact server (expected a 404 with a sandbox CSP at /, got ${res.status} csp="${csp}") — refusing to tunnel it`,
    };
  }
  return { ok: true };
}

/** A real cloudflared process, with stdout and stderr merged into one stream. */
export function spawnCloudflared(bin: string, args: string[]): TunnelChild {
  const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const listeners: Array<(chunk: string) => void> = [];
  const emit = (buf: Buffer) => {
    const s = buf.toString('utf8');
    for (const cb of listeners) cb(s);
  };
  child.stdout?.on('data', emit);
  child.stderr?.on('data', emit);
  return {
    onOutput: (cb) => listeners.push(cb),
    exited: new Promise((resolve) => {
      // 'close' rather than 'exit' so the output streams have drained — the
      // hostname banner arrives on stderr, and exiting on 'exit' can drop the
      // last chunk of a short-lived run, which is exactly the run whose error
      // text we most want to report.
      child.once('close', (code, signal) => resolve({ code, signal }));
      child.once('error', () => resolve({ code: null, signal: null }));
    }),
    kill: () => {
      child.kill('SIGTERM');
    },
  };
}

export function createTunnelRunner(deps: TunnelRunnerDeps): TunnelRunner {
  const log = deps.log ?? ((m: string) => console.log(m));
  const out = deps.out ?? ((chunk: string) => void process.stdout.write(chunk));
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const doFetch = deps.fetchImpl ?? fetch;
  const spawnChild = deps.spawnChild ?? spawnCloudflared;
  const announceEvery = deps.announceIntervalMs ?? TUNNEL_ANNOUNCE_INTERVAL_MS;
  const endpoint = `${deps.apiUrl.replace(/\/$/, '')}/api/publish/tunnel`;
  const localUrl = `http://127.0.0.1:${deps.publicPort}`;

  let stopped = false;
  let current: string | null = null;
  let child: TunnelChild | null = null;

  const announceUp = async (url: string): Promise<void> => {
    try {
      const res = await doFetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url, pane_id: deps.paneId ?? null }),
      });
      if (!res.ok) log(`muxpad tunnel: server refused the url (${res.status})`);
    } catch (err) {
      log(
        `muxpad tunnel: could not reach the server to announce ${url} (${(err as Error).message})`,
      );
    }
  };

  const announceDown = async (error?: string, attempts?: number): Promise<void> => {
    try {
      await doFetch(endpoint, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...(error ? { error } : {}),
          ...(attempts !== undefined ? { attempts } : {}),
        }),
      });
    } catch {
      // The server being unreachable while we retract is survivable: the url's
      // owning pane is recorded with it, so a value we failed to clear is still
      // invalidated the moment this pane is replaced — and the reachability
      // probe demotes it meanwhile.
    }
  };

  // Re-state the live url on a slow interval. Runs for the process's whole
  // life; it is a no-op whenever there is no url. `announceIntervalMs: 0`
  // turns it off, which is what tests that inject an instantaneous `sleep`
  // want — a heartbeat whose wait is zero is a busy loop, not a heartbeat.
  const heartbeat = async (): Promise<void> => {
    while (!stopped) {
      await sleep(announceEvery);
      if (stopped || !current) continue;
      await announceUp(current);
    }
  };

  const run = async (): Promise<TunnelRunOutcome> => {
    if (!deps.bin) {
      const reason =
        'cloudflared is not installed — install it (brew install cloudflared) or set MUXPAD_CLOUDFLARED_BIN';
      log(`muxpad tunnel: ${reason}`);
      await announceDown(reason, 1);
      return 'no-binary';
    }
    const target = await verifyPublicTarget(localUrl, doFetch);
    if (!target.ok) {
      log(`muxpad tunnel: ${target.reason}`);
      await announceDown(target.reason, 1);
      return 'refused';
    }

    if (announceEvery > 0) void heartbeat();
    log(`muxpad tunnel: exposing ${localUrl} via ${deps.bin}`);

    let attempt = 0;
    let runs = 0;
    for (;;) {
      if (stopped) break;
      const startedAt = now();
      let sawUrl = false;
      const c = spawnChild(deps.bin, ['tunnel', '--url', localUrl, '--no-autoupdate']);
      child = c;
      c.onOutput((chunk) => {
        // Verbatim, so `muxpad app logs tunnel` is cloudflared's own output —
        // no new log format to learn when something goes wrong.
        out(chunk);
        const url = parseQuickTunnelUrl(chunk);
        if (!url || url === current) return;
        sawUrl = true;
        current = url;
        log(`muxpad tunnel: up at ${url}`);
        void announceUp(url);
      });
      const { code, signal } = await c.exited;
      child = null;
      const ran = now() - startedAt;
      // RETRACT FIRST, then think. Every millisecond between cloudflared dying
      // and the database forgetting its hostname is a millisecond in which
      // muxpad hands out links to a name nothing is serving — the original bug,
      // in miniature. Backoff, logging and the restart decision all happen
      // after this.
      current = null;
      runs += 1;

      if (stopped) {
        await announceDown();
        break;
      }

      // A run that lasted forgives the past: a tunnel up for an hour that drops
      // should retry in two seconds, not inherit an hour-old failure's ceiling.
      if (sawUrl && ran >= TUNNEL_HEALTHY_RUN_MS) attempt = 0;
      attempt += 1;
      const why = `cloudflared exited (code ${code ?? 'null'}${signal ? `, ${signal}` : ''}) after ${Math.round(ran / 1000)}s`;
      await announceDown(why, attempt);

      if (deps.maxRuns !== undefined && runs >= deps.maxRuns) {
        stopped = true; // let the heartbeat fall out of its loop too
        return 'max-runs';
      }

      const wait = tunnelBackoffMs(attempt);
      log(`muxpad tunnel: ${why} — restarting in ${Math.round(wait / 1000)}s (attempt ${attempt})`);
      await sleep(wait);
    }
    return 'stopped';
  };

  return {
    run,
    stop: () => {
      stopped = true;
      child?.kill();
    },
  };
}
