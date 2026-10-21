import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SlackSetupGuide } from './SlackSetupGuide';
vi.mock('./SlackPasskeyApproval', () => ({
  SlackPasskeyApproval: ({ diagnosticID }: { diagnosticID: string }) => (
    <div data-diagnostic={diagnosticID}>Approval for setup test</div>
  ),
}));
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
let setup: Record<string, any>;
let result: Record<string, any>;
const op = '11111111-1111-4111-8111-111111111111';
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  setup = {
    checkedAt: Date.now(),
    platform: 'darwin',
    service: 'responding',
    version: 'v',
    expectedVersion: 'v',
    inline: true,
    registered: true,
    next: 'test',
    commands: [],
  };
  result = { state: 'pending' };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, options?: RequestInit) => {
      if (path.includes('/setup?')) return new Response(JSON.stringify(setup));
      if (path === '/api/slack/setup/test')
        return new Response(JSON.stringify({ testID: op, requestID: 'request' }), { status: 202 });
      if (path.includes('/setup/test/'))
        return new Response(JSON.stringify({ requestID: 'request', ...result }));
      throw Error('unknown');
    }),
  );
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const render = () => act(async () => root.render(<SlackSetupGuide active />));
const click = async (text: string) =>
  act(async () =>
    [...host.querySelectorAll('button')].find((b) => b.textContent === text)!.click(),
  );
it('service + enrollment are not presented as a live Slack success; only explicit test creates a request', async () => {
  await render();
  expect(host.textContent).toContain('Ready to test Slack');
  expect(host.textContent).not.toContain('Live Slack test passed');
  expect(vi.mocked(fetch).mock.calls.filter(([, o]) => o?.method === 'POST')).toHaveLength(0);
  await click('Test Slack');
  expect(host.querySelector('[data-diagnostic]')?.getAttribute('data-diagnostic')).toBe(op);
  expect(vi.mocked(fetch).mock.calls.filter(([, o]) => o?.method === 'POST')).toHaveLength(1);
});
it('read-only completion marks verified, removes approval surface, and reports when and what was tested', async () => {
  result = {
    state: 'complete',
    version: 'v',
    versionChanged: false,
    checkedAt: Date.now(),
    channelCount: 3,
  };
  await render();
  await click('Test Slack');
  expect(host.textContent).toContain('Slack verified');
  expect(host.textContent).not.toContain('Slack check failed');
  expect(host.textContent).toContain('Read-only Slack test passed');
  expect(host.querySelector('[data-diagnostic]')).toBeNull();
});
it.each(['failed', 'rejected', 'expired'])(
  'shows %s and enables explicit retry without automatic replay',
  async (state) => {
    result = { state, error: 'Slack request failed (missing_scope)' };
    await render();
    await click('Test Slack');
    expect(vi.mocked(fetch).mock.calls.filter(([, o]) => o?.method === 'POST')).toHaveLength(1);
    expect(
      [...host.querySelectorAll('button')].find((b) => b.textContent === 'Test Slack')?.disabled,
    ).toBe(false);
    expect(host.textContent).not.toContain('Slack verified');
  },
);
it('copies exactly the server-provided compatible Mac command and never executes it', async () => {
  setup = {
    ...setup,
    next: 'update',
    version: 'old',
    commands: [
      {
        id: 'update',
        kind: 'update',
        label: 'Update Slack service',
        command: 'exact reviewed command\n',
        sha256: 'checksum',
      },
    ],
  };
  await render();
  await click('Copy Mac command');
  expect(navigator.clipboard.writeText).toHaveBeenCalledWith('exact reviewed command\n');
  expect(host.textContent).toContain('Slack update available');
  expect(vi.mocked(fetch).mock.calls.filter(([, o]) => o?.method === 'POST')).toHaveLength(0);
  expect(
    [...host.querySelectorAll('button')].find((b) => b.textContent === 'Test Slack'),
  ).toBeUndefined();
});
it('unreachable guides recheck rather than claiming installation missing or asking to reset a passkey', async () => {
  setup = { ...setup, service: 'unreachable', version: null, registered: false, next: 'recheck' };
  await render();
  expect(host.textContent).toContain('Do not reinstall or reset a passkey');
  expect(host.textContent).not.toContain('Slack verified');
});
it('server version change invalidates test success and permits a new explicit test', async () => {
  result = { state: 'complete', version: 'other', versionChanged: true, checkedAt: Date.now() };
  await render();
  await click('Test Slack');
  expect(host.textContent).toContain('service changed');
  expect(host.textContent).not.toContain('Slack verified');
  expect(
    [...host.querySelectorAll('button')].find((b) => b.textContent === 'Test Slack')?.disabled,
  ).toBe(false);
});
it('does not poll or submit anything while Settings is inactive', async () => {
  await act(async () => root.render(<SlackSetupGuide active={false} />));
  expect(fetch).not.toHaveBeenCalled();
});
it('uncertain creation never shows verified, borrows another approval, or automatically submits again', async () => {
  vi.mocked(fetch).mockImplementation(
    async (path: any, options?: RequestInit) =>
      new Response(
        JSON.stringify(
          String(path).includes('/setup?')
            ? setup
            : options?.method === 'POST'
              ? { testID: op, requestID: null, state: 'uncertain' }
              : { state: 'uncertain', requestID: null, checkedAt: Date.now() },
        ),
        { status: options?.method === 'POST' ? 202 : 200 },
      ),
  );
  await render();
  await click('Test Slack');
  expect(host.textContent).toContain('could not be confirmed');
  expect(host.textContent).not.toContain('Slack verified');
  expect(host.querySelector('[data-diagnostic]')).toBeNull();
  expect(vi.mocked(fetch).mock.calls.filter(([, o]) => o?.method === 'POST')).toHaveLength(1);
});
it('new Slack account setup copies a user-scope-only app manifest, never takes a token in muxpad', async () => {
  setup = { ...setup, service: 'not-configured', registered: false, next: 'install' };
  await render();
  await click('Copy Slack app manifest');
  const raw = vi.mocked(navigator.clipboard.writeText).mock.calls[0]?.[0];
  const manifest = JSON.parse(raw as string);
  expect(manifest.oauth_config.scopes.user).toContain('files:write');
  expect(manifest.oauth_config.scopes.user).toContain('im:write');
  expect(manifest.oauth_config.scopes.bot).toBeUndefined();
  expect(host.querySelector('input')).toBeNull();
});

it('keeps technical connection details collapsed', async () => {
  await render();
  const details = [...host.querySelectorAll('details')].find(
    (d) => d.querySelector('summary')?.textContent === 'Connection details',
  );
  expect(details).toBeDefined();
  expect(details!.open).toBe(false);
  expect(host.querySelector('.settings-checklist')).toBeNull();
});
