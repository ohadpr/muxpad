import { spawn } from 'node:child_process';
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

  const child = spawn(
    'npx',
    ['-y', '@playwright/mcp@latest', ...plan.args, ...argv.filter((a) => !a.startsWith('--jar='))],
    {
      stdio: 'inherit',
    },
  );
  child.on('exit', (code) => process.exit(code ?? 0));
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => child.kill(sig));
}
