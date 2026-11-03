import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MiddlewareHandler } from 'hono';

/**
 * WHO IS CALLING THIS API.
 *
 * ── THE HOLE THIS CLOSES ───────────────────────────────────────────────────
 * muxpad has had no answer to that question, deliberately and in writing:
 * "reachability IS authorization, and the boundary is the tailnet"
 * (same-origin.ts), with anyone who can reach port 7777 declared "outside the
 * threat model by construction" (ws.ts). On one machine, owned by one person,
 * on a personal tailnet, that is a defensible position and it held for a long
 * time.
 *
 * It stops being defensible the moment a SECOND MACHINE exists. The multi-node
 * plan has the mac opening a link to a Trayo VM, and a VM lives on a tailnet
 * with other people's machines and an admin who is not the user. "Reachable"
 * and "allowed" have to stop being the same word before that link is built —
 * an adversarial review of the plan put it exactly this way: §6 protects where
 * the secret bytes sit, but not who can use them.
 *
 * What an unauthenticated caller gets today is not a subset of the UI; it is
 * the machine. `POST /api/tabs/:id/panes` takes a `startup_cmd` — a shell.
 * `POST /api/apps` plants a command that autostarts on every boot and
 * `/api/crons` schedules work that survives reboots. `POST /api/publish` will
 * put any path the server can read on the public internet. And
 * `/ws/agent-runner/:paneId` lets the NEWEST socket win, so a second caller
 * can displace the runner behind a live chat, read what the user types into it
 * and answer in its place.
 *
 * ── WHAT THIS IS, AND WHAT IT IS NOT ───────────────────────────────────────
 * A shared install secret in the data dir, presented as a bearer credential.
 * The same shape as {@link ../pane-key.ts}, which is honest about the limit and
 * so is this: against anything running as the SAME UID on this machine it is
 * not a defence, because that process can read the secret file. It is a
 * defence against the three callers that actually matter:
 *
 *   · another machine on a tailnet (the thing the multi-node plan adds),
 *   · a web page in the user's browser (same-origin.ts guards writes today,
 *     and nothing guards reads),
 *   · a process that has the URL but not the filesystem — which is precisely
 *     what a remote node, a container, or a tunnel endpoint is.
 *
 * The real answer for same-uid separation is a broker under a second OS user,
 * which pane-key.ts already says and which this does not change.
 *
 * ── THE ROLLOUT IS THE DESIGN ──────────────────────────────────────────────
 * This runs on a live machine with ~120 panes, ~46 browser hosts, crons and a
 * published tunnel. Turning verification on in one step would 401 every one of
 * them, and the fix for an agent pane is a respawn — which kills its
 * background subagents and is never done to the user's panes on a whim.
 *
 * So there are three modes and the default changes NOTHING:
 *
 *   off      (default) — the middleware is not even installed.
 *   observe  — verify, allow regardless, and LOG every caller that would have
 *              been refused, with method, path and user-agent. This is the
 *              mode that answers "what breaks if I turn this on" without
 *              breaking anything, and it is where the flip actually gets
 *              decided.
 *   enforce  — 401 anything unauthenticated.
 *
 * `observe` is not a courtesy. The list of callers above was assembled by
 * reading code, and code-reading is how both halves of the last delivery bug
 * got written wrong. The log is the only thing that can prove the list.
 */

const FILE = 'api-secret';

/** Which of the three modes is in force. See the file note. */
export type AuthMode = 'off' | 'observe' | 'enforce';

let secret: string | null = null;

/**
 * Load the install secret, creating it on first boot.
 *
 * 0600 and re-chmodded on every read, like pane-key.ts: a secret written under
 * a loose umask is a secret that was never one, and the cost of being sure is
 * one syscall per boot.
 */
export function initApiAuth(dataDir: string): void {
  const path = join(dataDir, FILE);
  try {
    const existing = readFileSync(path, 'utf8').trim();
    if (existing.length >= 32) {
      secret = existing;
      try {
        chmodSync(path, 0o600);
      } catch {
        // Best effort. A secret we cannot chmod is still a secret we can use,
        // and failing to boot over file modes would be worse than the risk.
      }
      return;
    }
    // A short or empty file is a failed earlier write, not a credential.
  } catch {
    // Absent — first boot on this install.
  }
  const fresh = randomBytes(32).toString('hex');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(path, `${fresh}\n`, { mode: 0o600 });
  secret = fresh;
}

/** Test seam: forget the loaded secret. */
export function resetApiAuthForTest(): void {
  secret = null;
}

/** The install secret, for the one in-process caller that must present it. */
export function apiCredential(): string | null {
  return secret;
}

