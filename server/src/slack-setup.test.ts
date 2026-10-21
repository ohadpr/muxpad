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
