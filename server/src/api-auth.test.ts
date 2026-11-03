import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  COOKIE_NAME,
  apiAuth,
  apiCredential,
  authMode,
  initApiAuth,
  isExempt,
  presentedCredential,
  refusalKey,
  refusalSummary,
  resetApiAuthForTest,
  resetRefusalLogForTest,
  throttleRefusal,
  verifyCredential,
} from './api-auth.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'muxpad-auth-'));
  resetApiAuthForTest();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const headers = (h: Record<string, string>) => new Headers(h);

describe('the install secret', () => {
  it('is minted on first boot and reused after', () => {
    initApiAuth(dir);
    const first = apiCredential();
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    resetApiAuthForTest();
    initApiAuth(dir);
    expect(apiCredential()).toBe(first); // survives a restart
  });

  it('is written 0600, because a secret under a loose umask was never one', () => {
    initApiAuth(dir);
    expect(statSync(join(dir, 'api-secret')).mode & 0o777).toBe(0o600);
  });

  it('replaces a TRUNCATED file rather than trusting it', () => {
    // A short file is a failed earlier write, not a credential. Trusting it
    // would mean a guessable install secret that looks installed.
    writeFileSync(join(dir, 'api-secret'), 'abc\n');
    initApiAuth(dir);
    expect(apiCredential()).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(join(dir, 'api-secret'), 'utf8').trim()).toBe(apiCredential());
  });
});

describe('verification', () => {
  it('accepts the secret and rejects everything else', () => {
    initApiAuth(dir);
    const key = apiCredential() as string;
    expect(verifyCredential(key)).toBe(true);
    expect(verifyCredential(`${key}x`)).toBe(false);
    expect(verifyCredential(key.slice(0, -1))).toBe(false);
    expect(verifyCredential('')).toBe(false);
    expect(verifyCredential(null)).toBe(false);
  });

  it('does not THROW on a length mismatch', () => {
    // timingSafeEqual throws rather than returning false when the buffers
    // differ in length, which would turn a wrong key into a 500 and put a
    // stack trace in the log instead of a refusal.
    initApiAuth(dir);
    expect(() => verifyCredential('short')).not.toThrow();
    expect(verifyCredential('short')).toBe(false);
  });

  it('rejects everything when no secret is loaded', () => {
    expect(verifyCredential('anything')).toBe(false);
  });
});

describe('where a credential may come from', () => {
  it('reads Bearer, the direct header, and the cookie', () => {
    expect(presentedCredential(headers({ authorization: 'Bearer abc123' }))).toBe('abc123');
    expect(presentedCredential(headers({ authorization: 'bearer  abc123  ' }))).toBe('abc123');
    expect(presentedCredential(headers({ 'x-muxpad-key': 'abc123' }))).toBe('abc123');
    expect(presentedCredential(headers({ cookie: `${COOKIE_NAME}=abc123` }))).toBe('abc123');
  });

  it('finds the cookie among others, which is the normal case', () => {
    expect(presentedCredential(headers({ cookie: `theme=dark; ${COOKIE_NAME}=abc123; x=1` }))).toBe(
      'abc123',
    );
  });

  it('is null when nothing is presented, rather than guessing', () => {
    expect(presentedCredential(headers({}))).toBe(null);
    expect(presentedCredential(headers({ authorization: 'Basic abc' }))).toBe(null);
    expect(presentedCredential(headers({ cookie: 'theme=dark' }))).toBe(null);
  });
});

describe('the mode flag', () => {
  it('defaults to off — the installed default changes nothing', () => {
    expect(authMode({})).toBe('off');
  });

  it('reads observe and enforce', () => {
    expect(authMode({ MUXPAD_API_AUTH: 'observe' })).toBe('observe');
    expect(authMode({ MUXPAD_API_AUTH: 'ENFORCE' })).toBe('enforce');
    expect(authMode({ MUXPAD_API_AUTH: ' enforce ' })).toBe('enforce');
  });

  it('degrades a TYPO to off instead of refusing to boot', () => {
    // The other direction turns `enfroce` into a machine with no muxpad on it.
    // A typo must not be able to lock the user out of their own cockpit.
    expect(authMode({ MUXPAD_API_AUTH: 'enfroce' })).toBe('off');
    expect(authMode({ MUXPAD_API_AUTH: 'true' })).toBe('off');
  });
});

