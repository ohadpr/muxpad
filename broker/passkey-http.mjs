import { exact, inlineMode, publicKeyFingerprint } from './passkey-approval.mjs';
async function readJSON(req, limit = 65536) {
  if (
    req.method !== 'POST' ||
    !/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')
  )
    throw Error('JSON POST required');
  let timer;
  const parse = async () => {
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (Buffer.byteLength(raw) > limit) throw Error('Body limit');
    }
    return JSON.parse(raw);
  };
  try {
    return await Promise.race([
      parse(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(Error('Deadline'));
          req.destroy?.();
        }, 3000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
const reply = (res, status, value) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
};
/** Returns false ONLY for preexisting machine submit/status paths. No legacy human route survives. */
export async function inlineHandler(broker, req, res, url) {
  if (!inlineMode(broker.config)) return false;
  if (
    (url.pathname === '/requests' && req.method === 'POST') ||
    (/^\/requests\/[a-f0-9-]{36}$/.test(url.pathname) && req.method === 'GET')
  )
    return false;
  try {
    const p = broker.passkeys;
    if (req.method === 'GET' && url.pathname === '/inline/status') {
      reply(res, 200, { ...p.status(), grants: broker.listGrants() });
      return true;
    }
    if (req.method === 'GET' && url.pathname === '/inline/grants') {
      reply(res, 200, { grants: broker.listGrants() });
      return true;
    }
    if (
      ![
        '/inline/registration/options',
        '/inline/registration/verify',
        '/inline/options',
        '/inline/decision',
        '/inline/management/options',
        '/inline/management/verify',
      ].includes(url.pathname)
    ) {
      reply(res, 404, { error: 'Unknown endpoint' });
      return true;
    }
    const body = await readJSON(req);
    const result =
      url.pathname === '/inline/registration/options'
        ? await p.registrationOptions(body)
        : url.pathname === '/inline/registration/verify'
          ? await p.registrationVerify(body)
          : url.pathname === '/inline/options'
            ? await p.options(body)
            : url.pathname === '/inline/management/options'
              ? await p.managementOptions(body)
              : url.pathname === '/inline/management/verify'
                ? await p.managementVerify(body)
                : await p.verify(body);
    reply(res, 200, result);
  } catch {
    reply(res, broker.passkeys.storageFault ? 503 : 400, {
      error: broker.passkeys.storageFault
        ? 'Approval storage uncertain; administrator reconciliation required'
        : 'Passkey request refused',
    });
  }
  return true;
}
/** Served ONLY on the separate protected admin Unix socket, NEVER the public proxy handler. */
export function passkeyAdminHandler(broker) {
  let active = 0;
  return async (req, res) => {
    if (active >= 4) {
      reply(res, 429, { error: 'Administration busy' });
      return;
    }
    active++;
    try {
      const url = new URL(req.url, 'http://admin.local');
      if (!url.search && url.pathname === '/status' && req.method === 'GET') {
        const p = broker.passkeys,
          c = p.credential();
        reply(res, 200, {
          registered: !!c && !p.storageFault,
          storageFault: p.storageFault,
          enrollment: p.enrollmentState(),
          ...(c
            ? {
                credentialID: c.id,
                fingerprint: publicKeyFingerprint(Buffer.from(c.publicKey, 'base64url')),
                rpID: broker.config.passkeyRPID,
                origin: broker.config.passkeyOrigin,
                generation: c.generation,
              }
            : {}),
        });
        return;
      }
      if (
        url.search ||
        !['/confirm-enrollment', '/revoke-credential', '/begin-enrollment'].includes(url.pathname)
      )
        throw Error('Unknown admin action');
      const body = await readJSON(req, 4096);
      const result =
        url.pathname === '/begin-enrollment'
          ? broker.passkeys.beginEnrollment(body)
          : url.pathname === '/confirm-enrollment'
            ? broker.passkeys.confirmEnrollment(body)
            : (exact(body, []), broker.passkeys.revoke());
      reply(res, 200, result);
    } catch {
      reply(res, 400, { error: 'Protected administration refused' });
    } finally {
      active--;
    }
  };
}
