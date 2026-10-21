import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { passkeyAPI, passkeyCeremony } from '../lib/slack-passkey';
import { SlackPasskeyApproval } from './SlackPasskeyApproval';
import { SlackPasskeySettings } from './SlackPasskeySettings';
vi.mock('../lib/slack-passkey', () => ({ passkeyAPI: vi.fn(), passkeyCeremony: vi.fn() }));
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const request = {
  id: 'request-a',
  fingerprint: 'immutable-a',
  action: 'slack.post',
  teamID: 'T1',
  state: 'pending',
  expires: Date.now() + 300000,
  payload: { channel: 'C123', text: '<img src=x onerror=evil()>', metadata: { keep: 'exact' } },
};
let pending: (typeof request)[];
let result: Record<string, unknown>;
let modeStatus: Record<string, unknown>;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: {
      configurable: true,
      value: function () {
        this.open = true;
      },
    },
    close: {
      configurable: true,
      value: function () {
        this.open = false;
      },
    },
  });
  pending = [request];
  result = { ...request, state: 'complete' };
  modeStatus = {
    mode: 'passkey-inline',
    registered: true,
    serverNow: Date.now(),
    sessionExpires: Date.now() + 86400000,
    grants: [],
  };
  vi.mocked(passkeyAPI).mockImplementation(async (path) => {
    if (path.startsWith('pending?'))
      return { pane: 'pane-a', requests: pending, more: false, status: modeStatus };
    if (path === 'options' || path === 'management-options')
      return { ceremonyID: 'one-use', options: { challenge: 'public' } };
    if (path === 'decision') {
      pending = [];
      return result;
    }
    if (path === 'registration-options') return { challenge: 'register' };
    if (path === 'registration-verify')
      return {
        registered: false,
        candidate: {
          candidateID: 'candidate',
          credentialID: 'signed',
          fingerprint: 'keyhash',
          rpID: window.location.hostname,
          origin: window.location.origin,
          generation: 'generation',
        },
      };
    return modeStatus;
  });
  vi.mocked(passkeyCeremony).mockImplementation(async (_raw, registration) => ({
    id: 'signed',
    rawId: 'signed',
    type: 'public-key',
    response: {},
    clientExtensionResults: {},
    ...(registration ? { localKeyFingerprint: 'keyhash' } : {}),
  }));
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
const render = () => act(async () => root.render(<SlackPasskeyApproval paneId="pane-a" />));
const click = async (text: string) =>
  act(async () => {
    [...host.querySelectorAll('button')].find((b) => b.textContent === text)!.click();
  });
