import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { checkOrigin, parseAllowedOrigins, sameOriginGuard } from './same-origin.js';

const HOST = 'muxpad-mini.tail1234.ts.net:7777';

function makeApp(allowed?: string): { app: Hono; logs: string[] } {
  const logs: string[] = [];
  const app = new Hono();
  app.use(
    '*',
    sameOriginGuard({
      allowedOrigins: parseAllowedOrigins(allowed),
      log: (l) => logs.push(l),
    }),
  );
  app.get('/api/apps', (c) => c.json({ ok: 'read' }));
  app.post('/api/apps', (c) => c.json({ ok: 'wrote' }));
  app.delete('/api/apps/x', (c) => c.json({ ok: 'deleted' }));
  app.put('/api/apps/x', (c) => c.json({ ok: 'put' }));
  app.patch('/api/apps/x', (c) => c.json({ ok: 'patched' }));
  return { app, logs };
}

/** A request the way a browser would send it: Host + whatever Origin. */
async function req(
  app: Hono,
  method: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return await app.request(`http://${HOST}${path}`, {
    method,
    headers: { host: HOST, ...headers },
  });
}

describe('sameOriginGuard', () => {
  it('ALLOWS a request with no Origin at all — that is the CLI', async () => {
    // `muxpad` drives the API with curl, which sends no Origin. So do the
    // agent runner, the cron scheduler and every server-side caller. This
    // case is not a browser and cannot be a CSRF attack: browsers attach
    // Origin to every cross-origin request, including no-cors form POSTs.
    const { app, logs } = makeApp();
    for (const m of ['POST', 'DELETE', 'PUT', 'PATCH']) {
      const res = await req(app, m, m === 'POST' ? '/api/apps' : '/api/apps/x');
      expect(res.status).toBe(200);
    }
    expect(logs).toEqual([]);
  });

  it('ALLOWS the app served from the same host (the installed PWA)', async () => {
    const { app } = makeApp();
    const res = await req(app, 'POST', '/api/apps', {
      origin: `http://${HOST}`,
      'sec-fetch-site': 'same-origin',
    });
    expect(res.status).toBe(200);
  });

  it('ALLOWS a scheme/port change on the same host (TLS terminator, tailscale serve)', async () => {
    // `https://host` in front of a plain-http listener is a supported way to
    // reach muxpad. Comparing full origins would 403 the user's own app.
    const { app } = makeApp();
    const res = await req(app, 'POST', '/api/apps', {
      origin: 'https://muxpad-mini.tail1234.ts.net',
    });
    expect(res.status).toBe(200);
  });

  it('ALLOWS loopback and the vite dev proxy', async () => {
    const { app } = makeApp();
    for (const origin of ['http://localhost:5173', 'http://127.0.0.1:7777', 'http://[::1]:7777']) {
      const res = await req(app, 'POST', '/api/apps', { origin });
      expect(res.status).toBe(200);
    }
  });

  it('REFUSES the drive-by: a foreign page POSTing an autostarting app', async () => {
    // The whole reason this file exists. text/plain keeps it a CORS simple
    // request, so there is no preflight — the guard is the only thing here.
    const { app, logs } = makeApp();
    const res = await req(app, 'POST', '/api/apps', {
      origin: 'https://evil.example.com',
      'content-type': 'text/plain',
      'sec-fetch-site': 'cross-site',
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'cross_origin_refused',
    );
    expect(logs).toHaveLength(1);
    // A lockout must be self-diagnosing, not a silent 403.
    expect(logs[0]).toContain('MUXPAD_ALLOWED_ORIGINS');
  });

  it('REFUSES a foreign Origin even without the Sec-Fetch-Site hint', async () => {
    const { app } = makeApp();
    const res = await req(app, 'POST', '/api/apps', { origin: 'https://evil.example.com' });
    expect(res.status).toBe(403);
  });

  it('REFUSES cross-site by Sec-Fetch-Site when Origin is absent — a backstop', async () => {
    // Honest scope: fetch-metadata headers are only attached on
    // potentially-trustworthy URLs, and muxpad's real origin is plain http on
    // a tailnet address, where Chrome sends Origin and NO Sec-Fetch-Site. So
    // this covers a loopback or TLS-terminated deployment, and the Origin
    // comparison is what actually holds on the live one. Kept because it is
    // one string compare and page script cannot forge the header.
    const { app } = makeApp();
    const res = await req(app, 'POST', '/api/apps', { 'sec-fetch-site': 'cross-site' });
    expect(res.status).toBe(403);
  });

  it('REFUSES an opaque `null` Origin (sandboxed iframe)', async () => {
    const { app } = makeApp();
    expect((await req(app, 'POST', '/api/apps', { origin: 'null' })).status).toBe(403);
  });

  it('covers the whole state-changing CLASS, not just the preflight-free POST', async () => {
    // DELETE/PUT/PATCH already trigger a preflight, so they are not reachable
    // cross-origin today — but the guard should not depend on that staying
    // true (a future permissive CORS header, a new simple content-type).
    const { app } = makeApp();
    for (const [m, p] of [
      ['DELETE', '/api/apps/x'],
      ['PUT', '/api/apps/x'],
      ['PATCH', '/api/apps/x'],
    ] as const) {
      expect((await req(app, m, p, { origin: 'https://evil.example.com' })).status).toBe(403);
    }
  });

  it('never blocks a READ — GET/HEAD/OPTIONS pass whatever the Origin', async () => {
    // Reads are not the threat (the response is unreadable cross-origin
    // anyway), and blocking OPTIONS would break preflights outright.
    const { app } = makeApp();
    for (const m of ['GET', 'HEAD', 'OPTIONS']) {
      const res = await req(app, m, '/api/apps', {
        origin: 'https://evil.example.com',
        'sec-fetch-site': 'cross-site',
      });
      expect(res.status).not.toBe(403);
    }
  });

  it('MUXPAD_ALLOWED_ORIGINS is the escape hatch for a Host-rewriting proxy', async () => {
    // A reverse proxy that rewrites Host to 127.0.0.1:7777 would otherwise
    // 403 every write from the user's own domain. One env var fixes it.
    const { app } = makeApp('https://muxpad.example.com, cf-tunnel.example.net');
    for (const origin of ['https://muxpad.example.com', 'https://cf-tunnel.example.net'])
      expect((await req(app, 'POST', '/api/apps', { origin })).status).toBe(200);
    expect(
      (await req(app, 'POST', '/api/apps', { origin: 'https://evil.example.com' })).status,
    ).toBe(403);
  });

  it('the allowlist BEATS Sec-Fetch-Site — otherwise the escape hatch cannot escape', async () => {
    // A genuinely cross-SITE front end the user named is exactly the case
    // MUXPAD_ALLOWED_ORIGINS exists for, and the browser will label it
    // `cross-site`. If that refusal ran first, the 403 would tell them to set
    // a variable that cannot fix it.
    const { app, logs } = makeApp('https://muxpad.example.com');
    const res = await req(app, 'POST', '/api/apps', {
      origin: 'https://muxpad.example.com',
      'sec-fetch-site': 'cross-site',
    });
    expect(res.status).toBe(200);
    expect(logs).toEqual([]);
  });

  it('parseAllowedOrigins takes full origins or bare hostnames, and ignores junk', () => {
    expect(parseAllowedOrigins('https://a.example.com:8443, b.example.net ,, not a url')).toEqual(
      new Set(['a.example.com', 'b.example.net']),
    );
    expect(parseAllowedOrigins(undefined).size).toBe(0);
    expect(parseAllowedOrigins('').size).toBe(0);
  });
});

/**
 * The same predicate, called the way the WebSocket upgrade arm calls it: on
 * EVERY handshake, with no method filter, because a WS handshake is a GET that
 * hands out a write channel. These are the unit-level statements about the
 * decision; ws-origin.test.ts proves the wiring over real sockets.
 */
describe('checkOrigin on the WS upgrade path', () => {
  const none = new Set<string>();
  const ok = (h: Parameters<typeof checkOrigin>[0], allowed = none) => checkOrigin(h, allowed).ok;

  it('ALLOWS a same-hostname browser handshake (the app talking to itself)', () => {
    // Every real client: XtermPane → /ws/pane/:id, ChatPane/DocChat →
    // /ws/chat/:paneId, events.ts → /ws/events, all built from location.host.
    expect(ok({ origin: `http://${HOST}`, host: HOST })).toBe(true);
  });

  it('ALLOWS a no-Origin handshake — that is the agent runner, and the tests', () => {
    // agent-runner/index.ts opens `new WebSocket(...)` from the `ws` library
    // with no options, which sends no Origin, and reconnects forever. A
    // browser cannot reach this branch: RFC 6455 §4.1 makes Origin mandatory
    // for browser clients. Refusing it would break the runner and buy nothing.
    expect(ok({ host: HOST })).toBe(true);
    expect(ok({ host: '127.0.0.1:7777' })).toBe(true);
  });

  it('REFUSES a foreign page opening a socket into a live terminal', () => {
    const verdict = checkOrigin({ origin: 'https://evil.example.com', host: HOST }, none);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.why).toContain('evil.example.com');
  });

  it('REFUSES an opaque `null` Origin (a sandboxed published artifact)', () => {
    expect(ok({ origin: 'null', host: HOST })).toBe(false);
  });

  it('ALLOWS loopback and the vite dev proxy, whatever the Host', () => {
    for (const origin of ['http://localhost:5173', 'http://127.0.0.1:7777', 'http://[::1]:7777'])
      expect(ok({ origin, host: HOST })).toBe(true);
  });

  it('ALLOWS a scheme/port change on the same hostname (tailscale serve, TLS terminator)', () => {
    // Hostname-only comparison. A terminator in front keeps the Host and
    // changes scheme+port; comparing full origins would kill every socket in
    // the app — a worse outcome than the hole this closes.
    expect(ok({ origin: 'https://muxpad-mini.tail1234.ts.net', host: HOST })).toBe(true);
  });

  it('MUXPAD_ALLOWED_ORIGINS opens it, identically to the HTTP guard', () => {
    const allowed = parseAllowedOrigins('https://muxpad.example.com');
    expect(ok({ origin: 'https://muxpad.example.com', host: HOST }, allowed)).toBe(true);
    expect(ok({ origin: 'https://evil.example.com', host: HOST }, allowed)).toBe(false);
  });

  it('is the SAME function the HTTP guard uses — one policy, not two', async () => {
    // Belt and braces against the two drifting: for a given (origin, host) the
    // predicate's verdict and the middleware's status must agree.
    const { app } = makeApp();
    for (const origin of [`http://${HOST}`, 'https://evil.example.com', 'null']) {
      const viaHttp = (await req(app, 'POST', '/api/apps', { origin })).status !== 403;
      expect(ok({ origin, host: HOST })).toBe(viaHttp);
    }
  });
});
