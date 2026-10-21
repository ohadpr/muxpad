import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';

function publicKey(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'crv,kty,x,y' ||
    value.kty !== 'EC' ||
    value.crv !== 'P-256' ||
    !/^[A-Za-z0-9_-]{43}$/.test(value.x || '') ||
    !/^[A-Za-z0-9_-]{43}$/.test(value.y || '')
  )
    throw Error('Invalid public device key');
  const jwk = { kty: 'EC', crv: 'P-256', x: value.x, y: value.y };
  // Enforce canonical base64url and an actual point on P-256.
  for (const coordinate of [jwk.x, jwk.y])
    if (Buffer.from(coordinate, 'base64url').toString('base64url') !== coordinate)
      throw Error('Invalid coordinate');
  createPublicKey({ key: jwk, format: 'jwk' });
  return jwk;
}
const idFor = (jwk) => createHash('sha256').update(JSON.stringify(jwk)).digest('base64url');

export class DeviceAuth {
  constructor({
    config,
    state,
    save,
    sessions,
    now = Date.now,
    elapsed = () => Number(process.hrtime.bigint() / 1_000_000n),
  }) {
    Object.assign(this, { config, state, save, sessions, now, elapsed });
    this.challenges = new Map();
    this.lastWall = now();
    this.lastElapsed = elapsed();
  }
  register(cookie, csrf, input) {
    const session = this.sessions.authorize(cookie, csrf);
    if (!session) throw Error('Human session required');
    const jwk = publicKey(input);
    const id = idFor(jwk);
    const existing = this.state.humanDevices?.find((d) => d.id === id);
    // A successful first migration closes enrollment permanently, even after revoke.
    if (!existing && (this.state.deviceEnrollmentComplete || this.state.humanDevices?.length))
      throw Error('Device enrollment is closed');
    const next = {
      ...this.state,
      deviceEnrollmentComplete: true,
      humanDevices: existing
        ? this.state.humanDevices
        : [{ id, publicKey: jwk, created: this.now() }],
      humanSessions: this.state.humanSessions.map((s) =>
        s === session ? { ...s, deviceID: id } : s,
      ),
    };
    this.save(next);
    Object.assign(this.state, next);
    return { deviceID: id };
  }
  prune() {
    const wall = this.now();
    const elapsed = this.elapsed();
    if (wall < this.lastWall || elapsed < this.lastElapsed) this.challenges.clear();
    this.lastWall = wall;
    this.lastElapsed = elapsed;
    for (const [id, c] of this.challenges)
      if (
        c.expires <= wall ||
        c.elapsedExpires <= elapsed ||
        !this.state.humanDevices?.some((d) => d.id === c.deviceID)
      )
        this.challenges.delete(id);
  }
  challenge(deviceID) {
    this.prune();
    if (
      typeof deviceID !== 'string' ||
      !this.state.humanDevices?.some((d) => d.id === deviceID) ||
      this.challenges.size >= 128 ||
      [...this.challenges.values()].filter((c) => c.deviceID === deviceID).length >= 8
    )
      throw Error('Device renewal unavailable');
    const id = randomBytes(32).toString('base64url');
    const c = {
      id,
      deviceID,
      nonce: randomBytes(32).toString('base64url'),
      expires: this.now() + 60_000,
      elapsedExpires: this.elapsed() + 60_000,
    };
    c.message = JSON.stringify({
      version: 1,
      purpose: 'muxpad-human-session-renewal',
      origin: this.config.origin,
      deviceID,
      challengeID: id,
      nonce: c.nonce,
    });
    this.challenges.set(id, c);
    return { challengeID: id, message: c.message };
  }
  renew(deviceID, challengeID, signature) {
    this.prune();
    const challenge = this.challenges.get(challengeID);
    this.challenges.delete(challengeID); // Consume synchronously, even an invalid proof.
    const device = this.state.humanDevices?.find((d) => d.id === deviceID);
    if (
      !challenge ||
      challenge.deviceID !== deviceID ||
      !device ||
      typeof signature !== 'string' ||
      !/^[A-Za-z0-9_-]{86}$/.test(signature)
    )
      throw Error('Device renewal unavailable');
    const bytes = Buffer.from(signature, 'base64url');
    if (
      bytes.length !== 64 ||
      bytes.toString('base64url') !== signature ||
      !verify(
        'sha256',
        Buffer.from(challenge.message),
        {
          key: createPublicKey({ key: device.publicKey, format: 'jwk' }),
          dsaEncoding: 'ieee-p1363',
        },
        bytes,
      )
    )
      throw Error('Device proof rejected');
    // Verification and persistence are synchronous. No renewal/revoke interleave.
    if (
      challenge.expires <= this.now() ||
      challenge.elapsedExpires <= this.elapsed() ||
      !this.state.humanDevices.some((d) => d === device)
    )
      throw Error('Device renewal expired');
    return this.sessions.issueDeviceSession(
      deviceID,
      () =>
        challenge.expires > this.now() &&
        challenge.elapsedExpires > this.elapsed() &&
        this.state.humanDevices.some((d) => d === device),
    );
  }
  revoke(cookie, csrf) {
    const session = this.sessions.authorize(cookie, csrf);
    if (!session) throw Error('Human session required');
    const deviceID = session.deviceID;
    const next = {
      ...this.state,
      humanDevices: (this.state.humanDevices || []).filter((d) => d.id !== deviceID),
      humanSessions: this.state.humanSessions.filter((s) =>
        deviceID ? s.deviceID !== deviceID : s !== session,
      ),
    };
    this.save(next);
    Object.assign(this.state, next);
    for (const [id, c] of this.challenges) if (c.deviceID === deviceID) this.challenges.delete(id);
  }
}