it('opens automatically only when mounted by active pane, discloses exact payload, asks passkey only on gesture and closes after matching confirmed empty snapshot', async () => {
  await render();
  const dialog = host.querySelector('dialog')!;
  expect(dialog.open).toBe(true);
  expect(host.textContent).toContain(request.payload.text);
  expect(host.textContent).toContain('metadata');
  expect(host.textContent).toContain('exact');
  expect(host.querySelector('img')).toBeNull();
  expect(passkeyCeremony).not.toHaveBeenCalled();
  await click('Approve');
  expect(passkeyCeremony).toHaveBeenCalledTimes(1);
  expect(passkeyAPI).toHaveBeenCalledWith('options', {
    id: request.id,
    fingerprint: request.fingerprint,
    decision: 'approve',
    duration: 'once',
  });
  expect(dialog.open).toBe(false);
});
it('timed selection visibly discloses ALL agents/read/search/send/delete and binds literal scope; next queued request remains open and resets once', async () => {
  await render();
  const select = host.querySelector('select')!;
  await act(async () => {
    select.value = '1h';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(host.textContent).toContain('All agents can read, search, send, edit, delete');
  expect(host.querySelector('details')!.open).toBe(false);
  const next = {
    ...request,
    id: 'request-b',
    fingerprint: 'immutable-b',
    payload: { ...request.payload, text: 'next action' },
  };
  vi.mocked(passkeyAPI).mockImplementation(async (path) =>
    path === 'options'
      ? { ceremonyID: 'one-use', options: {} }
      : path === 'decision'
        ? result
        : { pane: 'pane-a', requests: [next], more: false, status: modeStatus },
  );
  await click('Approve');
  expect(passkeyAPI).toHaveBeenCalledWith(
    'options',
    expect.objectContaining({ duration: '1h', scope: 'slack-team-all-v2' }),
  );
  expect(host.querySelector('dialog')!.open).toBe(true);
  expect(host.textContent).toContain('next action');
  expect(host.querySelector('select')!.value).toBe('once');
});
it.each([
  { state: 'failed' },
  { state: 'expired' },
  { state: 'complete', grantWarning: 'expired owner' },
])('confirmed terminal outcome closes and never retries: %j', async (outcome) => {
  result = { ...result, ...outcome };
  await render();
  await click('Approve');
  expect(host.querySelector('dialog')!.open).toBe(false);
  expect(host.querySelector('output.slack-passkey-inline')?.textContent).toBeTruthy();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(4000);
  });
  expect(vi.mocked(passkeyAPI).mock.calls.filter(([p]) => p === 'decision')).toHaveLength(1);
});
it('mismatched outcome closes but stays unresolved inline and never resubmits a decision', async () => {
  const api = vi.mocked(passkeyAPI).getMockImplementation()!;
  vi.mocked(passkeyAPI).mockImplementation(async (path, body) => {
    if (path === 'decision') return { ...result, id: 'other-request' };
    return api(path, body);
  });
  await render();
  await click('Approve');
  expect(host.querySelector('dialog')!.open).toBe(false);
  expect(host.textContent).toContain('Mismatched decision');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(4000);
  });
  expect(vi.mocked(passkeyAPI).mock.calls.filter(([p]) => p === 'decision')).toHaveLength(1);
});
it('confirmed terminal result closes even when subsequent pending refresh fails', async () => {
  const api = vi.mocked(passkeyAPI).getMockImplementation()!;
  let decided = false;
  vi.mocked(passkeyAPI).mockImplementation(async (path, body) => {
    if (decided && path.startsWith('pending?')) throw Error('network');
    const value = await api(path, body);
    if (path === 'decision') decided = true;
    return value;
  });
  await render();
  await click('Approve');
  expect(host.querySelector('dialog')!.open).toBe(false);
  expect(host.textContent).not.toContain('network');
});
it('a fresh empty pending snapshot retires a request completed elsewhere', async () => {
  await render();
  pending = [];
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(host.querySelector('dialog')!.open).toBe(false);
  expect(passkeyCeremony).not.toHaveBeenCalled();
});
it('Deny is signed reject/once, not mere dismiss', async () => {
  result = { ...request, state: 'rejected' };
  await render();
  await click('Deny');
  expect(passkeyAPI).toHaveBeenCalledWith(
    'options',
    expect.objectContaining({ decision: 'reject', duration: 'once' }),
  );
  expect(passkeyCeremony).toHaveBeenCalledTimes(1);
  expect(host.querySelector('dialog')!.open).toBe(false);
});
it('unmount while browser prompt waits cannot submit a late decision', async () => {
  let release!: (v: Awaited<ReturnType<typeof passkeyCeremony>>) => void;
  vi.mocked(passkeyCeremony).mockImplementation(
    () =>
      new Promise((r) => {
        release = r;
      }),
  );
  await render();
  await click('Approve');
  await act(async () => root.render(<div />));
  release({
    id: 'signed',
    rawId: 'signed',
    type: 'public-key',
    response: {},
    clientExtensionResults: {},
  });
  await act(async () => {
    await Promise.resolve();
  });
  expect(vi.mocked(passkeyAPI).mock.calls.some(([p]) => p === 'decision')).toBe(false);
});
it('Settings creates only pending candidate and exposes exact confirmation; never calls admin or claims authority', async () => {
  modeStatus = { mode: 'passkey-inline', registered: false };
  await act(async () => root.render(<SlackPasskeySettings />));
  const input = host.querySelector('input')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      input,
      'one-use-code',
    );
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await click('Create passkey');
  expect(passkeyCeremony).toHaveBeenCalledWith({ challenge: 'register' }, true);
  expect(host.textContent).toContain('not active');
  expect(host.textContent).toContain('keyhash');
  expect(
    vi.mocked(passkeyAPI).mock.calls.some(([p]) => p.includes('confirm') || p.includes('admin')),
  ).toBe(false);
});

it('uncertain decision can be dismissed without retry and reviewed in this chat', async () => {
  const api = vi.mocked(passkeyAPI).getMockImplementation()!;
  vi.mocked(passkeyAPI).mockImplementation(async (path, body) => {
    if (path === 'decision') throw Error('Connection lost');
    return api(path, body);
  });
  await render();
  await click('Approve');
  await click('Close');
  expect(host.querySelector('dialog')!.open).toBe(false);
  expect(host.textContent).toContain('Review');
  await click('Review');
  expect(host.querySelector('dialog')!.open).toBe(true);
  expect(vi.mocked(passkeyAPI).mock.calls.filter(([p]) => p === 'decision')).toHaveLength(1);
});

