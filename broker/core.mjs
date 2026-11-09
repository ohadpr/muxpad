import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { PasskeyApproval, inlineMode } from './passkey-approval.mjs';
import { safeSlackErrorCode } from './slack.mjs';

const digest = (s) => createHash('sha256').update(s).digest('base64url');
const equal = (a, b) =>
  typeof a === 'string' &&
  typeof b === 'string' &&
  Buffer.byteLength(a) === Buffer.byteLength(b) &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
import { CAPABILITIES, capabilityOf } from './capabilities.mjs';
import { describeMsgvault, msgvaultArgv, validateMsgvault } from './msgvault.mjs';

const TEAM_SCOPE = 'slack-team-all-v2';
/**
 * WHAT A TIMED GRANT MAY COVER — reads, and nothing else.
 *
 * `slack-team-all-v2` covered all eleven actions for up to a day, so
 * "approve Slack for ten minutes" also approved posting, DMing, editing and
 * deleting for ten minutes. The payload is the thing a human consents to, and
 * a grant issued before the payload existed cannot have consented to it.
 *
 * So a timed approval now covers the read verbs only. A write is `once` or it
 * does not happen: you see the message, and then it is sent.
 */
const READ_ACTIONS = Object.freeze([
  'slack.read',
  'slack.search',
  'slack.channels',
  'slack.users',
  'slack.thread',
]);
const READ_SCOPE = 'slack-team-read-v1';
const TEAM_ACTIONS = Object.freeze([
  'slack.post',
  'slack.unpost',
  'slack.read',
  'slack.search',
  'slack.channels',
  'slack.users',
  'slack.dm',
  'slack.thread',
  'slack.react',
  'slack.edit',
  'slack.upload',
]);
const DURATIONS = Object.freeze({ once: 0, '10m': 600_000, '1h': 3_600_000, '1d': 86_400_000 });
const fail = (message) => {
  throw new Error(message);
};
export class Broker {
  constructor({
    config,
    state,
    save,
    slack,
    /** The msgvault executor. Absent on an install with no archive declared:
     *  a request then fails at dispatch rather than at boot, which is the
     *  same shape as every other policy recheck. */
    msgvault = async () => fail('msgvault is not configured on this broker'),
    now = Date.now,
    elapsed = () => Number(process.hrtime.bigint() / 1_000_000n),
    sessionLive = (s) => !!s && s.expires > now(),
    ownerAuthorized = (s) => sessionLive(s),
    webauthn = {
      generateAuthenticationOptions,
      generateRegistrationOptions,
      verifyAuthenticationResponse,
      verifyRegistrationResponse,
    },
  }) {
    this.sessionLive = sessionLive;
    this.ownerAuthorized = ownerAuthorized;
    this.config = config;
    this.state = state;
    this.save = save;
    this.slack = slack;
    this.msgvault = msgvault;
    this.elapsed = elapsed;
    this.lastElapsed = elapsed();
    this.lastClock = now();
    this.now = () => {
      const value = now();
      const elapsedValue = elapsed();
      if (value < this.lastClock || elapsedValue < this.lastElapsed) {
        this.grants.clear();
        this.grantEpoch++;
      }
      this.lastClock = value;
      this.lastElapsed = elapsedValue;
      return value;
    };
    this.webauthn = webauthn;
    this.requests = new Map();
    this.uploads = new Map();
    this.grants = new Map();
    this.grantEpoch = 0;
    this.enrollment = null;
    this.enrolling = false;
    if (inlineMode(config)) {
      this.passkeys = new PasskeyApproval({
        config,
        state,
        save,
        webauthn,
        now: this.now,
        elapsed,
        get: (id) => this.get(id),
        fingerprint: (r) => this.fingerprint(r),
        view: (id) => this.view(id),
        complete: (...args) => this.#decideAuthorized(...args),
        grantEpoch: () => this.grantEpoch,
        revokeGrants: () => this.revokeGrants('all'),
        invalidate: () => {
          this.grants.clear();
          this.grantEpoch++;
        },
      });
      this.sessionLive = (s) => this.passkeys.isLive(s);
    }
  }
  ownerSessions() {
    return inlineMode(this.config)
      ? [...this.passkeys.owners.values()]
      : this.state.humanSessions || [];
  }
  async registerOptions(secret) {
    if (inlineMode(this.config)) fail('Use Settings passkey enrollment');
    if (this.config.approvalMode === 'session') fail('Use human device pairing');
    if (this.state.credential || !equal(digest(secret || ''), this.config.bootstrapHash))
      fail('Enrollment unavailable');
    const options = await this.webauthn.generateRegistrationOptions({
      rpName: 'muxpad protected approvals',
      rpID: this.config.rpID,
      userName: 'owner',
      attestationType: 'none',
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    });
    this.enrollment = { challenge: options.challenge, expires: this.now() + 120_000 };
    return options;
  }
  async register(secret, response) {
    if (inlineMode(this.config)) fail('Use Settings passkey enrollment');
    if (this.config.approvalMode === 'session') fail('Use human device pairing');
    if (
      this.enrolling ||
      this.state.credential ||
      !equal(digest(secret || ''), this.config.bootstrapHash)
    )
      fail('Enrollment unavailable');
    const enrollment = this.enrollment;
    this.enrollment = null;
    if (!enrollment || enrollment.expires < this.now()) fail('Enrollment expired');
    this.enrolling = true;
    try {
      const result = await this.webauthn.verifyRegistrationResponse({
        response,
        expectedChallenge: enrollment.challenge,
        expectedOrigin: this.config.origin,
        expectedRPID: this.config.rpID,
        requireUserVerification: true,
      });
      if (!result.verified || !result.registrationInfo) fail('Passkey verification failed');
      const c = result.registrationInfo.credential;
      this.state.credential = {
        id: c.id,
        publicKey: Buffer.from(c.publicKey).toString('base64url'),
        counter: c.counter,
      };
      this.save(this.state);
      return { registered: true };
    } finally {
      this.enrolling = false;
    }
  }
  async create(input) {
    if (inlineMode(this.config)) this.passkeys.enabled();
    if (
      inlineMode(this.config)
        ? !this.passkeys.credential()
        : this.config.approvalMode === 'session'
          ? this.config.authMode !== 'tailnet-peer' && !this.state.humanPaired
          : !this.state.credential
    )
      fail(
        inlineMode(this.config)
          ? 'Set up the Slack passkey in muxpad Settings'
          : 'Pair the human device or enroll the owner passkey first',
      );
    this.prune();
    if (this.requests.size >= 100) fail('Too many requests; wait for expiry');
    const action = input.action;
    // WHICH CAPABILITY IS BEING ASKED FOR. The prefix is the answer and the
    // only answer: an action nobody registered is refused here, before any
    // payload is looked at, so an unknown capability can never reach a
    // validator or an executor.
    const cap = capabilityOf(action);
    if (!cap || !cap.actions.includes(action)) fail('Unsupported action');
    /**
     * WHICH MACHINE'S CHAT ASKED.
     *
     * A LABEL, and the broker says so rather than pretending otherwise: every
     * request reaches it from the hosting machine, so this is muxpad's claim
     * about itself, not something the broker can verify. What it buys is real
     * anyway — it is shown to the human before they approve, and a timed grant
     * is BOUND to it, so "approve for a day" cannot be spent by a chat on a
     * different machine than the one you were looking at when you approved.
     *
     * An absent origin is `unknown` and never matches a grant minted for a
     * named one, which is the fail-closed direction: an older muxpad gets
     * per-request approval and no timed dispatch.
     */
    const origin =
      typeof input.origin === 'string' && /^[a-z0-9][a-z0-9_-]{0,31}$/.test(input.origin)
        ? input.origin
        : 'unknown';
    const p = input.payload || {};
    let payload, upload;
    if (cap.id === 'msgvault') {
      // Composed, never forwarded — see msgvault.mjs. What comes back is a
      // fresh object built from checked fields, so nothing caller-owned
      // survives into the pending request.
      payload = validateMsgvault(action, p);
    } else if (action === 'slack.channels') payload = {};
    else if (action === 'slack.users') {
      if (typeof p.name !== 'string' || !/^[a-zA-Z0-9._-]{1,80}$/.test(p.name))
        fail('Use an exact Slack username or user ID');
      payload = { name: p.name };
    } else if (action === 'slack.dm') {
      if (this.config.channels?.length) fail('DM opening disabled with a channel allowlist');
      if (typeof p.user !== 'string' || !/^[UW][A-Z0-9]+$/.test(p.user))
        fail('Use an exact Slack user ID');
      payload = { user: p.user };
    } else if (action === 'slack.search') {
      // Slack search can span channels; disallow when a channel policy is present.
      if (this.config.channels?.length) fail('Search disabled with a channel allowlist');
      if (typeof p.query !== 'string' || !p.query || p.query.length > 1000) fail('Invalid query');
      payload = { query: p.query, limit: Math.min(100, Math.max(1, Number(p.limit) || 20)) };
    } else {
      if (typeof p.ref !== 'string' || !/^[CDG][A-Z0-9]+$/.test(p.ref))
        fail('Use an exact Slack conversation ID');
      if (this.config.channels?.length && !this.config.channels.includes(p.ref))
        fail('Channel outside protected policy');
      payload = { channel: p.ref };
      if (
        action === 'slack.edit' &&
        !(this.state.agentMessages || []).some((m) => m.channel === p.ref && m.ts === p.ts)
      )
        fail('Only messages sent by muxpad can be edited');
      if (action === 'slack.post' || action === 'slack.edit') {
        if (typeof p.text !== 'string' || !p.text.trim() || p.text.length > 35000)
          fail('Invalid message');
        payload.text = p.text.startsWith('🤖') ? p.text : `🤖 ${p.text}`;
      }
      if (['slack.unpost', 'slack.edit', 'slack.thread', 'slack.react'].includes(action)) {
        if (typeof p.ts !== 'string' || !/^\d+\.\d+$/.test(p.ts)) fail('Invalid message timestamp');
        payload.ts = p.ts;
      }
      if (action === 'slack.post' && p.thread_ts !== undefined) {
        if (typeof p.thread_ts !== 'string' || !/^\d+\.\d+$/.test(p.thread_ts))
          fail('Invalid thread timestamp');
        payload.thread_ts = p.thread_ts;
      }
      if (action === 'slack.react') {
        if (
          typeof p.name !== 'string' ||
          !/^[a-z0-9_+\-]{1,100}(?:::skin-tone-[2-6])?$/.test(p.name) ||
          !['add', 'remove'].includes(p.operation)
        )
          fail('Invalid reaction');
        payload.name = p.name;
        payload.operation = p.operation;
      }
      if (action === 'slack.upload') {
        if (
          typeof p.filename !== 'string' ||
          !/^[^/\\\x00-\x1f\x7f]{1,200}$/.test(p.filename) ||
          ['.', '..'].includes(p.filename)
        )
          fail('Invalid filename');
        if (
          typeof p.content !== 'string' ||
          p.content.length > 13981016 ||
          /[^A-Za-z0-9+/=]/.test(p.content)
        )
          fail('Invalid upload data');
        upload = Buffer.from(p.content, 'base64');
        if (
          !upload.length ||
          upload.length > 10 * 1024 * 1024 ||
          upload.toString('base64') !== p.content
        )
          fail('File must be between 1 byte and 10 MiB');
        if (
          [...this.uploads.values()].reduce((n, b) => n + b.length, 0) + upload.length >
          20 * 1024 * 1024
        )
          fail('Pending upload limit reached');
        payload.text = '🤖 Shared by muxpad';
        payload.filename = p.filename;
        payload.bytes = upload.length;
        payload.sha256 = createHash('sha256').update(upload).digest('hex');
        if (p.text !== undefined) {
          if (typeof p.text !== 'string' || p.text.length > 35000) fail('Invalid file message');
          if (p.text.trim()) payload.text = p.text.startsWith('🤖') ? p.text : `🤖 ${p.text}`;
        }
        if (p.thread_ts !== undefined) {
          if (typeof p.thread_ts !== 'string' || !/^\d+\.\d+$/.test(p.thread_ts))
            fail('Invalid thread timestamp');
          payload.thread_ts = p.thread_ts;
        }
      }
      if (action === 'slack.thread' && p.cursor !== undefined) {
        if (typeof p.cursor !== 'string' || p.cursor.length > 2000) fail('Invalid thread cursor');
        payload.cursor = p.cursor;
      }
      if (action === 'slack.read' || action === 'slack.thread') {
        payload.limit = Math.min(100, Math.max(1, Number(p.limit) || 50));
        if (p.oldest !== undefined) {
          if (!Number.isFinite(Number(p.oldest)) || Number(p.oldest) < 0) fail('Invalid oldest');
          payload.oldest = Number(p.oldest);
        }
      }
    }
    // Copy only validated fields. No caller-owned object survives into the pending request.
    const request = {
      id: randomUUID(),
      action,
      origin,
      payload: Object.freeze(payload),
      state: 'pending',
      expires: this.now() + 300_000,
      nonce: randomBytes(32).toString('base64url'),
    };
    Object.defineProperty(request, 'teamID', { value: this.config.teamID, enumerable: true });
    if (inlineMode(this.config))
      Object.defineProperty(request, 'elapsedExpires', { value: this.elapsed() + 300000 });
    this.requests.set(request.id, request);
    if (upload) this.uploads.set(request.id, upload);
    const grant = this.activeGrants().find(
      (g) =>
        g.teamID === request.teamID &&
        g.actions.includes(request.action) &&
        equal(g.scope, this.grantScope(request)),
    );
    if (grant) {
      // Consume before audit or asynchronous identity checks: manual approval
      // must never race this automatic dispatch.
      if (this.config.authMode === 'tailnet-peer' || inlineMode(this.config))
        request.state = 'verifying';
      try {
        this.recordAuthorization({
          id: request.id,
          hash: this.fingerprint(request),
          decision: 'approve',
          at: this.now(),
          mode: 'timed-grant',
          grantID: grant.id,
        });
        // State persistence can take time; check expiry again at dispatch.
        if (request.expires > this.now() && this.activeGrants().some((g) => g.id === grant.id)) {
          request.grantID = grant.id;
          const owner = this.ownerSessions().find((s) => s.tokenHash === grant.owner);
          if (
            (this.config.authMode === 'tailnet-peer' && !(await this.ownerAuthorized(owner))) ||
            !this.activeGrants().some((g) => g.id === grant.id) ||
            request.expires <= this.now()
          )
            fail('Permission owner is no longer authorized');
          await this.execute(request);
        } else if (this.config.authMode === 'tailnet-peer' || inlineMode(this.config))
          fail('Permission expired before dispatch');
      } catch {
        request.state = 'failed';
        request.error = 'Authorization could not be recorded; nothing sent';
      }
    } else if (
      !inlineMode(this.config) &&
      this.config.autoRead === true &&
      ['slack.read', 'slack.search', 'slack.channels'].includes(action)
    )
      await this.execute(request);
    return this.view(request.id);
  }
  prune() {
    for (const [id, r] of this.requests) {
      if (r.expires + 300_000 < this.now()) this.requests.delete(id);
      else if (
        r.state === 'pending' &&
        (r.expires <= this.now() || (inlineMode(this.config) && r.elapsedExpires <= this.elapsed()))
      )
        r.state = 'expired';
      if (!['pending', 'verifying', 'executing'].includes(r.state) || !this.requests.has(id))
        this.uploads.delete(id);
    }
  }
  get(id) {
    this.prune();
    return this.requests.get(id) || fail('Unknown request');
  }
  view(id) {
    const r = this.get(id);
    return {
      id: r.id,
      action: r.action,
      teamID: r.teamID,
      // Shown to the human: WHICH MACHINE'S CHAT asked. A label muxpad
      // asserts — see `create` — but one the human sees before approving, and
      // one a timed grant is bound to.
      origin: r.origin ?? 'unknown',
      // What a timed approval of THIS request would actually cover, so the
      // page can describe the promise it is about to make rather than reciting
      // one that was true in an earlier release.
      // THE REQUEST'S OWN SCOPE, not Slack's. This line sat one above
      // `timedAllowed`, which was made capability-aware while this was left
      // alone — so an archive request advertised `slack-team-all-v2`, the
      // page offered "full Slack access" for a mail read, and the duration
      // came back as a scope `decideSession` then refused. Fail-closed, and
      // wrong in the one place a human is reading.
      timedScope: this.timedScope(this.capabilityOfRequest(r)),
      timedAllowed:
        this.timedScope(this.capabilityOfRequest(r)) !==
          this.capabilityOfRequest(r).readScope ||
        this.capabilityOfRequest(r).readActions.includes(r.action),
      payload: r.payload,
      state: r.state,
      expires: r.expires,
      fingerprint: this.fingerprint(r),
      approval_url:
        this.config.approvalMode === 'session'
          ? `${this.config.origin}/review`
          : `${this.config.origin}/approve/${r.id}`,
      ...(r.result !== undefined ? { result: r.result } : {}),
      ...(r.error ? { error: r.error } : {}),
      ...(r.grantID ? { grantID: r.grantID } : {}),
      ...(r.grantWarning ? { grantWarning: r.grantWarning } : {}),
    };
  }
  fingerprint(r) {
    return digest(
      JSON.stringify({
        id: r.id,
        action: r.action,
        teamID: r.teamID,
        // IN THE FINGERPRINT, not merely in the view. The fingerprint is what
        // the decision is taken against, so an origin that was displayed and
        // then swapped would otherwise be approved as something else — and the
        // grant it mints is scoped by exactly this field.
        origin: r.origin ?? 'unknown',
        payload: r.payload,
        expires: r.expires,
        nonce: r.nonce,
      }),
    );
  }
  pending() {
    this.prune();
    return [...this.requests.values()]
      .filter((r) => r.state === 'pending')
      .map((r) => this.view(r.id));
  }
  recordAuthorization(entry) {
    const next = {
      ...this.state,
      lastDecision: entry,
      approvalHistory: [...(this.state.approvalHistory || []).slice(-199), entry],
    };
    try {
      this.save(next);
    } catch (error) {
      if (inlineMode(this.config)) {
        this.passkeys.storageFault = true;
        this.passkeys.invalidateAuthority();
      }
      throw error;
    }
    Object.assign(this.state, next);
  }
  /**
   * WHAT A TIMED APPROVAL IS ALLOWED TO COVER on this install.
   *
   * `read` is the one worth having: a timed grant covers the five read verbs
   * and a write is `once` or it does not happen. `all` is what shipped —
   * eleven verbs for up to a day — and it stays the DEFAULT on purpose, so
   * installing a broker with this code changes nothing until the owner turns
   * it on in the protected config. A security change that arrives silently is
   * one nobody reviewed.
   */
  timedScope(capability = CAPABILITIES.slack) {
    // A capability with no write set has nothing to hold back, so its read
    // scope IS its full scope and the owner's `timedGrants` switch does not
    // apply to it — there is no wider thing it could accidentally mean.
    if (capability.readScope === capability.fullScope) return capability.readScope;
    return this.config.timedGrants === 'read' ? capability.readScope : capability.fullScope;
  }
  /** The capability a pending request belongs to. */
  capabilityOfRequest(r) {
    return capabilityOf(r.action) ?? CAPABILITIES.slack;
  }
  grantScope(request) {
    // Versioned explicit action scope; never authorizes future Slack APIs.
    //
    // The ORIGIN is part of the scope, which is what makes a timed grant
    // spendable only by the machine it was approved for: matching is
    // `equal(g.scope, grantScope(request))`, so a request from elsewhere
    // simply does not find it and goes to the human instead.
    return JSON.stringify({
      teamID: request.teamID,
      origin: request.origin ?? 'unknown',
      permissionScope: this.timedScope(this.capabilityOfRequest(request)),
    });
  }
  activeGrants() {
    for (const [id, grant] of this.grants) {
      const owner = this.ownerSessions().find(
        (s) => s.tokenHash === grant.owner && s.expires > this.now() && this.sessionLive(s),
      );
      if (
        grant.teamID !== this.config.teamID ||
        !owner ||
        grant.expires <= this.now() ||
        grant.elapsedExpires <= this.elapsed()
      )
        this.grants.delete(id);
    }
    return [...this.grants.values()];
  }
  listGrants() {
    return this.activeGrants().map(({ owner, elapsedExpires, ...grant }) => grant);
  }
  revokeGrants(id) {
    // Called only behind the human-session + Origin + CSRF HTTP boundary.
    this.grantEpoch++;
    if (id === 'all') this.grants.clear();
    else if (typeof id === 'string') this.grants.delete(id);
    else fail('Invalid grant ID');
    return { grants: this.listGrants() };
  }
  async decideSession(id, fingerprint, decision, { duration = 'once', scope, session } = {}) {
    if (this.config.approvalMode !== 'session') fail('Session approval is disabled');
    return this.#decideAuthorized(id, fingerprint, decision, { duration, scope, session });
  }
  async #decideAuthorized(
    id,
    fingerprint,
    decision,
    { duration = 'once', scope, session, reserved = false } = {},
  ) {
    if (
      typeof duration !== 'string' ||
      !Object.hasOwn(DURATIONS, duration) ||
      (decision !== 'approve' && duration !== 'once')
    )
      fail('Invalid approval duration');
    // Old cached clients disclosed a narrower grant. Never silently upgrade it.
    // Whichever scope this install uses, the client has to name it: the string
    // it sent is the promise it DISPLAYED, so accepting a different one would
    // approve something other than what the human read.
    const decideCap = capabilityOf(this.get(id)?.action) ?? CAPABILITIES.slack;
    const timedScope = this.timedScope(decideCap);
    if (duration === 'once' ? scope !== undefined : scope !== timedScope)
      fail(
        timedScope === decideCap.readScope
          ? // The wording is Slack's and stays Slack's: an older cached client
            // matches on this string, and the dialog already names the
            // capability, so there is nothing for a capability name to add
            // here except a broken contract.
            'Timed approval covers reading only; re-open muxpad to get the current prompt'
          : 'Explicit full Slack access scope required for timed approval',
      );
    const owner =
      session &&
      this.ownerSessions().find(
        (s) => s.tokenHash === session.tokenHash && s.expires > this.now() && this.sessionLive(s),
      );
    if (
      (duration !== 'once' || this.config.authMode === 'tailnet-peer' || inlineMode(this.config)) &&
      !owner
    )
      fail('Live human session required');
    if (duration !== 'once' && this.activeGrants().length >= 100)
      fail('Too many timed permissions; revoke existing permissions first');
    const r = this.get(id);
    // A WRITE IS `once` OR IT DOES NOT HAPPEN — under `timedGrants: 'read'`.
    // The thing you consent to is the payload, and a grant issued before the
    // payload existed cannot have covered it.
    const rCap = this.capabilityOfRequest(r);
    if (
      duration !== 'once' &&
      this.timedScope(rCap) === rCap.readScope &&
      !rCap.readActions.includes(r.action)
    )
      fail(`${r.action} cannot be approved for a duration — only reading can`);
    if (
      r.teamID !== this.config.teamID ||
      r.state !== (reserved ? 'verifying' : 'pending') ||
      r.expires <= this.now() ||
      (inlineMode(this.config) && r.elapsedExpires <= this.elapsed()) ||
      !['approve', 'reject'].includes(decision) ||
      !equal(this.fingerprint(r), fingerprint)
    )
      fail('Request changed, expired or already consumed');
    // The HTTP boundary has authenticated the human-only cookie + CSRF token.
    // Consume synchronously, before any await, so concurrent decisions cannot race.
    r.state = 'verifying';
    const approvedAt = this.now();
    const approvedElapsed = this.elapsed();
    const elapsedDeadline =
      approvedElapsed + Math.min(DURATIONS[duration], owner ? owner.expires - approvedAt : 0);
    const grantEpoch = this.grantEpoch;
    try {
      this.recordAuthorization({
        id,
        hash: fingerprint,
        decision,
        at: this.now(),
        mode: 'session',
        duration,
        permissionScope: duration === 'once' ? 'exact-request' : this.timedScope(rCap),
        teamID: r.teamID,
      });
      if (decision === 'reject') r.state = 'rejected';
      else {
        const dispatchAt = this.now();
        if (r.expires <= dispatchAt || grantEpoch !== this.grantEpoch)
          fail('Approval expired before dispatch');
        if (
          session &&
          !this.ownerSessions().some(
            (s) =>
              s.tokenHash === session.tokenHash && s.expires > dispatchAt && this.sessionLive(s),
          )
        )
          fail('Human session expired before dispatch');
        if (
          this.config.authMode === 'tailnet-peer' &&
          session &&
          !(await this.ownerAuthorized(owner))
        )
          fail('Permission owner unavailable');
        if (
          r.expires <= this.now() ||
          grantEpoch !== this.grantEpoch ||
          (session && !this.sessionLive(owner))
        )
          fail('Permission changed before dispatch');
        await this.execute(r);
        // A failed/uncertain first operation never creates a reusable grant.
        // Re-check owner lifetime after asynchronous Slack execution: logout
        // or expiry while it was in flight must prevent permission activation.
        if (r.state === 'complete' && duration !== 'once') {
          const authorized =
            this.config.authMode !== 'tailnet-peer' || (await this.ownerAuthorized(owner));
          const liveOwner = this.ownerSessions().find(
            (s) => s.tokenHash === owner.tokenHash && s.expires > this.now(),
          );
          if (
            liveOwner &&
            authorized &&
            this.sessionLive(liveOwner) &&
            r.teamID === this.config.teamID &&
            grantEpoch === this.grantEpoch &&
            approvedAt + DURATIONS[duration] > this.now() &&
            elapsedDeadline > this.elapsed() &&
            this.activeGrants().length < 100
          ) {
            const grant = {
              id: randomUUID(),
              scope: this.grantScope(r),
              action:
                this.timedScope(rCap) === rCap.readScope ? `${rCap.id}.read-all` : `${rCap.id}.all`,
              actions:
                this.timedScope(rCap) === rCap.readScope ? rCap.readActions : rCap.actions,
              permissionScope: this.timedScope(rCap),
              origin: r.origin ?? 'unknown',
              teamID: r.teamID,
              expires: Math.min(approvedAt + DURATIONS[duration], liveOwner.expires),
              owner: liveOwner.tokenHash,
              elapsedExpires: elapsedDeadline,
            };
            // Volatile: restart, logout, expiry or explicit revocation ends it.
            for (const g of this.activeGrants())
              if (g.scope === grant.scope && g.owner === grant.owner) this.grants.delete(g.id);
            this.grants.set(grant.id, Object.freeze(grant));
            r.grantID = grant.id;
          } else
            r.grantWarning =
              'Action completed; no timed permission was created because the session, permission state, expiry or grant limit changed';
        }
      }
    } catch {
      r.state = 'failed';
      r.error = 'Approval failed; no automatic retry';
    }
    return this.view(id);
  }
  async options(id, decision) {
    if (inlineMode(this.config)) fail('Use in-chat passkey approval');
    if (this.config.approvalMode === 'session')
      fail('Passkey approval is disabled in session mode');
    const r = this.get(id);
    if (r.state !== 'pending' || !['approve', 'reject'].includes(decision))
      fail('Request is not pending');
    const challenge = digest(
      JSON.stringify({
        id,
        action: r.action,
        teamID: r.teamID,
        payload: r.payload,
        nonce: r.nonce,
        expires: r.expires,
        decision,
      }),
    );
    // Decision is part of the signed challenge. Asking for another option invalidates the first.
    r.challenge = challenge;
    r.decision = decision;
    return this.webauthn.generateAuthenticationOptions({
      rpID: this.config.rpID,
      challenge: Buffer.from(challenge, 'base64url'),
      allowCredentials: [{ id: this.state.credential.id }],
      userVerification: 'required',
    });
  }
  async decide(id, response) {
    if (inlineMode(this.config)) fail('Use in-chat passkey approval');
    if (this.config.approvalMode === 'session')
      fail('Passkey approval is disabled in session mode');
    const r = this.get(id);
    if (r.state !== 'pending' || !r.challenge) fail('Request is not pending');
    const challenge = r.challenge;
    const decision = r.decision;
    r.state = 'verifying';
    try {
      const c = this.state.credential;
      if (response?.id !== c.id) fail('Unknown passkey');
      const verified = await this.webauthn.verifyAuthenticationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: this.config.origin,
        expectedRPID: this.config.rpID,
        credential: { ...c, publicKey: Buffer.from(c.publicKey, 'base64url') },
        requireUserVerification: true,
      });
      if (!verified.verified || r.expires <= this.now()) fail('Verification failed or expired');
      c.counter = verified.authenticationInfo.newCounter;
      // Persist the authenticator counter and consumed action BEFORE making an external call.
      this.state.lastDecision = { id, hash: challenge, decision, at: this.now() };
      this.save(this.state);
      if (decision === 'reject') r.state = 'rejected';
      else await this.execute(r);
    } catch {
      // No retries after an uncertain write, and invalid assertions cannot execute.
      r.state = 'failed';
      r.error = 'Approval failed; no automatic retry';
    }
    return this.view(id);
  }
  async execute(r) {
    if (r.dispatchStarted || !['pending', 'verifying'].includes(r.state))
      fail('Request dispatch already consumed');
    Object.defineProperty(r, 'dispatchStarted', { value: true });
    r.state = 'executing';
    try {
      // Recheck protected policy at dispatch, after any asynchronous audit work.
      if (
        r.teamID !== this.config.teamID ||
        !(capabilityOf(r.action)?.actions ?? []).includes(r.action) ||
        (inlineMode(this.config) && r.elapsedExpires <= this.elapsed())
      )
        fail('Team/action policy changed');
      if (
        this.config.channels?.length &&
        capabilityOf(r.action)?.id === 'slack' &&
        (['slack.search', 'slack.dm'].includes(r.action) ||
          (r.payload.channel && !this.config.channels.includes(r.payload.channel)))
      )
        fail('Channel policy changed');
      if (
        r.action === 'slack.edit' &&
        !(this.state.agentMessages || []).some(
          (m) => m.channel === r.payload.channel && m.ts === r.payload.ts,
        )
      )
        fail('Message outside muxpad edit policy');
      r.result =
        capabilityOf(r.action)?.id === 'msgvault'
          ? await this.msgvault(r.action, r.payload)
          : await this.slack(r.action, r.payload, this.uploads.get(r.id));
      if (
        r.action === 'slack.post' &&
        typeof r.result?.channel === 'string' &&
        typeof r.result?.ts === 'string'
      ) {
        const next = {
          ...this.state,
          agentMessages: [
            ...(this.state.agentMessages || []).slice(-499),
            { channel: r.result.channel, ts: r.result.ts },
          ],
        };
        this.save(next);
        Object.assign(this.state, next);
      }
      r.state = 'complete';
    } catch (error) {
      r.state = 'failed';
      // NAME THE SYSTEM THAT FAILED. This said "Slack request failed;
      // inspect Slack before retrying" for an archive read — which sends
      // somebody to look at the wrong thing, and hid the real cause behind
      // a sanitiser built for Slack's error codes.
      const cap = capabilityOf(r.action);
      if (cap && cap.id !== 'slack') {
        // Not run through the Slack sanitiser: these messages are msgvault's
        // own refusals and a local path at worst. The grant is never in them
        // — it is passed as a file.
        r.error = `${cap.label} request failed: ${String(error?.message ?? error).slice(0, 200)}`;
      } else {
        const code = safeSlackErrorCode(error);
        r.error = code
          ? `Slack request failed (${code}); inspect Slack before retrying`
          : 'Slack request failed; inspect Slack before retrying';
      }
    } finally {
      this.uploads.delete(r.id);
    }
  }
}
