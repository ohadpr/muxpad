import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { sessionBrowserProfile } from '../SessionBrowser.js';

/**
 * The MCP server an agent actually gets: playwright-mcp pointed at a browser
 * muxpad owns FOR THIS SESSION.
 *
 * WHY A WRAPPER. `~/.claude.json` is one static config for every session on the
 * machine, so it cannot name a per-session endpoint. But it CAN name a command,
 * and a command can look at its own environment. An agent pane has
 * MUXPAD_TAB_ID; this resolves that to a browser, asks muxpad to start one if
 * there is not one yet, and then becomes playwright-mcp pointed at it.
 *
 * WHAT IT FIXES. Agents were running their own isolated browsers while the
 * viewer showed muxpad's, so an agent stuck at a login wall asked a person to
 * sign in somewhere it could not see. Now the browser it is stuck in is the
 * browser you are shown.
 *
 * IT FALLS BACK RATHER THAN FAILING. Outside a muxpad pane, or when the server
 * cannot be reached, it execs an ordinary isolated playwright-mcp seeded from
 * the shared jar — which is exactly what agents had before this existed. A
 * browser subsystem that can take away browsing entirely when it is unwell is
 * worse than the problem it solves.
 */

/**
 * ── THE PLAYWRIGHT-MCP VERSION IS PINNED ──────────────────────────────────
 *
 * This used to spawn `@playwright/mcp@latest`, which means every pane spawn
 * executed whatever had most recently been published to npm — no review
 * window, no pinning, and a compromised or merely broken release reaching
 * every agent on the machine the moment it went up. An agent's MCP server
 * drives a browser holding the user's logged-in cookie jar, so that is about
 * the worst place on this machine to accept an unreviewed update.
 *
 * The version now comes from `<dataDir>/playwright-mcp.version`, which a
 * schedule rewrites to the newest release that has been public for at least
 * three days. The delay is the point: it is a window in which a bad publish
 * can be noticed and yanked.
 *
 * FALLS BACK TO A COMPILED-IN CONSTANT. A missing or malformed file must not
 * mean "no browser tools" — this module's own note says a browser subsystem
 * that can take browsing away entirely is worse than the problem it solves —
 * and it must certainly not mean a silent return to `@latest`.
 *
 * WHAT THIS DOES NOT FIX, stated plainly: the file is writable by anything
 * running as this user, so it is not a defence against local code. Neither is
 * anything else here (see pane-key.ts and api-auth.ts, which say the same of
 * themselves). What it buys is that a REMOTE npm publish is no longer
 * self-executing, which is the actual exposure.
 */
export const PLAYWRIGHT_MCP_FALLBACK_VERSION = '0.0.84';

/** A plain three-part version and nothing else: no ranges, no tags, no
 *  `latest`, and nothing that could carry a shell metacharacter into argv. */
const VERSION_RE = /^\d+\.\d+\.\d+$/;

/**
 * Which `@playwright/mcp` to run.
 *
 * `deps` is injected so the test does not need a home directory — a pin
 * nobody can assert is a pin that quietly rots back to whatever is newest.
 */
export function playwrightMcpVersion(
  deps: { dataDir?: string; read?: (path: string) => string } = {},
): string {
  const dataDir = deps.dataDir ?? process.env.MUXPAD_DATA_DIR ?? join(homedir(), '.muxpad');
  const read = deps.read ?? ((path: string) => readFileSync(path, 'utf8'));
  try {
    const raw = read(join(dataDir, 'playwright-mcp.version')).trim();
    if (VERSION_RE.test(raw)) return raw;
    console.error(
      `[muxpad-browser-mcp] ignoring playwright-mcp.version ${JSON.stringify(
        raw.slice(0, 40),
      )} — not a plain x.y.z; using ${PLAYWRIGHT_MCP_FALLBACK_VERSION}`,
    );
  } catch {
    // Absent is an ordinary state (a fresh install, or the schedule has never
    // run), so it is not worth a line of noise on every pane spawn.
  }
  return PLAYWRIGHT_MCP_FALLBACK_VERSION;
}

/** The package spec to hand npx — exported so the test reads the real string. */
export function playwrightMcpSpec(
  deps: { dataDir?: string; read?: (path: string) => string } = {},
): string {
  return `@playwright/mcp@${playwrightMcpVersion(deps)}`;
}

export interface SessionMcpPlan {
  /** Arguments to hand playwright-mcp. */
  args: string[];
  /** Why, for the log — this runs unattended and its choice is otherwise invisible. */
  why: string;
}

/** What to run, given a resolved browser (or none). */
export function sessionMcpPlan(opts: {
  cdpUrl: string | null;
  jarPath: string;
}): SessionMcpPlan {
  if (opts.cdpUrl) {
    return {
      args: [`--cdp-endpoint=${opts.cdpUrl}`],
      why: `this session's muxpad browser, started on first use — ${opts.cdpUrl}`,
    };
  }
  return {
    args: ['--headless', '--browser=chromium', '--isolated', `--storage-state=${opts.jarPath}`],
    why: 'no muxpad browser for this session — isolated, seeded from the shared jar',
  };
}

/**
 * Reserves this session's browser WITHOUT starting one.
 *
 * Registration is a row in a table; starting is 200 MB of Chrome. This used to
 * do both, at MCP startup — so every agent session launched a browser before
 * the person had typed a word, and most sessions never browse. Ninety-seven of
 * them accumulated on this machine.
 *
 * The url returned is muxpad's LAZY endpoint, not Chrome's. Nothing is running
 * behind it yet; the first tool call that reaches for a browser is what starts
 * one. Safe because playwright-mcp does not touch the endpoint until then —
 * measured, not assumed: 25 tools advertised, `initialize` and `tools/list`
 * answered, endpoint untouched.
 */
export async function resolveSessionBrowser(
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const profile = sessionBrowserProfile(env);
  const api = env.MUXPAD_API_URL;
  if (!profile || !api) return null;
  const base = api.replace(/\/+$/, '');
  try {
    const res = await fetchImpl(`${base}/api/browsers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        profile,
        ...(env.MUXPAD_TAB_ID ? { tabId: env.MUXPAD_TAB_ID } : {}),
        // The whole point: a row, not a browser.
        start: false,
      }),
    });
    if (!res.ok) return null;
    // The reply names Chrome's own port, which is not listening. Hand back the
    // endpoint that starts it instead.
    return `${base}/api/browsers/${encodeURIComponent(profile)}/cdp`;
  } catch {
    // Server down, or no browser to be had. The caller falls back.
    return null;
  }
}

export async function main(argv: string[] = process.argv.slice(2)) {
  const jarPath =
    argv.find((a) => a.startsWith('--jar='))?.slice('--jar='.length) ??
    `${process.env.HOME}/.muxpad/browser-profiles/default.cookies.json`;

  // NOT waited on, deliberately. There is nothing listening yet and there is
  // not meant to be: the endpoint starts a browser when something first asks it
  // for one, and waiting here would put back the eager launch this removes.
  const cdpUrl = await resolveSessionBrowser(process.env);

  const plan = sessionMcpPlan({ cdpUrl, jarPath });
  console.error(`[muxpad-browser-mcp] ${plan.why}`);

  const spec = playwrightMcpSpec();
  console.error(`[muxpad-browser-mcp] ${spec}`);
  const child = spawn(
    'npx',
    ['-y', spec, ...plan.args, ...argv.filter((a) => !a.startsWith('--jar='))],
    {
      stdio: 'inherit',
    },
  );
  child.on('exit', (code) => process.exit(code ?? 0));
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => child.kill(sig));
}
