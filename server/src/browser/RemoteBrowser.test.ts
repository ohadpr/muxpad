import { describe, expect, it } from 'vitest';
import { chooseBrowserEndpoint, readRemoteConfig, releaseRemoteBrowser } from './RemoteBrowser.js';

const file = (content: string | null) => () => {
  if (content === null) throw new Error('ENOENT');
  return content;
};

describe('opting in to a browser that is not on this Mac', () => {
  it('is OFF when there is no config — the existing path is untouched', () => {
    expect(readRemoteConfig('/data', file(null))).toBeNull();
  });

  it('reads a provider url', () => {
    expect(readRemoteConfig('/data', file('{"provider":"http://192.168.64.5:7900/"}'))).toEqual({
      provider: 'http://192.168.64.5:7900',
    });
  });

  it('treats a malformed or non-http config as absent, never as an error', () => {
    expect(readRemoteConfig('/data', file('not json'))).toBeNull();
    expect(readRemoteConfig('/data', file('{"provider":42}'))).toBeNull();
    expect(readRemoteConfig('/data', file('{"provider":"file:///etc/passwd"}'))).toBeNull();
  });
});

describe('choosing which browser to drive', () => {
  const config = { provider: 'http://vm:7900' };
  const fake =
    (answers: Record<string, () => Response | Promise<Response>>) =>
    async (input: string | URL | Request) => {
      const url = String(input);
      const hit = Object.entries(answers).find(([k]) => url.endsWith(k));
      if (!hit) throw new Error(`connect ECONNREFUSED ${url}`);
      return hit[1]();
    };

  it('is local, silently, when nobody opted in', async () => {
    expect(await chooseBrowserEndpoint({ config: null, profile: 's-1' })).toEqual({
      kind: 'local',
      reason: null,
    });
  });

  it('drives the remote browser when the provider and its CDP both answer', async () => {
    const fetchImpl = fake({
      '/browsers/s-1': () => Response.json({ cdp: 'http://vm:9301/' }),
      '/json/version': () => Response.json({ Browser: 'Chrome/140' }),
    }) as typeof fetch;
    expect(await chooseBrowserEndpoint({ config, profile: 's-1', fetchImpl })).toEqual({
      kind: 'remote',
      endpoint: 'http://vm:9301',
    });
  });

  it('FALLS BACK when the provider is down — a dead VM must not break browsing', async () => {
    const r = await chooseBrowserEndpoint({
      config,
      profile: 's-1',
      fetchImpl: fake({}) as typeof fetch,
    });
    expect(r.kind).toBe('local');
    expect(r.kind === 'local' && r.reason).toMatch(/provider unreachable/);
  });

  it('falls back when the provider says yes but the browser does not answer', async () => {
    const fetchImpl = fake({
      '/browsers/s-1': () => Response.json({ cdp: 'http://vm:9301' }),
    }) as typeof fetch;
    const r = await chooseBrowserEndpoint({ config, profile: 's-1', fetchImpl });
    expect(r.kind === 'local' && r.reason).toMatch(/remote CDP unreachable/);
  });

  it('falls back when the browser answers, but not as a browser', async () => {
    const fetchImpl = fake({
      '/browsers/s-1': () => Response.json({ cdp: 'http://vm:9301' }),
      '/json/version': () => new Response('not found', { status: 404 }),
    }) as typeof fetch;
    const r = await chooseBrowserEndpoint({ config, profile: 's-1', fetchImpl });
    expect(r.kind === 'local' && r.reason).toMatch(/remote CDP answered 404/);
  });

  it('falls back on a refusal or a nonsense answer', async () => {
    const refused = fake({ '/browsers/s-1': () => new Response('no', { status: 503 }) });
    expect(
      (await chooseBrowserEndpoint({ config, profile: 's-1', fetchImpl: refused as typeof fetch }))
        .kind,
    ).toBe('local');
    const junk = fake({ '/browsers/s-1': () => Response.json({ cdp: 'javascript:alert(1)' }) });
    expect(
      (await chooseBrowserEndpoint({ config, profile: 's-1', fetchImpl: junk as typeof fetch }))
        .kind,
    ).toBe('local');
  });

  it('falls back when the provider is too slow, rather than hanging the start', async () => {
    const slow = (async (_u: unknown, init?: RequestInit) =>
      new Promise((_, reject) =>
        init?.signal?.addEventListener('abort', () => reject(new Error('timed out'))),
      )) as typeof fetch;
    const r = await chooseBrowserEndpoint({
      config,
      profile: 's-1',
      fetchImpl: slow,
      timeoutMs: 30,
    });
    expect(r.kind).toBe('local');
  });

  it('asks for THIS profile — isolation is per session', async () => {
    const asked: string[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      asked.push(`${init?.method ?? 'GET'} ${String(input)}`);
      throw new Error('down');
    }) as typeof fetch;
    await chooseBrowserEndpoint({ config, profile: 's-01abc', fetchImpl });
    await releaseRemoteBrowser(config, 's-01abc', fetchImpl);
    expect(asked).toEqual([
      'POST http://vm:7900/browsers/s-01abc',
      'DELETE http://vm:7900/browsers/s-01abc',
    ]);
  });
});
