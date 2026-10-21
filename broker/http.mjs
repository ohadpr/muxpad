import { readFileSync } from 'node:fs';
import { DeviceAuth } from './device-auth.mjs';
import { SESSION_COOKIE, validateHumanConfig } from './human-session.mjs';
import { verifiedPeer } from './node-policy.mjs';
import { inlineHandler } from './passkey-http.mjs';
const page = readFileSync(new URL('./page.html', import.meta.url));
const script = readFileSync(new URL('./client.js', import.meta.url));
const shell = readFileSync(new URL('./shell.html', import.meta.url));
const shellScript = readFileSync(new URL('./shell.js', import.meta.url));
const shellStyle = readFileSync(new URL('./shell.css', import.meta.url));
const deviceClient = readFileSync(new URL('./device-client.mjs', import.meta.url));
export function handler(broker, origin, { config = {}, sessions } = {}) {
  validateHumanConfig(config);
  const peerMode = config.authMode === 'tailnet-peer';
  const sessionMode = config.approvalMode === 'session';
  if (sessionMode && !sessions) throw Error('Protected human sessions required');
  const frameOrigin = sessionMode ? new URL(config.muxpadURL).origin : "'none'";
  const devices =
    sessionMode && !peerMode
      ? new DeviceAuth({
          config: { ...config, origin },
          state: broker.state,
          save: broker.save,
          sessions,
          now: sessions.now,
        })
      : null;
  let active = 0;
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader(
      'Content-Security-Policy',
      `default-src 'none'; script-src 'self'; style-src 'self' ${sessionMode ? '' : "'unsafe-inline'"}; connect-src 'self'; frame-src ${frameOrigin}; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'fullscreen=(), payment=()');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    const json = (status, data) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    if (active >= 16) {
      json(429, { error: 'Too many simultaneous requests' });
      return;
    }
    active++;
    try {
      const url = new URL(req.url, origin);
      // No CORS. Forged headers grant nothing: decisions also require either
      // a human-only session + CSRF token or a verified passkey assertion.
      if (req.headers.origin && req.headers.origin !== origin) {
        json(403, { error: 'Wrong origin' });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/health') {
        json(200, {
          version:
            config.approvalMode === 'passkey-inline'
              ? 'inchat-slack-capabilities-v2-2026-10-20'
              : 'tailnet-member-v1-2026-10-19',
        });
        return;
      }
      if (await inlineHandler(broker, req, res, url)) return;
      let peer;
      const humanRoute = url.pathname.startsWith('/human/') || url.pathname.startsWith('/device/');
      if (peerMode && humanRoute) {
        // Production peer mode is exclusively behind the protected Unix socket.
        if (req.socket.remoteAddress !== undefined) throw Error('Private transport required');
        peer = verifiedPeer(req);
        if (!sessions.peerAllowed(peer, { paused: true })) {
          json(
            sessions.storageFault ? 503 : 403,
            sessions.storageFault
              ? {
                  storageFault: true,
                  error:
                    'Approval storage uncertain; authority disabled. Administrator must reconcile persisted state before restart.',
                }
              : { error: 'This tailnet device is not authorized for approvals' },
          );
          return;
        }
        if (
          url.pathname.startsWith('/device/') ||
          ['/human/pair', '/human/device/register'].includes(url.pathname)
        ) {
          json(403, { error: 'Browser pairing is disabled in tailnet-peer mode' });
          return;
        }
      }
      const cookieFor = (issued) =>
        res.setHeader(
          'Set-Cookie',
          `${SESSION_COOKIE}=${issued.token}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=${issued.maxAge}`,
        );
      if (sessionMode) {
        const assets = {
          '/': ['text/html; charset=utf-8', shell],
          '/review': [
            'text/html; charset=utf-8',
            shell.toString().replace('<body>', '<body data-review="true">'),
          ],
          '/shell.js': ['text/javascript; charset=utf-8', shellScript],
          '/shell.css': ['text/css; charset=utf-8', shellStyle],
          '/device-client.mjs': ['text/javascript; charset=utf-8', deviceClient],
        };
        if (req.method === 'GET' && Object.hasOwn(assets, url.pathname)) {
          const [type, original] = assets[url.pathname];
          const data =
            peerMode && type.startsWith('text/html')
              ? original
                  .toString()
                  .replace(/<body([^>]*)>/, '<body$1 data-auth-mode="tailnet-peer">')
              : original;
          res.writeHead(200, { 'content-type': type });
          res.end(data);
          return;
        }
        if (url.pathname.startsWith('/human/') && url.pathname !== '/human/pair') {
          const session = sessions.authenticate(req.headers.cookie, peer);
          if (peerMode && req.method === 'GET' && url.pathname === '/human/session' && !session) {
            const paused =
              !sessions.peerAllowed(peer) || !!sessions.browserPause(req.headers.cookie, peer);
            json(401, {
              error: paused ? 'Approval access is signed out' : 'Browser session required',
              authMode: 'tailnet-peer',
              ...(paused ? { resumeRequired: true } : { bootstrap: true }),
            });
            return;
          }
          if (
            peerMode &&
            ['/human/node/session', '/human/node/challenge', '/human/node/resume'].includes(
              url.pathname,
            )
          ) {
            // Session issuance and resume challenge allocation must never be
            // induced by cross-origin images/navigation or credentialless GET.
            if (
              req.method !== 'POST' ||
              req.headers.origin !== origin ||
              (req.headers['sec-fetch-site'] &&
                !['same-origin', 'none'].includes(req.headers['sec-fetch-site']))
            ) {
              json(403, { error: 'Use protected-origin JSON POST' });
              return;
            }
          } else {
            if (!session) {
              json(401, { error: 'Human device pairing required' });
              return;
            }
            if (req.method === 'GET' && url.pathname === '/human/session') {
              json(200, {
                csrf: session.csrf,
                expires: session.expires,
                deviceEnrolled: !!broker.state.deviceEnrollmentComplete,
                ...(peerMode ? { authMode: 'tailnet-peer', durable: true } : {}),
                config: { muxpadURL: config.muxpadURL, teamID: config.teamID },
              });
              return;
            }
            if (req.method === 'GET' && url.pathname === '/human/pending') {
              json(200, { requests: broker.pending(), grants: broker.listGrants() });
              return;
            }
            if (req.method === 'GET' && url.pathname === '/human/grants') {
              json(200, { grants: broker.listGrants(), serverNow: Date.now() });
              return;
            }
            // Every human write needs the exact protected origin AND the paired
            // cookie AND a per-session token. None is forwarded to muxpad.
            if (
              req.headers.origin !== origin ||
              !sessions.authorize(req.headers.cookie, req.headers['x-muxpad-csrf'], peer)
            ) {
              json(403, { error: 'Human session and CSRF verification required' });
              return;
            }
          }
        }
      }
      if (
        !sessionMode &&
        req.method === 'GET' &&
        (url.pathname === '/enroll' || /^\/approve\/[a-f0-9-]{36}$/.test(url.pathname))
      ) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(page);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/client.js') {
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
        res.end(script);
        return;
      }
      if (req.method === 'GET' && /^\/requests\/[a-f0-9-]{36}$/.test(url.pathname)) {
        json(200, broker.view(url.pathname.split('/')[2]));
        return;
      }
      if (
        req.method !== 'POST' ||
        !/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')
      ) {
        json(404, { error: 'Unknown endpoint' });
        return;
      }
      req.setEncoding('utf8');
      let raw = '';
      for await (const chunk of req) {
        raw += chunk;
        if (Buffer.byteLength(raw) > (url.pathname === '/requests' ? 14 * 1024 * 1024 : 65536))
          throw new Error('Request too large');
      }
      const body = JSON.parse(raw);
      if (peerMode && url.pathname === '/human/node/session') {
        const existing = sessions.authenticate(req.headers.cookie, peer);
        if (!existing) cookieFor(sessions.issue(peer, { cookie: req.headers.cookie }));
        json(200, { issued: true });
        return;
      }
      if (peerMode && url.pathname === '/human/node/challenge') {
        json(200, { challenge: sessions.resumeChallenge(peer, req.headers.cookie) });
        return;
      }
      if (peerMode && url.pathname === '/human/node/resume') {
        cookieFor(sessions.resume(peer, body.challenge, req.headers.cookie));
        json(200, { resumed: true });
        return;
      }
      if (peerMode && url.pathname === '/human/node/revoke') {
        if (!sessions.authorize(req.headers.cookie, req.headers['x-muxpad-csrf'], peer))
          throw Error('Live session required');
        sessions.endNode(peer, true);
        broker.grantEpoch++;
        broker.activeGrants();
        json(200, { revoked: true });
        return;
      }
      if (sessionMode && ['/device/challenge', '/device/session'].includes(url.pathname)) {
        if (req.headers.origin !== origin) {
          json(403, { error: 'Wrong origin' });
          return;
        }
        if (url.pathname === '/device/challenge') json(200, devices.challenge(body.deviceID));
        else {
          const renewed = devices.renew(body.deviceID, body.challengeID, body.signature);
          res.setHeader(
            'Set-Cookie',
            `${SESSION_COOKIE}=${renewed.token}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=${renewed.maxAge}`,
          );
          json(200, { renewed: true });
        }
        return;
      }
      if (sessionMode && url.pathname === '/human/device/register') {
        json(
          200,
          devices.register(req.headers.cookie, req.headers['x-muxpad-csrf'], body.publicKey),
        );
        return;
      }
      if (sessionMode && url.pathname === '/human/pair') {
        if (req.headers.origin !== origin) {
          json(403, { error: 'Pair directly at the protected origin' });
          return;
        }
        const paired = sessions.pair(body.secret);
        res.setHeader(
          'Set-Cookie',
          `${SESSION_COOKIE}=${paired.token}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=${paired.maxAge}`,
        );
        json(200, { paired: true });
        return;
      }
      if (sessionMode && url.pathname === '/human/decision') {
        // Recheck after consuming the body; a session may have expired/revoked
        // while the client was sending it. No parsing result confers authority.
        const human = sessions.authorize(req.headers.cookie, req.headers['x-muxpad-csrf'], peer);
        if (!human) {
          json(403, { error: 'Human session expired' });
          return;
        }
        json(
          200,
          await broker.decideSession(body.id, body.fingerprint, body.decision, {
            duration: body.duration ?? 'once',
            scope: body.scope,
            session: human,
          }),
        );
        return;
      }
      if (sessionMode && url.pathname === '/human/grants/revoke') {
        if (!sessions.authorize(req.headers.cookie, req.headers['x-muxpad-csrf'], peer)) {
          json(403, { error: 'Human session expired' });
          return;
        }
        json(200, broker.revokeGrants(body.id));
        return;
      }
      if (sessionMode && url.pathname === '/human/logout') {
        if (peerMode) {
          if (!sessions.authorize(req.headers.cookie, req.headers['x-muxpad-csrf'], peer))
            throw Error('Live session required');
          cookieFor(sessions.endBrowser(req.headers.cookie, req.headers['x-muxpad-csrf'], peer));
          broker.activeGrants();
        } else {
          devices.revoke(req.headers.cookie, req.headers['x-muxpad-csrf']);
          res.setHeader(
            'Set-Cookie',
            `${SESSION_COOKIE}=; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
          );
        }
        json(200, { revoked: true });
        return;
      }
      if (url.pathname === '/requests') {
        json(202, await broker.create(body));
        return;
      }
      if (url.pathname === '/registration/options') {
        json(200, await broker.registerOptions(body.secret));
        return;
      }
      if (url.pathname === '/registration/verify') {
        json(200, await broker.register(body.secret, body.response));
        return;
      }
      const match = url.pathname.match(/^\/requests\/([a-f0-9-]{36})\/(options|decision)$/);
      if (match) {
        json(
          200,
          match[2] === 'options'
            ? await broker.options(match[1], body.decision)
            : await broker.decide(match[1], body.response),
        );
        return;
      }
      json(404, { error: 'Unknown endpoint' });
    } catch {
      if (!res.headersSent) {
        if (peerMode && sessions.storageFault)
          json(503, {
            storageFault: true,
            error:
              'Approval storage uncertain; authority disabled. Administrator must reconcile persisted state before restart.',
          });
        else json(400, { error: 'Request refused or invalid' });
      }
    } finally {
      active--;
    }
  };
}