it('never offers an unverified candidate from relay status as trusted root confirmation', async () => {
  modeStatus = {
    mode: 'passkey-inline',
    registered: false,
    candidate: { candidateID: 'rogue', credentialID: 'signed', fingerprint: 'untrusted' },
  };
  await act(async () => root.render(<SlackPasskeySettings />));
  expect(host.textContent).toContain('Unverified relay status');
  expect(host.textContent).not.toContain('Copy setup confirmation');
  expect(passkeyCeremony).not.toHaveBeenCalled();
});
it('rejects enrollment key substitution even when relay uses same credential ID', async () => {
  modeStatus = { mode: 'passkey-inline', registered: false };
  vi.mocked(passkeyCeremony).mockResolvedValue({
    id: 'signed',
    rawId: 'signed',
    type: 'public-key',
    response: {},
    clientExtensionResults: {},
    localKeyFingerprint: 'DIFFERENT',
  });
  await act(async () => root.render(<SlackPasskeySettings />));
  const input = host.querySelector('input')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'code');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await click('Create passkey');
  expect(host.textContent).toContain('No approval authority');
  expect(host.textContent).not.toContain('Copy setup confirmation');
});

it('discards an older poll throughout timed options and signing without changing displayed intent', async () => {
  type Pending = {
    pane: string;
    requests: typeof pending;
    more: boolean;
    status: typeof modeStatus;
  };
  let releasePoll!: (v: Pending) => void;
  let releaseOptions!: (v: Record<string, unknown>) => void;
  let polls = 0;
  vi.mocked(passkeyAPI).mockImplementation(async (path) => {
    if (path.startsWith('pending?')) {
      if (++polls === 1)
        return { pane: 'pane-a', requests: [request], more: false, status: modeStatus };
      return new Promise<Pending>((resolve) => {
        releasePoll = resolve;
      });
    }
    if (path === 'options')
      return new Promise((resolve) => {
        releaseOptions = resolve;
      });
    if (path === 'decision') return { ...request, state: 'failed' };
    return modeStatus;
  });
  await render();
  await act(async () => {
    const select = host.querySelector('select')!;
    select.value = '1h';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.advanceTimersByTimeAsync(2000);
  });
  await click('Approve');
  await act(async () =>
    releasePoll({
      pane: 'pane-a',
      requests: [
        {
          ...request,
          id: 'request-b',
          payload: { ...request.payload, text: 'DIFFERENT REQUEST B' },
        },
      ],
      more: false,
      status: modeStatus,
    }),
  );
  expect(host.textContent).toContain(request.payload.text);
  expect(host.textContent).not.toContain('DIFFERENT REQUEST B');
  expect(host.querySelector('select')!.value).toBe('1h');
  await act(async () => releaseOptions({ ceremonyID: 'one-use', options: {} }));
  expect(passkeyCeremony).toHaveBeenCalledWith(
    expect.anything(),
    false,
    expect.objectContaining({ requestID: request.id, duration: '1h', payload: request.payload }),
  );
  expect(host.querySelector('dialog')!.open).toBe(false);
});

it('shows a compact generic access prompt with optional exact request details', async () => {
  await render();
  expect(host.querySelector('h2')!.textContent).toBe('muxpad wants to access Slack');
  expect(host.querySelector('details')!.open).toBe(false);
  expect([...host.querySelectorAll('dialog button')].map((b) => b.textContent)).toEqual([
    'Deny',
    'Approve',
  ]);
  expect(host.textContent).not.toContain('Choose 1Password');
  expect(host.querySelector('details')!.textContent).toContain(request.payload.text);
});