describe('what is exempt', () => {
  it('leaves the app shell open, or no cookie could ever be obtained', () => {
    // The credential is handed out by loading the app. Gate that and there is
    // no way to get one — a cockpit that cannot be opened.
    expect(isExempt('/')).toBe(true);
    expect(isExempt('/assets/index-abc.js')).toBe(true);
    expect(isExempt('/w/abc/t/def')).toBe(true);
    expect(isExempt('/api/health')).toBe(true); // a probe must not need a secret
  });

  it('gates every api and ws path INCLUDING reads', () => {
    // An earlier sketch exempted GET "because reads are harmless". A read
    // here is the conversation, and the multi-node secret boundary dies if a
    // remote node can read.
    expect(isExempt('/api/tabs/x/transcript')).toBe(false);
    expect(isExempt('/api/workspaces')).toBe(false);
    expect(isExempt('/api/publish')).toBe(false);
    // Every upgrade arm in ws.ts, by its real path.
    expect(isExempt('/ws/events')).toBe(false);
    expect(isExempt('/ws/chat/abc')).toBe(false);
    expect(isExempt('/ws/pane/abc')).toBe(false);
    expect(isExempt('/ws/agent-runner/abc')).toBe(false);
  });

  it('gates the BROWSER viewer socket, which is not under /ws/', () => {
    // The first draft gated `/ws/` by prefix and missed this one entirely.
    // It is live control of a Chrome session holding the user's logged-in
    // cookie jar, which makes it the worst possible thing to leave open.
    expect(isExempt('/browser/default/ws')).toBe(false);
    expect(isExempt('/browser/s-01abc/ws')).toBe(false);
    expect(isExempt('/browser/default/')).toBe(false);
  });
});

describe('the middleware', () => {
  const app = (mode: () => 'off' | 'observe' | 'enforce', refusals: unknown[] = []) => {
    const a = new Hono();
    a.use('*', apiAuth({ mode, onRefusal: (i) => refusals.push(i) }));
    a.get('/api/workspaces', (c) => c.json({ ok: true }));
    a.get('/api/health', (c) => c.json({ ok: true }));
    a.get('/', (c) => c.text('app'));
    return a;
  };

  it('off — installs no behaviour at all', async () => {
    initApiAuth(dir);
    const r = await app(() => 'off').request('/api/workspaces');
    expect(r.status).toBe(200);
  });

  it('enforce — 401 without a credential, 200 with one', async () => {
    initApiAuth(dir);
    const key = apiCredential() as string;
    const a = app(() => 'enforce');
    expect((await a.request('/api/workspaces')).status).toBe(401);
    const ok = await a.request('/api/workspaces', {
      headers: { authorization: `Bearer ${key}` },
    });
    expect(ok.status).toBe(200);
    const viaCookie = await a.request('/api/workspaces', {
      headers: { cookie: `${COOKIE_NAME}=${key}` },
    });
    expect(viaCookie.status).toBe(200);
  });

  it('enforce — never gates the shell or the health probe', async () => {
    initApiAuth(dir);
    const a = app(() => 'enforce');
    expect((await a.request('/')).status).toBe(200);
    expect((await a.request('/api/health')).status).toBe(200);
  });

  it('observe — ALLOWS the call and records what it would have refused', async () => {
    // The whole point: answer "what breaks if I turn this on" on a machine
    // with ~120 panes and ~46 browser hosts, without breaking any of them.
    initApiAuth(dir);
    const refusals: unknown[] = [];
    const r = await app(() => 'observe', refusals).request('/api/workspaces', {
      headers: { 'user-agent': 'muxpad-cli/1' },
    });
    expect(r.status).toBe(200);
    expect(refusals).toEqual([{ method: 'GET', path: '/api/workspaces', agent: 'muxpad-cli/1' }]);
  });

  it('observe — says NOTHING about an authenticated caller', async () => {
    // Otherwise the log is noise and the flip decision cannot be read off it.
    initApiAuth(dir);
    const refusals: unknown[] = [];
    await app(() => 'observe', refusals).request('/api/workspaces', {
      headers: { authorization: `Bearer ${apiCredential()}` },
    });
    expect(refusals).toEqual([]);
  });
});

