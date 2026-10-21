import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { HumanSessions, SESSION_COOKIE } from './human-session.mjs';
import { allowedPeer, checkNodeAuthority, readNodePolicy } from './node-policy.mjs';
const hash = (s) => createHash('sha256').update(s).digest('base64url');
const key = (p) => JSON.stringify([p.nodeID, p.ownerID]);
export class NodeSessions extends HumanSessions {
  constructor({
    policy = readNodePolicy,
    check = checkNodeAuthority,
    elapsed = () => Number(process.hrtime.bigint() / 1_000_000n),
    ...options
  }) {
    super(options);
    this.policy = policy;
    this.check = check;
    this.elapsed = elapsed;
    this.challenges = new Map();
    this.storageFault = false;
    // Browser bootstrap is automatic, so no reusable peer bearer need survive
    // a transport/broker restart. Legacy paired records remain untouched.
    for (const s of this.state.humanSessions || []) if (s.peer) s.invalidated = true;
  }
  persist(next) {
    try {
      this.save(next);
    } catch {
      this.storageFault = true;
      for (const s of this.state.humanSessions || []) if (s.peer) s.invalidated = true;
      this.challenges.clear();
      throw Error(
        'Approval storage uncertain; authority disabled pending administrator reconciliation',
      );
    }
  }
  invalidate(session) {
    if (!session?.peer || session.invalidated) return;
    session.invalidated = true;
    try {
      this.persist(this.state);
    } catch {
      /* memory remains denied */
    }
  }
  invalidateAll() {
    for (const s of this.state.humanSessions || []) this.invalidate(s);
  }
  policySnapshot() {
    if (this.storageFault || this.checkingPolicy) return null;
    let policy;
    try {
      policy = this.policy();
    } catch {
      this.invalidateAll();
      return null;
    }
    const journal = this.state.nodeAuthPolicy;
    if (journal?.current === policy.digest) return policy;
    this.invalidateAll();
    if (this.storageFault || journal?.retired?.includes(policy.digest)) return null;
    const retired = [...(journal?.retired || []), ...(journal?.current ? [journal.current] : [])];
    if (retired.length > 256) {
      this.storageFault = true;
      return null;
    }
    const next = { ...this.state, nodeAuthPolicy: { current: policy.digest, retired } };
    this.checkingPolicy = true;
    try {
      this.persist(next);
      Object.assign(this.state, next);
      return policy;
    } catch {
      return null;
    } finally {
      this.checkingPolicy = false;
    }
  }
  peerAllowed(peer, { paused = false } = {}) {
    const policy = this.policySnapshot();
    return (
      !!policy &&
      allowedPeer(policy, peer) &&
      !(this.state.nodeRevocations || []).includes(key(peer)) &&
      (paused || !(this.state.nodePauses || []).includes(key(peer)))
    );
  }
  isLive(session) {
    if (!session?.peer || session.invalidated) return false;
    const live =
      session.expires > this.now() &&
      this.state.humanSessions?.includes(session) &&
      this.peerAllowed(session.peer);
    if (!live) this.invalidate(session);
    return !!live;
  }
  async ownerAuthorized(session) {
    if (!this.isLive(session)) return false;
    let valid = false;
    try {
      valid = await this.check(session.peer);
    } catch {
      /* fail closed */
    }
    if (!valid || !this.isLive(session)) {
      this.invalidate(session);
      return false;
    }
    return true;
  }
  authenticate(cookie, peer) {
    const session = super.authenticate(cookie);
    if (!this.isLive(session) || !this.peerAllowed(peer) || key(session.peer) !== key(peer))
      return null;
    if (session.peer.policy !== peer.policy || session.peer.generation !== peer.generation) {
      this.invalidate(session);
      return null;
    }
    return session;
  }
  authorize(cookie, csrf, peer) {
    const session = this.authenticate(cookie, peer);
    return session &&
      typeof csrf === 'string' &&
      Buffer.byteLength(session.csrf) === Buffer.byteLength(csrf) &&
      timingSafeEqual(Buffer.from(session.csrf), Buffer.from(csrf))
      ? session
      : null;
  }
  cookieToken(cookie) {
    if (typeof cookie !== 'string' || cookie.length > 4096) return null;
    const values = cookie
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s.startsWith(`${SESSION_COOKIE}=`));
    if (values.length !== 1) return null;
    const token = values[0].slice(SESSION_COOKIE.length + 1);
    return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
  }
  browserPause(cookie, peer) {
    const token = this.cookieToken(cookie);
    return token && peer
      ? (this.state.browserPauses || []).find(
          (p) => p.tokenHash === hash(token) && p.peerKey === key(peer),
        ) || null
      : null;
  }
  endBrowser(cookie, csrf, peer) {
    const session = this.authorize(cookie, csrf, peer);
    const token = this.cookieToken(cookie);
    if (!session || !token) throw Error('Live browser session required');
    const pauses = [
      ...(this.state.browserPauses || []).filter((p) => p.tokenHash !== session.tokenHash),
      {
        tokenHash: session.tokenHash,
        peerKey: key(peer),
        epoch: randomBytes(32).toString('base64url'),
      },
    ];
    const next = {
      ...this.state,
      browserPauses: pauses,
      humanSessions: this.state.humanSessions.filter((s) => s !== session),
    };
    Object.assign(this.state, next);
    this.challenges.clear();
    if (pauses.length > 512) {
      this.storageFault = true;
      throw Error('Administrator must reconcile browser history');
    }
    this.persist(next);
    // This retained cookie is now a durable NON-AUTHORITY logout marker.
    return { token, maxAge: 31536000 };
  }
  issue(peer, { resume = false, cookie } = {}) {
    if (!this.peerAllowed(peer, { paused: resume }))
      throw Error('Trusted device access unavailable');
    const pausedBrowser = this.browserPause(cookie, peer);
    if (pausedBrowser && !resume) throw Error('Browser is signed out; explicit Resume required');
    const lifetime = Math.min(
      86400_000,
      Math.max(3600_000, this.config.sessionLifetimeMs || 86400_000),
    );
    const token = randomBytes(32).toString('base64url');
    const session = {
      tokenHash: hash(token),
      csrf: randomBytes(32).toString('base64url'),
      expires: this.now() + lifetime,
      peer: { ...peer },
    };
    const live = (this.state.humanSessions || []).filter((s) => this.isLive(s));
    if (live.length >= 128) throw Error('Too many browser sessions');
    const next = {
      ...this.state,
      ...(resume
        ? {
            nodePauses: (this.state.nodePauses || []).filter((k) => k !== key(peer)),
            browserPauses: (this.state.browserPauses || []).filter((p) => p !== pausedBrowser),
          }
        : {}),
      humanSessions: [...(this.state.humanSessions || []).filter((s) => !s.peer), ...live, session],
    };
    // Session publication and explicit unpause are ONE durable operation.
    this.persist(next);
    if (!this.peerAllowed(peer, { paused: resume }))
      throw Error('Device policy changed during persistence');
    Object.assign(this.state, next);
    return { token, maxAge: lifetime / 1000 };
  }
  pauseEpoch(peer) {
    return this.state.nodePauseEpochs?.[key(peer)] || 0;
  }
  resumeChallenge(peer, cookie) {
    if (!this.peerAllowed(peer, { paused: true })) throw Error('Trusted device access unavailable');
    const pausedBrowser = this.browserPause(cookie, peer);
    if (!pausedBrowser && this.peerAllowed(peer)) throw Error('No browser resume is needed');
    for (const [id, c] of this.challenges)
      if (c.expires <= this.now() || c.elapsedExpires <= this.elapsed()) this.challenges.delete(id);
    if (this.challenges.size >= 128) throw Error('Too many resume attempts');
    const nonce = randomBytes(32).toString('base64url');
    this.challenges.set(nonce, {
      key: key(peer),
      policy: peer.policy,
      generation: peer.generation,
      epoch: this.pauseEpoch(peer),
      browser: pausedBrowser?.tokenHash || null,
      browserEpoch: pausedBrowser?.epoch || null,
      expires: this.now() + 60_000,
      elapsedExpires: this.elapsed() + 60_000,
    });
    return nonce;
  }
  resume(peer, nonce, cookie) {
    const c = this.challenges.get(nonce);
    const pausedBrowser = this.browserPause(cookie, peer);
    this.challenges.delete(nonce);
    if (
      !c ||
      c.expires <= this.now() ||
      c.elapsedExpires <= this.elapsed() ||
      c.key !== key(peer) ||
      c.policy !== peer.policy ||
      c.generation !== peer.generation ||
      c.epoch !== this.pauseEpoch(peer) ||
      c.browser !== (pausedBrowser?.tokenHash || null) ||
      c.browserEpoch !== (pausedBrowser?.epoch || null) ||
      !this.peerAllowed(peer, { paused: true })
    )
      throw Error('Resume expired');
    return this.issue(peer, { resume: true, cookie });
  }
  endNode(peer, revoke = false) {
    if (!this.peerAllowed(peer)) throw Error('Trusted device required');
    const field = revoke ? 'nodeRevocations' : 'nodePauses';
    const entries = new Set(this.state[field] || []);
    entries.add(key(peer));
    // Denial is immediate even if persistence or history capacity fails.
    const next = {
      ...this.state,
      [field]: [...entries],
      nodePauseEpochs: { ...this.state.nodePauseEpochs, [key(peer)]: this.pauseEpoch(peer) + 1 },
      humanSessions: (this.state.humanSessions || []).filter(
        (s) => !s.peer || key(s.peer) !== key(peer),
      ),
    };
    Object.assign(this.state, next);
    this.challenges.clear();
    if (entries.size > 512) {
      this.storageFault = true;
      throw Error('Administrator must reconcile device history');
    }
    this.persist(next);
  }
  pair() {
    throw Error('Browser pairing disabled in tailnet-peer mode');
  }
  issueDeviceSession() {
    throw Error('Browser keys disabled in tailnet-peer mode');
  }
}
