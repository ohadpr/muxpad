import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = '__Host-muxpad-human';
const hash = (value) => createHash('sha256').update(value).digest('base64url');
const equal = (a, b) =>
  typeof a === 'string' &&
  typeof b === 'string' &&
  Buffer.byteLength(a) === Buffer.byteLength(b) &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));

// Sessions belong only to the protected top-level shell. Neither the muxpad
// backend, its iframe, nor agent browser profiles receive these credentials.
export class HumanSessions {
  constructor({ config, state, save, now = Date.now }) {
    this.config = config;
    this.state = state;
    this.save = save;
    this.now = now;
    this.attempts = [];
  }
  pair(secret) {
    if (this.config.approvalMode !== 'session' || this.state.humanPaired)
      throw Error('Pairing unavailable');
    this.attempts = this.attempts.filter((at) => at > this.now() - 900_000);
    if (this.attempts.length >= 5) throw Error('Pairing temporarily limited');
    this.attempts.push(this.now());
    if (typeof secret !== 'string' || !equal(hash(secret), this.config.bootstrapHash))
      throw Error('Pairing unavailable');
    const token = randomBytes(32).toString('base64url');
    const csrf = randomBytes(32).toString('base64url');
    const lifetime = Math.min(
      30 * 86400_000,
      Math.max(3600_000, this.config.sessionLifetimeMs || 30 * 86400_000),
    );
    const session = { tokenHash: hash(token), csrf, expires: this.now() + lifetime };
    const next = { ...this.state, humanPaired: true, humanSessions: [session] };
    this.save(next);
    Object.assign(this.state, next);
    return { token, maxAge: Math.floor(lifetime / 1000) };
  }
  issueDeviceSession(deviceID, valid = () => true) {
    if (
      !this.state.deviceEnrollmentComplete ||
      !this.state.humanDevices?.some((d) => d.id === deviceID)
    )
      throw Error('Authorized device required');
    const token = randomBytes(32).toString('base64url');
    const csrf = randomBytes(32).toString('base64url');
    const lifetime = Math.min(
      30 * 86400_000,
      Math.max(3600_000, this.config.sessionLifetimeMs || 30 * 86400_000),
    );
    const session = { tokenHash: hash(token), csrf, expires: this.now() + lifetime, deviceID };
    const next = {
      ...this.state,
      humanSessions: [
        ...(this.state.humanSessions || []).filter(
          (s) => s.deviceID !== deviceID && s.expires > this.now(),
        ),
        session,
      ],
    };
    if (!valid()) throw Error('Device proof expired');
    this.save(next);
    if (!valid()) throw Error('Device proof expired during persistence');
    Object.assign(this.state, next);
    return { token, maxAge: Math.floor(lifetime / 1000) };
  }
  authenticate(cookie) {
    if (typeof cookie !== 'string' || cookie.length > 4096) return null;
    const matches = cookie
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s.startsWith(`${SESSION_COOKIE}=`));
    if (matches.length !== 1) return null;
    const token = matches[0].slice(SESSION_COOKIE.length + 1);
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const session = this.state.humanSessions?.find(
      (s) =>
        s.expires > this.now() &&
        equal(s.tokenHash, hash(token)) &&
        (this.config.authMode === 'tailnet-peer' ? !!s.peer : !s.peer),
    );
    return session || null;
  }
  authorize(cookie, csrf) {
    const session = this.authenticate(cookie);
    return session && equal(session.csrf, csrf) ? session : null;
  }
  logout(cookie, csrf) {
    const session = this.authorize(cookie, csrf);
    if (!session) throw Error('Human session required');
    const next = {
      ...this.state,
      humanSessions: this.state.humanSessions.filter((s) => s !== session),
    };
    this.save(next);
    Object.assign(this.state, next);
  }
}

export function validateHumanConfig(config) {
  if (![undefined, 'passkey', 'session', 'passkey-inline'].includes(config.approvalMode))
    throw Error('Unknown approval mode');
  if (![undefined, 'paired', 'tailnet-peer'].includes(config.authMode))
    throw Error('Unknown human authentication mode');
  if (
    config.authMode === 'tailnet-peer' &&
    (config.approvalMode !== 'session' || config.transport !== 'tsnet')
  )
    throw Error('Tailnet peer approvals require the private tsnet transport');
  if (config.approvalMode === 'passkey-inline') {
    const app = new URL(config.passkeyOrigin);
    if (
      config.authMode === 'tailnet-peer' ||
      config.transport !== 'tsnet' ||
      app.protocol !== 'https:' ||
      app.origin !== config.passkeyOrigin ||
      app.hostname !== config.passkeyRPID ||
      app.username ||
      app.password ||
      !/^[A-Za-z0-9.-]+$/.test(app.hostname) ||
      /^\d+(?:\.\d+){3}$/.test(app.hostname) ||
      !/^[a-f0-9-]{36}$/.test(config.passkeyGeneration || '') ||
      config.autoRead === true
    )
      throw Error('Invalid in-chat passkey configuration');
    return;
  }
  if (config.approvalMode !== 'session') return;
  const broker = new URL(config.origin);
  const muxpad = new URL(config.muxpadURL);
  // Cookies do not isolate ports. Different hostnames are mandatory, not just
  // different origins. A mutable muxpad response must never receive the cookie.
  if (
    muxpad.protocol !== 'https:' ||
    muxpad.username ||
    muxpad.password ||
    muxpad.hostname === broker.hostname ||
    muxpad.hash
  )
    throw Error('Session approvals need a separate HTTPS hostname for the protected shell');
}
