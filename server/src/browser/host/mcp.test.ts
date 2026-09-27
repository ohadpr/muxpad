import { describe, expect, it, vi } from 'vitest';
import { resolveSessionBrowser, sessionMcpPlan } from './mcp.js';

/**
 * The wrapper that gives each agent session its own muxpad browser.
 *
 * The claim worth holding above all: it NEVER leaves an agent without a
 * browser. A subsystem that can take away browsing entirely when it is unwell
 * is worse than the problem it set out to solve.
 */

const JAR = '/data/browser-profiles/default.cookies.json';

describe('what it decides to run', () => {
  it('attaches to this session’s browser when there is one', () => {
    const plan = sessionMcpPlan({ cdpUrl: 'http://127.0.0.1:9410', jarPath: JAR });
    expect(plan.args).toEqual(['--cdp-endpoint=http://127.0.0.1:9410']);
  });

  it('falls back to an isolated browser seeded from the jar', () => {
    // Exactly what agents had before this existed — cookie-warm, page-safe.
    const plan = sessionMcpPlan({ cdpUrl: null, jarPath: JAR });
    expect(plan.args).toContain('--isolated');
    expect(plan.args).toContain(`--storage-state=${JAR}`);
    expect(plan.args.some((a) => a.startsWith('--cdp-endpoint'))).toBe(false);
  });

  it('says WHY either way, because this runs unattended', () => {
    expect(sessionMcpPlan({ cdpUrl: 'http://x', jarPath: JAR }).why).toMatch(/attached/i);
    expect(sessionMcpPlan({ cdpUrl: null, jarPath: JAR }).why).toMatch(/isolated/i);
  });
});

describe('resolving the session browser', () => {
  const ok = (cdpUrl: string) =>
    vi.fn(async () => ({ ok: true, json: async () => ({ cdpUrl }) })) as unknown as typeof fetch;

  it('asks muxpad for a browser named after this session', async () => {
    const f = ok('http://127.0.0.1:9410');
    const url = await resolveSessionBrowser(
      { MUXPAD_TAB_ID: 'tab1', MUXPAD_API_URL: 'http://127.0.0.1:7777' },
      f,
    );
    expect(url).toBe('http://127.0.0.1:9410');
    const call = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as unknown[];
    const init = call[1] as { body: string };
    expect(JSON.parse(init.body)).toMatchObject({ profile: 's-tab1', tabId: 'tab1' });
  });

  it('is null outside a muxpad pane, so the caller falls back', async () => {
    expect(await resolveSessionBrowser({ MUXPAD_API_URL: 'http://x' }, ok('http://y'))).toBeNull();
  });

  it('is null when muxpad cannot be reached, rather than throwing', async () => {
    const dead = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    expect(
      await resolveSessionBrowser({ MUXPAD_TAB_ID: 't', MUXPAD_API_URL: 'http://x' }, dead),
    ).toBeNull();
  });

  it('is null on a refusal, rather than using a garbage endpoint', async () => {
    const bad = vi.fn(async () => ({
      ok: false,
      json: async () => ({}),
    })) as unknown as typeof fetch;
    expect(
      await resolveSessionBrowser({ MUXPAD_TAB_ID: 't', MUXPAD_API_URL: 'http://x' }, bad),
    ).toBeNull();
  });
});
