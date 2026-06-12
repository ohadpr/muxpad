import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { isSelfHost, probeListening, toReachableUrl } from './host-identity.js';

/** Open a throwaway TCP server on a free port; returns {port, close}. */
function listenEphemeral(): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ port, close: () => server.close() });
    });
  });
}

describe('host-identity — probeListening', () => {
  let toClose: (() => void) | null = null;
  afterEach(() => {
    toClose?.();
    toClose = null;
  });

  it('returns true for a port that is actually listening', async () => {
    const { port, close } = await listenEphemeral();
    toClose = close;
    expect(await probeListening(port)).toBe(true);
  });

  it('returns false for a port nothing is listening on', async () => {
    // Grab then immediately release a port so we know it is free.
    const { port, close } = await listenEphemeral();
    close();
    expect(await probeListening(port, 200)).toBe(false);
  });

  it('returns false for an out-of-range port instead of throwing', async () => {
    expect(await probeListening(0)).toBe(false);
    expect(await probeListening(70000)).toBe(false);
  });
});

describe('host-identity — isSelfHost', () => {
  it('recognizes local host forms', async () => {
    expect(await isSelfHost('localhost')).toBe(true);
    expect(await isSelfHost('127.0.0.1')).toBe(true);
    expect(await isSelfHost('0.0.0.0')).toBe(true);
  });

  it('rejects an external host (the github-looking case)', async () => {
    expect(await isSelfHost('github.com')).toBe(false);
    expect(await isSelfHost('docs.anthropic.com')).toBe(false);
  });
});

describe('host-identity — toReachableUrl', () => {
  it('leaves a non-local URL unchanged', async () => {
    expect(await toReachableUrl('https://github.com/u/r')).toBe('https://github.com/u/r');
  });

  it('returns the original string for an unparseable URL', async () => {
    expect(await toReachableUrl('not a url')).toBe('not a url');
  });

  it('rewrites an all-interfaces host to loopback when not on a tailnet', async () => {
    // 0.0.0.0 is a valid bind address but won't load in a browser. Only
    // assert the swap when this machine isn't on a tailnet (otherwise the
    // result is the tailnet name, which is also fine but host-dependent).
    const out = await toReachableUrl('http://0.0.0.0:3000/');
    if (!out.includes('.ts.net')) {
      expect(out).toBe('http://127.0.0.1:3000/');
    }
  });
});
