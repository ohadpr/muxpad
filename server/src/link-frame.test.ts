import { describe, expect, it, vi } from 'vitest';
import { LinkFrameChecker, frameVerdict } from './link-frame.js';

/**
 * A tapped link goes in an iframe only when the page allows muxpad to frame it;
 * every doubt sends it to the OS browser instead.
 */

const PARENT = 'https://example-host.example-tailnet.ts.net';
const h = (init: Record<string, string>) => new Headers(init);

describe('frameVerdict', () => {
  it('frames a page that says nothing about framing', () => {
    expect(frameVerdict(h({}), PARENT).frame).toBe(true);
  });

  it.each(['DENY', 'SAMEORIGIN', 'ALLOW-FROM https://x.example'])(
    'refuses X-Frame-Options %s',
    (xfo) => {
      expect(frameVerdict(h({ 'x-frame-options': xfo }), PARENT).frame).toBe(false);
    },
  );

  it.each([
    ["frame-ancestors 'none'", false],
    ["frame-ancestors 'self'", false],
    ['frame-ancestors https://other.example', false],
    ['frame-ancestors *', true],
    ['frame-ancestors https:', true],
    ['frame-ancestors http:', false],
    ['frame-ancestors *.example-tailnet.ts.net', true],
    ['frame-ancestors https://example-host.example-tailnet.ts.net', true],
    ['frame-ancestors https://example-host.example-tailnet.ts.net:8443', false],
    ["default-src 'self'; frame-ancestors 'self' *.ts.net", true],
  ] as const)('CSP "%s" → %s', (csp, frame) => {
    expect(frameVerdict(h({ 'content-security-policy': csp }), PARENT).frame).toBe(frame);
  });

  it('lets frame-ancestors override X-Frame-Options, as browsers do', () => {
    const headers = h({
      'x-frame-options': 'DENY',
      'content-security-policy': 'frame-ancestors *',
    });
    expect(frameVerdict(headers, PARENT).frame).toBe(true);
  });

  it('needs EVERY policy to allow it when several arrive', () => {
    const headers = h({
      'content-security-policy': "frame-ancestors *, frame-ancestors 'none'",
    });
    expect(frameVerdict(headers, PARENT).frame).toBe(false);
  });

  it('ignores a CSP that does not mention frame-ancestors', () => {
    expect(frameVerdict(h({ 'content-security-policy': "default-src 'self'" }), PARENT).frame).toBe(
      true,
    );
  });
});

describe('LinkFrameChecker', () => {
  const answer = (init: ResponseInit & { url?: string } = {}) => {
    const res = new Response('body', init);
    if (init.url) Object.defineProperty(res, 'url', { value: init.url });
    return res;
  };

  it('never frames http — mixed content — and never asks the network', async () => {
    const fetchImpl = vi.fn();
    const c = new LinkFrameChecker({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await c.check('http://example-host:4760', PARENT)).toMatchObject({ frame: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reads the headers of an https page', async () => {
    const fetchImpl = vi.fn(async () => answer({ headers: { 'x-frame-options': 'DENY' } }));
    const c = new LinkFrameChecker({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect((await c.check('https://news.example/a', PARENT)).frame).toBe(false);
  });

  it('says no on a timeout, an error, a failing status or a redirect down to http', async () => {
    const cases: Array<() => Promise<Response>> = [
      () => Promise.reject(new DOMException('timed out', 'TimeoutError')),
      async () => answer({ status: 503 }),
      async () => answer({ url: 'http://insecure.example/' }),
    ];
    for (const impl of cases) {
      const c = new LinkFrameChecker({ fetchImpl: vi.fn(impl) as unknown as typeof fetch });
      expect((await c.check('https://x.example/', PARENT)).frame).toBe(false);
    }
  });

  it('asks once per origin, until the answer goes stale', async () => {
    let t = 0;
    const fetchImpl = vi.fn(async () => answer());
    const c = new LinkFrameChecker({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      ttlMs: 1_000,
      now: () => t,
    });
    await c.check('https://x.example/one', PARENT);
    await c.check('https://x.example/two', PARENT);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    t = 2_000;
    expect((await c.check('https://x.example/three', PARENT)).frame).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
