import { describe, expect, it } from 'vitest';
import { type ExecFn, createTailscaleFunnel, localFunnel } from './funnel.js';

/** Fake exec — no funnel test may ever run a real tailscale command. */
function fakeExec(
  impl: (cmd: string, args: string[]) => { stdout: string },
): ExecFn & { calls: Array<{ cmd: string; args: string[] }> } {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const fn = (async (cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    return impl(cmd, args);
  }) as ExecFn & { calls: typeof calls };
  fn.calls = calls;
  return fn;
}

const STATUS_JSON = JSON.stringify({ Self: { DNSName: 'example-host.example-tailnet.ts.net.' } });

describe('createTailscaleFunnel', () => {
  it('runs funnel --bg then builds the base url from Self.DNSName', async () => {
    const exec = fakeExec((_cmd, args) =>
      args[0] === 'status' ? { stdout: STATUS_JSON } : { stdout: '' },
    );
    const funnel = createTailscaleFunnel({ publicPort: 7778, exec });
    const state = await funnel.ensure();
    expect(state).toEqual({ baseUrl: 'https://example-host.example-tailnet.ts.net:8443' });
    expect(exec.calls[0]).toEqual({
      cmd: 'tailscale',
      args: ['funnel', '--bg', '--https=8443', 'http://127.0.0.1:7778'],
    });
    expect(exec.calls[1]?.args).toEqual(['status', '--json']);
  });

  it('caches the base url — a second ensure() execs nothing', async () => {
    const exec = fakeExec((_cmd, args) =>
      args[0] === 'status' ? { stdout: STATUS_JSON } : { stdout: '' },
    );
    const funnel = createTailscaleFunnel({ publicPort: 7778, exec });
    await funnel.ensure();
    const before = exec.calls.length;
    await funnel.ensure();
    expect(exec.calls.length).toBe(before);
  });

  it('falls back to the app-bundle binary when PATH tailscale is missing', async () => {
    const exec = fakeExec((cmd, args) => {
      if (cmd === 'tailscale') {
        const err = new Error('spawn tailscale ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return args[0] === 'status' ? { stdout: STATUS_JSON } : { stdout: '' };
    });
    const funnel = createTailscaleFunnel({ publicPort: 7778, exec });
    const state = await funnel.ensure();
    expect(state.warning).toBeUndefined();
    expect(exec.calls[1]?.cmd).toBe('/Applications/Tailscale.app/Contents/MacOS/Tailscale');
    // Later calls stick with the binary that worked.
    expect(exec.calls.at(-1)?.cmd).toBe('/Applications/Tailscale.app/Contents/MacOS/Tailscale');
  });

  it('degrades to a local url + warning when tailscale errors', async () => {
    const exec = fakeExec(() => {
      throw new Error('Funnel not available; "funnel" node attribute not set');
    });
    const funnel = createTailscaleFunnel({ publicPort: 7778, exec });
    const state = await funnel.ensure();
    expect(state.baseUrl).toBe('http://127.0.0.1:7778');
    expect(state.warning).toContain('funnel unavailable');
    expect(state.warning).toContain('node attribute');
  });

  it('degrades when status has no DNSName', async () => {
    const exec = fakeExec((_cmd, args) =>
      args[0] === 'status' ? { stdout: '{"Self":{}}' } : { stdout: '' },
    );
    const funnel = createTailscaleFunnel({ publicPort: 9999, exec });
    const state = await funnel.ensure();
    expect(state.baseUrl).toBe('http://127.0.0.1:9999');
    expect(state.warning).toContain('DNSName');
  });
});

describe('localFunnel', () => {
  it('always answers locally with the given warning, no exec', async () => {
    const funnel = localFunnel(7778, 'funnel disabled (MUXPAD_NO_FUNNEL=1)');
    expect(await funnel.ensure()).toEqual({
      baseUrl: 'http://127.0.0.1:7778',
      warning: 'funnel disabled (MUXPAD_NO_FUNNEL=1)',
    });
  });
});