describe('the observe log, collapsed and throttled', () => {
  beforeEach(() => resetRefusalLogForTest());

  it('collapses ids so one endpoint is ONE caller, not four hundred', () => {
    const a = refusalKey('GET', '/api/tabs/01M6G7BXP2Q20W3HPEX2TVW0FP/transcript', 'Mozilla/5.0');
    const b = refusalKey('GET', '/api/tabs/01KX6GKFGSCNWB9S1R87N74WKG/transcript', 'Mozilla/5.0');
    expect(a).toBe(b);
    expect(a).toContain('/api/tabs/:id/transcript');
    // uuid session ids and browser profile slugs too
    expect(refusalKey('GET', '/browser/s-01m687ce6wgy36yp9mgpz1vzew/ws', '-')).toContain(':id');
    expect(refusalKey('GET', '/api/x/0cdf8641-453a-4b22-84a2-69a2bb2ae4cf', '-')).toContain(':id');
  });

  it('names the caller by product, not by its whole UA string', () => {
    expect(refusalKey('GET', '/api/x', 'muxpad-cli/1')).toContain('muxpad-cli');
    expect(refusalKey('GET', '/api/x', 'Mozilla/5.0 (iPhone)')).toContain('browser-mobile');
    expect(refusalKey('GET', '/api/x', 'Mozilla/5.0 (Macintosh)')).toContain('browser');
    expect(refusalKey('GET', '/api/x', 'undici')).toContain('node');
    expect(refusalKey('GET', '/api/x', '-')).toContain('no-agent');
  });

  it('reports a caller ONCE, then not again until the window', () => {
    // The UI polls every 5s per client. Unthrottled this log writes a line a
    // second forever and buries the one caller you needed to see.
    const t = 1_000_000;
    expect(throttleRefusal('GET', '/api/workspaces', 'Mozilla/5.0', t)).toContain(
      '/api/workspaces',
    );
    expect(throttleRefusal('GET', '/api/workspaces', 'Mozilla/5.0', t + 1_000)).toBe(null);
    expect(throttleRefusal('GET', '/api/workspaces', 'Mozilla/5.0', t + 60_000)).toBe(null);
  });

  it('…and then reports WITH A COUNT, which is the whole signal', () => {
    // "never authenticated" and "authenticated 9,998 times out of 10,000" are
    // different situations and the raw log cannot tell them apart.
    const t = 1_000_000;
    throttleRefusal('GET', '/api/workspaces', 'Mozilla/5.0', t);
    for (let i = 1; i < 50; i++) throttleRefusal('GET', '/api/workspaces', 'Mozilla/5.0', t + i);
    const line = throttleRefusal('GET', '/api/workspaces', 'Mozilla/5.0', t + 6 * 60_000);
    expect(line).toMatch(/51× in 6m/);
  });

  it('keeps different callers apart', () => {
    const t = 1_000_000;
    expect(throttleRefusal('GET', '/api/workspaces', 'Mozilla/5.0', t)).toBeTruthy();
    expect(throttleRefusal('POST', '/api/workspaces', 'Mozilla/5.0', t)).toBeTruthy();
    expect(throttleRefusal('GET', '/api/workspaces', 'muxpad-cli/1', t)).toBeTruthy();
    expect(refusalSummary()).toHaveLength(3);
  });

  it('summarises worst first, for a one-shot "what would break"', () => {
    const t = 1_000_000;
    throttleRefusal('GET', '/api/a', '-', t);
    for (let i = 0; i < 5; i++) throttleRefusal('GET', '/api/b', '-', t);
    expect(refusalSummary()[0]?.caller).toContain('/api/b');
    expect(refusalSummary()[0]?.count).toBe(5);
  });
});
