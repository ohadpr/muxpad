import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { slackBrokerRequest, slackBrokerURL } from './slack-broker.js';
import { SLACK_VERSION, slackSetupStatus } from './slack-setup.js';
vi.mock('./slack-broker.js', () => ({
  slackBrokerRequest: vi.fn(),
  slackBrokerURL: vi.fn(() => 'https://broker.test'),
}));
afterEach(() => vi.resetAllMocks());
it.each([
  ['old', false, 'update'],
  [SLACK_VERSION, false, 'enroll'],
  [SLACK_VERSION, true, 'test'],
])(
  'distinguishes version %s and enrolled=%s without claiming live Slack success',
  async (version, registered, next) => {
    vi.mocked(slackBrokerURL).mockReturnValue('https://broker.test');
    vi.mocked(slackBrokerRequest).mockImplementation(async (p) =>
      p === '/health' ? { version } : { mode: 'passkey-inline', registered, teamID: 'T1' },
    );
    const r = await slackSetupStatus('https://app.test', []);
    expect(r.next).toBe(next);
    expect(r.liveSlackVerified).toBe(false);
    expect(r.checkedAt).toBeGreaterThan(0);
  },
);
it('unreachable does not invent an installation failure or claim token/passkey status', async () => {
  vi.mocked(slackBrokerURL).mockReturnValue('https://broker.test');
  vi.mocked(slackBrokerRequest).mockRejectedValue(Error('raw-secret'));
  const r = await slackSetupStatus('https://app.test', []);
  expect(r.next).toBe('recheck');
  expect(r.service).toBe('unreachable');
  expect(JSON.stringify(r)).not.toContain('raw-secret');
  expect(r.registered).toBe(false);
});
it('absent configuration guides initial install and never contacts Slack', async () => {
  vi.mocked(slackBrokerURL).mockReturnValue(null);
  const r = await slackSetupStatus('https://app.test', []);
  expect(r.next).toBe('install');
  expect(slackBrokerRequest).not.toHaveBeenCalled();
});
it('offers only exact-origin/exact-predecessor compatible update command', async () => {
  vi.mocked(slackBrokerURL).mockReturnValue('https://broker.test');
  vi.mocked(slackBrokerRequest).mockImplementation(async (p) =>
    p === '/health' ? { version: 'old' } : { mode: 'passkey-inline', registered: true },
  );
  const release = {
    id: 'update',
    kind: 'update' as const,
    label: 'Update',
    command: 'exact',
    sha256: 'hash',
    origin: 'https://app.test',
    fromVersion: 'old',
  };
  expect((await slackSetupStatus('https://app.test', [release])).commands).toHaveLength(1);
  expect((await slackSetupStatus('https://other.test', [release])).commands).toHaveLength(0);
});

it('the Settings test declares the machine it runs on, so the policy applies', async () => {
  // It used to send no origin, so it reached the broker as `unknown` — a
  // Slack request from the mini that connectors.json never saw. It is
  // muxpad's own test, running on the server, so it is `local`; under a
  // trayo-only policy it is now refused here, which is the correct answer
  // rather than a regression.
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), 'routes', 'slack-setup.ts'),
    'utf8',
  );
  const call = src.slice(src.indexOf("action: 'slack.channels'"));
  expect(call.slice(0, 200)).toMatch(/origin: LOCAL_NODE_ID/);
});
