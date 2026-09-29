import { spawn } from 'node:child_process';
import { TUNNEL_HEALTHY_RUN_MS, parseQuickTunnelUrl, tunnelBackoffMs } from './cloudflared.js';

/**
 * `muxpad tunnel --port <public port>` — the process that IS the tunnel.
 *
 * It runs under a supervisor that is not the main server — either the tunnel
 * app's pane (ptyd owns it) or a launchd job of its own (docs/launchd.md §3) —
 * so it outlives every main-server restart, and under launchd every ptyd
 * restart too. See TunnelApp.ts for why that is the decisive property and for
 * the trade it makes. Its job is narrow and it is the only place in muxpad that
 * knows what cloudflared's output looks like:
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
 * WHAT CHANGES WHEN LAUNCHD OWNS IT, and it is only ever additive — the same
 * binary runs in both places:
 *
 *   · `pid` goes out with every announce. With no pane there is no pane id, and
 *     the server needs SOME token it can check the liveness of, or a dead name
 *     could outlive its process (TunnelApp.ts, rule 3).
 *   · The tunnel is CLAIMED before cloudflared starts and re-claimed on the
 *     heartbeat, so the ~4s cold start and every backoff window are still owned.
 *   · Step 1 is re-run on every heartbeat, not just at startup. An unsupervised
 *     tunnel can outlive the server it points at, and "nothing is listening on
 *     :7778" can quietly become "something ELSE is listening on :7778".
 *   · Nothing listening is WAITED OUT rather than refused. Under launchd the
 *     tunnel and the main server start together and the tunnel usually wins;
 *     exiting would work (launchd retries) but every exit means a fresh
 *     cloudflared and therefore a fresh hostname, which is the bug.
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
  /**
   * This process's pid — the ownership token for a runner with NO pane, and a
   * liveness check on top of the pane id for one that has one. Omitted =
   * pane-only ownership, exactly as before.
   */
  pid?: number | null;
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

export type TunnelRunOutcome =
  | 'no-binary'
  | 'refused'
  | 'stopped'
  | 'max-runs'
  /**
   * The server said the tunnel is not wanted — MUXPAD_PUBLIC_BASE_URL is set, so
   * there is a real domain and nothing for a quick tunnel to do. A CLEAN exit,
   * distinct from every other outcome, because it is the one that must not be
   * retried: under `KeepAlive: {SuccessfulExit: false}` exiting 0 is how a
   * launchd-supervised tunnel stays down.
   */
  | 'not-wanted';

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
 *
 * `listening` separates the two failures, and the runner treats them as
 * opposites. NOTHING THERE is muxpad being restarted — wait, and keep the
 * hostname, which is the entire point of an unsupervised tunnel. ANSWERED WRONG
 * is somebody else's server on muxpad's port, and waiting for it to become
 * muxpad is waiting for something that will not happen; close the door.
 */