it('closes immediately after passkey returns while single signed submission is still pending', async () => {
  const api = vi.mocked(passkeyAPI).getMockImplementation()!;
  let finish!: (value: Record<string, unknown>) => void;
  vi.mocked(passkeyAPI).mockImplementation(async (path, body) => {
    if (path === 'decision')
      return new Promise((resolve) => {
        finish = resolve;
      });
    return api(path, body);
  });
  await render();
  await click('Approve');
  expect(host.querySelector('dialog')!.open).toBe(false);
  expect(host.textContent).toContain('Finishing Slack approval');
  expect([...host.querySelectorAll('.slack-passkey-inline button')]).toHaveLength(0);
  expect(vi.mocked(passkeyAPI).mock.calls.filter(([path]) => path === 'decision')).toHaveLength(1);
  await act(async () => {
    pending = [];
    finish(result);
  });
  expect(host.querySelector('dialog')!.open).toBe(false);
  expect(host.textContent).not.toContain('Finishing Slack approval');
});
it('uncertain submission after passkey stays closed with inline error and no automatic resend', async () => {
  const api = vi.mocked(passkeyAPI).getMockImplementation()!;
  vi.mocked(passkeyAPI).mockImplementation(async (path, body) => {
    if (path === 'decision') throw Error('Approval submission unavailable');
    return api(path, body);
  });
  await render();
  await click('Approve');
  expect(host.querySelector('dialog')!.open).toBe(false);
  expect(host.querySelector('.slack-passkey-inline')!.textContent).toContain(
    'Approval submission unavailable',
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(4000);
  });
  expect(vi.mocked(passkeyAPI).mock.calls.filter(([path]) => path === 'decision')).toHaveLength(1);
});

it('offers same-chat secure navigation for an HTTP origin error without signing or submitting', async () => {
  vi.mocked(passkeyCeremony).mockRejectedValue(
    Object.assign(Error('Open secure muxpad'), {
      secureURL: 'https://muxpad.test/w/work/t/chat?pane=p',
    }),
  );
  await render();
  await click('Approve');
  expect(host.querySelector('a')?.getAttribute('href')).toBe(
    'https://muxpad.test/w/work/t/chat?pane=p',
  );
  expect(vi.mocked(passkeyAPI).mock.calls.some(([path]) => path === 'decision')).toBe(false);
});
it('Settings diagnostic uses its own pending scope and the same signed, auto-closing approval', async () => {
  const diagnosticID = '11111111-1111-4111-8111-111111111111';
  const pane = `setup-${diagnosticID}`;
  const diagnostic = { ...request, action: 'slack.channels', payload: {} };
  let waiting = true;
  vi.mocked(passkeyAPI).mockImplementation(async (path) => {
    if (path === `../setup/test/${diagnosticID}/pending`)
      return { pane, requests: waiting ? [diagnostic] : [], more: false, status: modeStatus };
    if (path === 'options') return { ceremonyID: 'c', options: { challenge: 'public' } };
    if (path === 'decision') {
      waiting = false;
      return { ...diagnostic, state: 'complete' };
    }
    return modeStatus;
  });
  await act(async () =>
    root.render(<SlackPasskeyApproval paneId={pane} diagnosticID={diagnosticID} />),
  );
  expect(host.querySelector('dialog')?.open).toBe(true);
  expect(passkeyCeremony).not.toHaveBeenCalled();
  await click('Approve');
  expect(host.querySelector('dialog')?.open).toBe(false);
  expect(passkeyCeremony).toHaveBeenCalledWith(
    expect.anything(),
    false,
    expect.objectContaining({
      action: 'slack.channels',
      payload: {},
      requestID: request.id,
      decision: 'approve',
      duration: 'once',
    }),
  );
  expect(vi.mocked(passkeyAPI).mock.calls.some(([p]) => p.startsWith('pending?pane='))).toBe(false);
});

it('Deny closes before authentication and stays closed when authentication is cancelled', async () => {
  let cancel!: (reason: Error) => void;
  vi.mocked(passkeyCeremony).mockImplementation(
    () =>
      new Promise((_resolve, reject) => {
        cancel = reject;
      }),
  );
  await render();
  await click('Deny');
  expect(host.querySelector('dialog')!.open).toBe(false);
  await act(async () => {
    cancel(new Error('Confirmation cancelled'));
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(4000);
  });
  expect(host.querySelector('dialog')!.open).toBe(false);
  expect(vi.mocked(passkeyAPI).mock.calls.some(([path]) => path === 'decision')).toBe(false);
});
it('confirmed Deny never reopens the same request from a stale pending snapshot', async () => {
  const api = vi.mocked(passkeyAPI).getMockImplementation()!;
  vi.mocked(passkeyAPI).mockImplementation(async (path, body) => {
    if (path === 'decision') return { ...request, state: 'rejected' };
    return api(path, body);
  });
  await render();
  await click('Deny');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(6000);
  });
  expect(host.querySelector('dialog')!.open).toBe(false);
  expect(passkeyCeremony).toHaveBeenCalledTimes(1);
});
