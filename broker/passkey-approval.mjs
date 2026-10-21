import { createHash, createPublicKey, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { decodeCredentialPublicKey } from '@simplewebauthn/server/helpers';
const digest = (value) => createHash('sha256').update(value).digest('base64url');
const equal = (a, b) =>
  typeof a === 'string' &&
  typeof b === 'string' &&
  Buffer.byteLength(a) === Buffer.byteLength(b) &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
const durations = Object.freeze({ once: 0, '10m': 600000, '1h': 3600000, '1d': 86400000 });
const scope = 'slack-team-all-v2';
export function canonicalIntent(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalIntent).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + canonicalIntent(value[k]))
        .join(',') +
      '}'
    );
  const text = JSON.stringify(value);
  if (text === undefined) throw Error('Invalid intent');
  return text;
}
export function publicKeyFingerprint(cose) {
  const c = decodeCredentialPublicKey(cose);
  if (c.get(1) !== 2 || c.get(3) !== -7 || c.get(-1) !== 1)
    throw Error('Only ES256 enrollment supported');
  const key = createPublicKey({
    format: 'jwk',
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: Buffer.from(c.get(-2)).toString('base64url'),
      y: Buffer.from(c.get(-3)).toString('base64url'),
    },
  });
  return digest(key.export({ format: 'der', type: 'spki' }));
}
export const inlineMode = (config) => config?.approvalMode === 'passkey-inline';
export function exact(value, required, optional = []) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => !required.includes(k) && !optional.includes(k)) ||
    required.some((k) => !Object.hasOwn(value, k))
  )
    throw Error('Invalid fields');
  return value;
}
function assertionShape(value, registration = false) {
  exact(
    value,
    ['id', 'rawId', 'type', 'response', 'clientExtensionResults'],
    ['authenticatorAttachment'],
  );
  if (
    value.type !== 'public-key' ||
    value.rawId !== value.id ||
    !/^[A-Za-z0-9_-]{1,2048}$/.test(value.id)
  )
    throw Error('Invalid credential');
  const r = exact(
    value.response,
    registration
      ? ['clientDataJSON', 'attestationObject']
      : ['clientDataJSON', 'authenticatorData', 'signature'],
    registration ? ['transports'] : ['userHandle'],
  );
  for (const [key, v] of Object.entries(r)) {
    if (key === 'transports') {
      if (
        !Array.isArray(v) ||
        v.length > 8 ||
        v.some(
          (x) => !['usb', 'nfc', 'ble', 'internal', 'hybrid', 'cable', 'smart-card'].includes(x),
        )
      )
        throw Error('Invalid transports');
    } else if (key === 'userHandle' && v === null) continue;
    else if (typeof v !== 'string' || v.length > 32768 || !/^[A-Za-z0-9_-]*$/.test(v))
      throw Error('Invalid assertion');
  }
  const ext = exact(value.clientExtensionResults, [], ['credProps']);
  if (ext.credProps !== undefined) {
    exact(ext.credProps, [], ['rk']);
    if (ext.credProps.rk !== undefined && typeof ext.credProps.rk !== 'boolean')
      throw Error('Invalid extensions');
  }
  if (
    value.authenticatorAttachment !== undefined &&
    value.authenticatorAttachment !== null &&
    !['platform', 'cross-platform'].includes(value.authenticatorAttachment)
  )
    throw Error('Invalid attachment');
}
/** Untrusted app relay has no authority. Only fresh signed user-presence proofs and private admin confirmation do. */
export class PasskeyApproval {
  constructor({
    config,
    state,
    save,
    webauthn,
    now,
    elapsed,
    get,
    fingerprint,
    complete,
    invalidate,
    view,
    grantEpoch,
    revokeGrants,
  }) {
    Object.assign(this, {
      config,
      state,
      save,
      webauthn,
      now,
      elapsed,
      get,
      fingerprint,
      complete,
      invalidate,
      view,
      grantEpoch,
      revokeGrants,
    });
    this.boot = randomUUID();
    this.epoch = 0;
    this.lastWall = now();
    this.lastElapsed = elapsed();
    this.owners = new Map();
    this.ceremonies = new Map();
    this.enrollment = null;
    this.busy = false;
    this.storageFault = false;
  }
  enabled() {
    if (!inlineMode(this.config) || this.storageFault) throw Error('Passkey approval unavailable');
    this.clock();
  }
  clock() {
    const wall = this.now(),
      elapsed = this.elapsed();
    if (wall < this.lastWall || elapsed < this.lastElapsed) {
      this.invalidateAuthority();
      this.enrollment = null;
    }
    this.lastWall = wall;
    this.lastElapsed = elapsed;
    for (const [id, o] of this.owners)
      if (o.expires <= wall || o.elapsedExpires <= elapsed) this.owners.delete(id);
    return { wall, elapsed };
  }
  invalidateAuthority() {
    this.epoch++;
    this.owners.clear();
    this.ceremonies.clear();
    this.invalidate();
  }
  persist(next, valid = () => true) {
    if (this.storageFault || !valid()) throw Error('Authority unavailable');
    try {
      this.save(next);
      if (!valid()) throw Error('Authority changed during persistence');
      Object.assign(this.state, next);
    } catch {
      this.storageFault = true;
      this.invalidateAuthority();
      throw Error('Approval storage uncertain; administrator reconciliation required');
    }
  }
  credential() {
    const c = this.state.inlinePasskey;
    return c && !c.revoked && c.generation === this.config.passkeyGeneration ? c : null;
  }
  isLive(owner) {
    this.clock();
    return (
      !this.storageFault &&
      !!owner &&
      this.owners.get(owner.tokenHash) === owner &&
      owner.epoch === this.epoch &&
      owner.expires > this.now() &&
      owner.elapsedExpires > this.elapsed() &&
      this.credential()?.id === owner.credentialID
    );
  }
  status() {
    this.enabled();
    const c = this.credential();
    return {
      mode: 'passkey-inline',
      registered: !!c,
      teamID: this.config.teamID,
      serverNow: this.now(),
      sessionExpires: [...this.owners.values()].find((o) => this.isLive(o))?.expires ?? null,
      ...(this.state.inlineCandidate?.boot === this.boot
        ? { candidate: this.publicCandidate(this.state.inlineCandidate) }
        : {}),
    };
  }
  publicCandidate(c) {
    return {
      candidateID: c.candidateID,
      credentialID: c.id,
      fingerprint: c.fingerprint,
      rpID: c.rpID,
      origin: c.origin,
      generation: c.generation,
      expires: c.expires,
    };
  }
  enrollmentState() {
    const lease = this.state.inlineEnrollmentLease,
      c = this.state.inlineCandidate;
    return {
      leaseID: lease?.operationID ?? null,
      candidateID: c?.candidateID ?? null,
      candidateFingerprint: c?.fingerprint ?? null,
    };
  }
  beginEnrollment(body) {
    this.enabled();
    exact(body, [
      'operationID',
      'secretHash',
      'previousLeaseID',
      'candidateID',
      'candidateFingerprint',
      'rpID',
      'origin',
      'generation',
    ]);
    if (
      this.busy ||
      this.credential() ||
      typeof body.operationID !== 'string' ||
      !/^[a-f0-9-]{36}$/.test(body.operationID) ||
      typeof body.secretHash !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(body.secretHash) ||
      body.rpID !== this.config.passkeyRPID ||
      body.origin !== this.config.passkeyOrigin ||
      body.generation !== this.config.passkeyGeneration
    )
      throw Error('Exact enrollment lease required');
    const old = this.state.inlineEnrollmentLease,
      requestHash = digest(canonicalIntent(body));
    if (old?.operationID === body.operationID) {
      if (old.requestHash !== requestHash) throw Error('Changed enrollment operation');
      return { operationID: old.operationID, expires: old.expires, consumed: old.consumed };
    }
    const expected = this.enrollmentState();
    if (
      body.previousLeaseID !== expected.leaseID ||
      body.candidateID !== expected.candidateID ||
      body.candidateFingerprint !== expected.candidateFingerprint
    )
      throw Error('Enrollment state changed');
    this.invalidateAuthority();
    this.enrollment = null;
    const epoch = this.epoch,
      { wall, elapsed } = this.clock();
    const lease = {
      operationID: body.operationID,
      requestHash,
      secretHash: body.secretHash,
      boot: this.boot,
      epoch,
      generation: body.generation,
      rpID: body.rpID,
      origin: body.origin,
      expires: wall + 600000,
      elapsedExpires: elapsed + 600000,
      consumed: false,
    };
    this.persist(
      { ...this.state, inlineCandidate: null, inlineEnrollmentLease: lease },
      () => this.epoch === epoch && !this.credential(),
    );
    return { operationID: lease.operationID, expires: lease.expires, consumed: false };
  }
  async registrationOptions(body) {
    this.enabled();
    exact(body, ['secret']);
    const { wall, elapsed } = this.clock();
    const lease = this.state.inlineEnrollmentLease;
    const expires = lease ? lease.expires : this.config.passkeyEnrollmentExpires;
    const capabilityValid =
      typeof body.secret === 'string' &&
      (lease
        ? lease.boot === this.boot &&
          lease.epoch === this.epoch &&
          !lease.consumed &&
          lease.generation === this.config.passkeyGeneration &&
          lease.rpID === this.config.passkeyRPID &&
          lease.origin === this.config.passkeyOrigin &&
          lease.elapsedExpires > elapsed &&
          equal(digest(body.secret), lease.secretHash)
        : this.state.inlineEnrollmentConsumed !== this.config.passkeyGeneration &&
          equal(digest(body.secret), this.config.bootstrapHash));
    if (
      this.busy ||
      this.credential() ||
      this.state.inlineCandidate ||
      typeof body.secret !== 'string' ||
      !capabilityValid ||
      !Number.isFinite(expires) ||
      expires <= wall ||
      expires > wall + 600000
    )
      throw Error('Enrollment unavailable');
    this.busy = true;
    const epoch = this.epoch;
    try {
      // Persist one-use capability consumption BEFORE any asynchronous ceremony creation.
      this.persist(
        {
          ...this.state,
          inlineEnrollmentConsumed: this.config.passkeyGeneration,
          ...(lease ? { inlineEnrollmentLease: { ...lease, consumed: true } } : {}),
        },
        () => this.epoch === epoch,
      );
      const options = await this.webauthn.generateRegistrationOptions({
        rpName: 'muxpad Slack approvals',
        supportedAlgorithmIDs: [-7],
        rpID: this.config.passkeyRPID,
        userName: 'owner',
        attestationType: 'none',
        authenticatorSelection: { residentKey: 'required', userVerification: 'discouraged' },
        extensions: { credProps: true },
      });
      if (
        this.epoch !== epoch ||
        this.storageFault ||
        this.now() >= wall + 120000 ||
        this.elapsed() >= elapsed + 120000
      )
        throw Error('Enrollment changed');
      this.enrollment = Object.freeze({
        challenge: options.challenge,
        epoch,
        expires: Math.min(wall + 120000, expires),
        elapsedExpires: elapsed + 120000,
      });
      return options;
    } finally {
      this.busy = false;
    }
  }
  async registrationVerify(body) {
    this.enabled();
    exact(body, ['response']);
    const e = this.enrollment;
    this.enrollment = null;
    if (
      this.busy ||
      !e ||
      e.epoch !== this.epoch ||
      e.expires <= this.now() ||
      e.elapsedExpires <= this.elapsed() ||
      this.credential() ||
      this.state.inlineCandidate
    )
      throw Error('Enrollment unavailable');
    assertionShape(body.response, true);
    this.busy = true;
    try {
      const v = await this.webauthn.verifyRegistrationResponse({
        response: body.response,
        expectedChallenge: e.challenge,
        supportedAlgorithmIDs: [-7],
        expectedOrigin: this.config.passkeyOrigin,
        expectedRPID: this.config.passkeyRPID,
        requireUserVerification: false,
      });
      if (
        !v.verified ||
        !v.registrationInfo ||
        e.epoch !== this.epoch ||
        e.expires <= this.now() ||
        e.elapsedExpires <= this.elapsed() ||
        this.credential() ||
        this.state.inlineCandidate
      )
        throw Error('Registration refused');
      const credential = v.registrationInfo.credential;
      const publicKey = Buffer.from(credential.publicKey).toString('base64url');
      const candidate = Object.freeze({
        candidateID: randomUUID(),
        id: credential.id,
        publicKey,
        counter: credential.counter,
        fingerprint: publicKeyFingerprint(credential.publicKey),
        origin: this.config.passkeyOrigin,
        rpID: this.config.passkeyRPID,
        generation: this.config.passkeyGeneration,
        boot: this.boot,
        epoch: e.epoch,
        expires: e.expires,
        elapsedExpires: e.elapsedExpires,
      });
      this.persist(
        { ...this.state, inlineCandidate: candidate },
        () =>
          e.epoch === this.epoch &&
          !this.credential() &&
          e.expires > this.now() &&
          e.elapsedExpires > this.elapsed(),
      );
      return { candidate: this.publicCandidate(candidate), registered: false };
    } finally {
      this.busy = false;
    }
  }
  confirmEnrollment(body) {
    this.enabled();
    exact(body, ['candidateID', 'credentialID', 'fingerprint', 'rpID', 'origin', 'generation']);
    const c = this.state.inlineCandidate;
    const valid = () =>
      c &&
      this.state.inlineCandidate === c &&
      c.boot === this.boot &&
      c.epoch === this.epoch &&
      c.expires > this.now() &&
      c.elapsedExpires > this.elapsed() &&
      !this.credential() &&
      c.generation === this.config.passkeyGeneration;
    if (
      !valid() ||
      body.candidateID !== c.candidateID ||
      body.credentialID !== c.id ||
      body.fingerprint !== c.fingerprint ||
      body.rpID !== c.rpID ||
      body.origin !== c.origin ||
      body.generation !== c.generation
    )
      throw Error('Exact enrollment confirmation required');
    this.persist(
      {
        ...this.state,
        inlinePasskey: {
          id: c.id,
          publicKey: c.publicKey,
          counter: c.counter,
          generation: c.generation,
          revoked: false,
        },
        inlineCandidate: null,
      },
      valid,
    );
    this.invalidateAuthority();
    return { registered: true };
  }
  async options(body) {
    this.enabled();
    exact(body, ['id', 'fingerprint', 'decision', 'duration'], ['scope']);
    const c = this.credential();
    if (!c) throw Error('Passkey not enrolled');
    if (
      !['approve', 'reject'].includes(body.decision) ||
      !Object.hasOwn(durations, body.duration) ||
      (body.decision === 'reject' && body.duration !== 'once') ||
      (body.duration === 'once' ? body.scope !== undefined : body.scope !== scope)
    )
      throw Error('Invalid approval scope');
    const r = this.get(body.id);
    if (
      r.state !== 'pending' ||
      r.teamID !== this.config.teamID ||
      this.fingerprint(r) !== body.fingerprint
    )
      throw Error('Request changed');
    for (const [id, v] of this.ceremonies)
      if (v.expires <= this.now() || v.elapsedExpires <= this.elapsed()) this.ceremonies.delete(id);
    if (this.ceremonies.size >= 64) throw Error('Too many ceremonies');
    const intent = Object.freeze({
      version: 1,
      purpose: 'slack-decision',
      action: r.action,
      payload: r.payload,
      id: randomUUID(),
      requestID: r.id,
      fingerprint: body.fingerprint,
      teamID: r.teamID,
      decision: body.decision,
      duration: body.duration,
      scope: body.scope ?? null,
      credentialID: c.id,
      epoch: this.epoch,
      grantEpoch: this.grantEpoch(),
      expires: Math.min(r.expires, this.now() + 120000),
      elapsedExpires: this.elapsed() + 120000,
      nonce: randomBytes(32).toString('base64url'),
    });
    const binding = Object.freeze({
      ...intent,
      intent,
      challenge: digest(canonicalIntent(intent)),
    });
    this.ceremonies.set(binding.id, binding);
    const options = await this.webauthn.generateAuthenticationOptions({
      rpID: this.config.passkeyRPID,
      challenge: Buffer.from(binding.challenge, 'base64url'),
      allowCredentials: [{ id: c.id }],
      userVerification: 'discouraged',
    });
    if (
      this.epoch !== binding.epoch ||
      !this.credential() ||
      binding.expires <= this.now() ||
      binding.elapsedExpires <= this.elapsed()
    ) {
      this.ceremonies.delete(binding.id);
      throw Error('Ceremony expired');
    }
    return { ceremonyID: binding.id, options, intent };
  }
  async verify(body) {
    this.enabled();
    exact(body, ['ceremonyID', 'response']);
    const b = this.ceremonies.get(body.ceremonyID);
    this.ceremonies.delete(body.ceremonyID);
    if (!b || !b.requestID) throw Error('Ceremony consumed');
    const r = this.get(b.requestID),
      c = this.credential();
    const valid = () =>
      !this.storageFault &&
      this.epoch === b.epoch &&
      b.grantEpoch === this.grantEpoch() &&
      this.credential() === c &&
      c?.id === b.credentialID &&
      b.expires > this.now() &&
      b.elapsedExpires > this.elapsed() &&
      this.fingerprint(r) === b.fingerprint &&
      r.elapsedExpires > this.elapsed() &&
      r.teamID === this.config.teamID &&
      r.state === 'verifying';
    if (
      r.state !== 'pending' ||
      !c ||
      b.grantEpoch !== this.grantEpoch() ||
      this.epoch !== b.epoch ||
      b.expires <= this.now() ||
      b.elapsedExpires <= this.elapsed() ||
      this.fingerprint(r) !== b.fingerprint
    )
      throw Error('Request changed');
    r.state = 'verifying'; // Reserve synchronously before verification awaits; concurrent decisions cannot dispatch.
    try {
      assertionShape(body.response);
      if (body.response.id !== c.id) throw Error('Unknown credential');
      const v = await this.webauthn.verifyAuthenticationResponse({
        response: body.response,
        expectedChallenge: b.challenge,
        expectedOrigin: this.config.passkeyOrigin,
        expectedRPID: this.config.passkeyRPID,
        credential: { ...c, publicKey: Buffer.from(c.publicKey, 'base64url') },
        requireUserVerification: false,
      });
      if (!v.verified || !valid()) throw Error('Assertion refused');
      const updated = { ...c, counter: v.authenticationInfo.newCounter };
      this.persist(
        {
          ...this.state,
          inlinePasskey: updated,
          lastInlineProof: { ceremonyID: b.id, requestID: r.id, at: this.now() },
        },
        valid,
      );
      let owner = [...this.owners.values()].find((o) => o.credentialID === c.id && this.isLive(o));
      if (!owner) {
        owner = Object.freeze({
          tokenHash: randomBytes(32).toString('base64url'),
          credentialID: c.id,
          epoch: this.epoch,
          expires: this.now() + 86400000,
          elapsedExpires: this.elapsed() + 86400000,
        });
        this.owners.set(owner.tokenHash, owner);
      }
      if (this.epoch !== b.epoch || !this.isLive(owner) || r.expires <= this.now())
        throw Error('Authority changed');
      return await this.complete(r.id, b.fingerprint, b.decision, {
        duration: b.duration,
        scope: b.scope ?? undefined,
        session: owner,
        reserved: true,
      });
    } catch {
      if (r.state !== 'complete') {
        r.state = 'failed';
        r.error = 'Passkey approval failed; no automatic retry';
      }
      return this.view(r.id);
    }
  }
  async managementOptions(body) {
    this.enabled();
    exact(body, ['purpose']);
    if (body.purpose !== 'revoke-timed-permissions' || !this.credential())
      throw Error('Invalid management purpose');
    for (const [id, c] of this.ceremonies)
      if (c.expires <= this.now() || c.elapsedExpires <= this.elapsed()) this.ceremonies.delete(id);
    if (this.ceremonies.size >= 64) throw Error('Too many ceremonies');
    const c = this.credential(),
      intent = Object.freeze({
        version: 1,
        id: randomUUID(),
        purpose: body.purpose,
        credentialID: c.id,
        epoch: this.epoch,
        grantEpoch: this.grantEpoch(),
        nonce: randomBytes(32).toString('base64url'),
        expires: this.now() + 120000,
        elapsedExpires: this.elapsed() + 120000,
      });
    const b = Object.freeze({ ...intent, intent, challenge: digest(canonicalIntent(intent)) });
    this.ceremonies.set(b.id, b);
    const options = await this.webauthn.generateAuthenticationOptions({
      rpID: this.config.passkeyRPID,
      challenge: Buffer.from(b.challenge, 'base64url'),
      allowCredentials: [{ id: c.id }],
      userVerification: 'discouraged',
    });
    if (this.epoch !== b.epoch || b.expires <= this.now() || b.elapsedExpires <= this.elapsed()) {
      this.ceremonies.delete(b.id);
      throw Error('Ceremony expired');
    }
    return { ceremonyID: b.id, options, intent };
  }
  async managementVerify(body) {
    this.enabled();
    exact(body, ['ceremonyID', 'response']);
    const b = this.ceremonies.get(body.ceremonyID);
    this.ceremonies.delete(body.ceremonyID);
    const c = this.credential();
    const valid = () =>
      b?.purpose === 'revoke-timed-permissions' &&
      !this.storageFault &&
      this.credential() === c &&
      c?.id === b.credentialID &&
      this.epoch === b.epoch &&
      this.grantEpoch() === b.grantEpoch &&
      b.expires > this.now() &&
      b.elapsedExpires > this.elapsed();
    if (!valid()) throw Error('Management ceremony unavailable');
    assertionShape(body.response);
    if (body.response.id !== c.id) throw Error('Unknown passkey');
    const v = await this.webauthn.verifyAuthenticationResponse({
      response: body.response,
      expectedChallenge: b.challenge,
      expectedOrigin: this.config.passkeyOrigin,
      expectedRPID: this.config.passkeyRPID,
      credential: { ...c, publicKey: Buffer.from(c.publicKey, 'base64url') },
      requireUserVerification: false,
    });
    if (!v.verified || !valid()) throw Error('Management verification failed');
    this.persist(
      {
        ...this.state,
        inlinePasskey: { ...c, counter: v.authenticationInfo.newCounter },
        lastInlineProof: { ceremonyID: b.id, purpose: b.purpose, at: this.now() },
      },
      valid,
    );
    if (this.epoch !== b.epoch || this.grantEpoch() !== b.grantEpoch)
      throw Error('Authority changed');
    return this.revokeGrants();
  }
  revoke() {
    this.enabled();
    this.invalidateAuthority();
    const c = this.state.inlinePasskey;
    this.persist({ ...this.state, inlinePasskey: c ? { ...c, revoked: true } : null });
    return { revoked: true };
  }
}