export async function verifyPublicTarget(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true } | { ok: false; listening: boolean; reason: string }> {
  let res: Response;
  try {
    res = await fetchImpl(`${url}/`, { method: 'GET', redirect: 'manual' });
  } catch (err) {
    return {
      ok: false,
      listening: false,
      reason: `nothing is listening on ${url} (${(err as Error).message})`,
    };
  }
  const csp = res.headers.get('content-security-policy') ?? '';
  if (res.status !== 404 || !csp.startsWith('sandbox')) {
    return {
      ok: false,
      listening: true,
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
  /** Set when we shut down because the PORT went wrong, not because we were asked. */
  let hijacked = false;
  /** Set when the server says a real domain has made this tunnel pointless. */
  let unwanted = false;
  const pid = deps.pid ?? null;

  /**
   * The server's verdict on an announce. `wanted: false` means
   * MUXPAD_PUBLIC_BASE_URL is set, and it is the ONLY channel through which that
   * can reach a runner muxpad does not supervise: `ensureTunnelApp` cancels an
   * in-pane tunnel by stopping its app, and it cannot stop a launchd job.
   *
   * An older server answers without the field, which must not be read as "not
   * wanted" — hence the explicit `=== false`.
   */
  const readVerdict = async (res: Response): Promise<void> => {
    try {
      const body = (await res.json()) as { wanted?: unknown };
      if (body?.wanted === false) unwanted = true;
    } catch {
      // Not JSON, or an empty body. Says nothing either way, so assume wanted.
    }
  };

  const announceUp = async (url: string): Promise<void> => {
    try {
      const res = await doFetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          url,
          pane_id: deps.paneId ?? null,
          ...(pid != null ? { pid } : {}),
        }),
      });
      if (!res.ok) log(`muxpad tunnel: server refused the url (${res.status})`);
      else await readVerdict(res);
    } catch (err) {
      log(
        `muxpad tunnel: could not reach the server to announce ${url} (${(err as Error).message})`,
      );
    }
  };

  /**
   * Claim the tunnel by pid, with no url — before cloudflared has been handed a
   * hostname, and again on the heartbeat while it has not. Only meaningful for a
   * paneless runner, so it is skipped entirely when there is no pid: a pane
   * runner's ownership token is its pane, which exists before it does.
   */
  const announceClaim = async (): Promise<void> => {
    if (pid == null) return;
    try {
      const res = await doFetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pid }),
      });
      if (res.ok) await readVerdict(res);
    } catch {
      // The server being down is the normal case at boot — this is a claim
      // against a race, not a step anything depends on.
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
          // The pid tells the server this is "cloudflared died" and not "the
          // tunnel is over", so it drops the url and keeps the claim.
          ...(pid != null ? { pid } : {}),
        }),
      });
    } catch {
      // The server being unreachable while we retract is survivable: the url's
      // owner is recorded with it, so a value we failed to clear is still
      // invalidated the moment that owner goes away — and the reachability
      // probe demotes it meanwhile.
    }
  };

  /**
   * Re-state the live url on a slow interval, and RE-CHECK THE TARGET.
   *
   * The re-check is the new half, and it exists because this process can outlive
   * the server it points at. Verifying the fingerprint once at startup was
   * enough while the main server owned the tunnel's lifetime; a launchd tunnel
   * keeps running through every muxpad restart, so the port it is publishing can
   * change hands with nothing around to notice. Nothing listening is fine and
   * expected — that is muxpad restarting, and holding the hostname through it is
   * the point. Something ELSE answering is not, and the answer is to close the
   * door rather than to keep proxying it.
   *
   * Runs for the process's whole life. `announceIntervalMs: 0` turns it off,
   * which is what tests that inject an instantaneous `sleep` want — a heartbeat
   * whose wait is zero is a busy loop, not a heartbeat.
   */
  const heartbeat = async (): Promise<void> => {
    while (!stopped) {
      await sleep(announceEvery);
      if (stopped) continue;
      const target = await verifyPublicTarget(localUrl, doFetch);
      if (!target.ok && target.listening) {
        log(`muxpad tunnel: ${target.reason}`);
        hijacked = true;
        current = null;
        await announceDown(target.reason, 1);
        stopChild();
        return;
      }
      if (current) await announceUp(current);
      else await announceClaim();
      if (unwanted) {
        log('muxpad tunnel: the server has a permanent public base — shutting the tunnel down');
        stopChild();
        return;
      }
    }
  };

  /** Stop the loop and kill cloudflared. The body of `stop()`, reusable inside. */
  const stopChild = (): void => {
    stopped = true;
    child?.kill();
  };

  const run = async (): Promise<TunnelRunOutcome> => {
    if (!deps.bin) {
      const reason =
        'cloudflared is not installed — install it (brew install cloudflared) or set MUXPAD_CLOUDFLARED_BIN';
      log(`muxpad tunnel: ${reason}`);
      await announceDown(reason, 1);
      return 'no-binary';
    }

    // Own the tunnel before doing anything that takes time. Waiting for the
    // target can take as long as the main server takes to boot, and cloudflared
    // adds another four seconds; a publish in that window must not conclude the
    // tunnel is unowned and start a second one in a pane.
    await announceClaim();
    if (unwanted) {
      log('muxpad tunnel: the server has a permanent public base — nothing to do');
      return 'not-wanted';
    }

    // WAIT for the public server; refuse only what answers wrongly. Under
    // launchd this process and the main server start at the same moment, and an
    // exit here would cost a hostname on every boot.
    for (let waits = 0; ; waits++) {
      if (stopped) return 'stopped';
      const target = await verifyPublicTarget(localUrl, doFetch);
      if (target.ok) break;
      if (target.listening) {
        log(`muxpad tunnel: ${target.reason}`);
        await announceDown(target.reason, 1);
        return 'refused';
      }
      log(`muxpad tunnel: ${target.reason} — waiting for it`);
      await sleep(tunnelBackoffMs(waits + 1));
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
        void announceUp(url).then(() => {
          // The first announce is also the first chance to be told the tunnel is
          // pointless — a permanent base was configured while this process was
          // starting, or between two of its cloudflared runs.
          if (!unwanted || stopped) return;
          log('muxpad tunnel: the server has a permanent public base — shutting the tunnel down');
          stopChild();
        });
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
    // WHY the stop happened, not just that it did. The exit code keys off this
    // (tunnel/index.ts), and under launchd the exit code decides whether the job
    // comes back: `not-wanted` must stay down, `refused` must be retried in case
    // muxpad is simply mid-restart and about to reclaim its port.
    if (unwanted) return 'not-wanted';
    if (hijacked) return 'refused';
    return 'stopped';
  };

  return { run, stop: stopChild };
}