/**
 * Read the mode from the environment.
 *
 * ANYTHING UNRECOGNISED IS `off`, and that direction is deliberate. The other
 * choice — refuse to boot on a typo — turns `MUXPAD_API_AUTH=enfroce` into a
 * machine with no muxpad at all, and the failure this is guarding against is
 * remote, not a boot flag. A typo must not be able to lock the user out of
 * their own cockpit, so an unreadable mode degrades to today's behaviour and
 * says so in the log.
 */
export function authMode(env: NodeJS.ProcessEnv = process.env): AuthMode {
  const raw = (env.MUXPAD_API_AUTH ?? '').trim().toLowerCase();
  if (raw === 'enforce' || raw === 'observe') return raw;
  return 'off';
}

/**
 * Does this presented credential match?
 *
 * Constant-time, and length-checked first because `timingSafeEqual` throws on
 * a length mismatch rather than returning false — which would turn a wrong
 * password into a 500 and, worse, into a thrown stack in the log.
 */
export function verifyCredential(presented: string | null | undefined): boolean {
  if (!secret || !presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(secret);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Pull the credential off a request.
 *
 * Three places, because the three caller classes cannot all use the same one:
 *
 *   Authorization: Bearer   the CLI (one `http_request` funnel in
 *                           scripts/muxpad) and anything else holding the
 *                           secret from disk.
 *   x-muxpad-key            a header for callers that must leave
 *                           `Authorization` alone — a proxy, a node link.
 *   cookie                  the browser. The app is served BY this server, so
 *                           the cookie is set when the page loads and an
 *                           already-open tab picks it up on reload. Without
 *                           this the web UI could not authenticate at all
 *                           without shipping the secret into JS, where every
 *                           page on the tailnet could read it.
 */
export function presentedCredential(headers: {
  get(name: string): string | null;
}): string | null {
  const auth = headers.get('authorization');
  if (auth) {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m?.[1]) return m[1].trim();
  }
  const direct = headers.get('x-muxpad-key');
  if (direct?.trim()) return direct.trim();
  const cookie = headers.get('cookie');
  if (cookie) {
    for (const part of cookie.split(';')) {
      const [k, ...rest] = part.trim().split('=');
      if (k === COOKIE_NAME && rest.length) return rest.join('=').trim();
    }
  }
  return null;
}

export const COOKIE_NAME = 'muxpad_key';

/**
 * Paths that must work WITHOUT a credential, in every mode.
 *
 * The app shell and its assets, because the cookie is handed out by loading
 * the app — gate that and there is no way to ever obtain one, which is a
 * cockpit that cannot be opened. And `/api/health`, because a liveness probe
 * that needs a secret is a liveness probe that reports the secret's absence as
 * a dead server.
 *
 * NOT exempt, deliberately: every other `/api/*`, every `/ws/*`, and every
 * `/browser/*`.
 *
 * Two things were wrong with the first draft of this function and both were
 * caught by its own tests rather than by reading it:
 *
 *   · It exempted GET, "because reads are harmless". A read here is `GET
 *     /api/tabs/:id/transcript` — the conversation — and the multi-node
 *     plan's entire secret boundary dies if a remote node can read.
 *   · It gated `/ws/` by prefix and so missed `/browser/<slug>/ws`, which is
 *     NOT under `/ws/` (see the upgrade arms in ws.ts: `/ws/events`,
 *     `/ws/chat/:id`, `/ws/pane/:id`, `/ws/agent-runner/:id`, and then
 *     `/browser/<slug>/ws` on its own). That socket is live control of a
 *     Chrome session holding the user's logged-in cookie jar — the single
 *     worst thing on the list to have left open.
 */
export function isExempt(path: string): boolean {
  if (path === '/api/health') return true;
  if (
    path.startsWith('/api/') ||
    path === '/ws' ||
    path.startsWith('/ws/') ||
    path.startsWith('/browser/')
  )
    return false;
  // Everything else is the static app: index.html, /assets/*, icons.
  return true;
}

/**
 * The Hono middleware. Installed only when the mode is not `off`.
 *
 * `onRefusal` is injected rather than reaching for a logger, so the observe
 * log can be asserted in a test instead of being eyeballed in a terminal —
 * see the file note on why the caller list has to be PROVEN rather than read.
 */
export function apiAuth(opts: {
  mode: () => AuthMode;
  onRefusal?: (info: { method: string; path: string; agent: string }) => void;
}): MiddlewareHandler {
  return async (c, next) => {
    const mode = opts.mode();
    if (mode === 'off') return next();
    const path = new URL(c.req.url).pathname;
    if (isExempt(path)) return next();
    if (verifyCredential(presentedCredential(c.req.raw.headers))) return next();
    opts.onRefusal?.({
      method: c.req.method,
      path,
      agent: c.req.raw.headers.get('user-agent') ?? '-',
    });
    if (mode === 'observe') return next();
    return c.json({ error: { message: 'unauthorized' } }, 401);
  };
}
