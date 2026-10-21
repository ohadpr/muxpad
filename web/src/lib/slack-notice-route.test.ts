import { expect, it, vi } from 'vitest';
import { router } from '../router';
// Keep actual route definitions/validation; visual components are irrelevant here.
vi.mock('../components/AppLayout', () => ({ AppLayout: () => null }));
vi.mock('../components/WorkspaceLayout', () => ({ WorkspaceLayout: () => null }));
vi.mock('../pages/DocView', () => ({ DocView: () => null }));
vi.mock('../pages/HostedView', () => ({ HostedView: () => null, HostedAppView: () => null }));
vi.mock('../pages/PopoutView', () => ({ PopoutView: () => null }));
vi.mock('../pages/RootRedirect', () => ({ RootRedirect: () => null }));
const nonce = '11111111-1111-4111-8111-111111111111';
it('real chat route retains capture nonce through validated pane-search replacement', () => {
  const first = router
    .matchRoutes('/w/workspace/t/tab', { pane: 'target', slackNoticeCapture: nonce })
    .at(-1)!;
  expect(first.search).toMatchObject({ pane: 'target', slackNoticeCapture: nonce });
  const replacement = router
    .matchRoutes('/w/workspace/t/tab', { ...first.search, pane: 'other' })
    .at(-1)!;
  expect(replacement.search).toMatchObject({ pane: 'other', slackNoticeCapture: nonce });
  const invalid = router
    .matchRoutes('/w/workspace/t/tab', { pane: 'target', slackNoticeCapture: 'not-a-capture' })
    .at(-1)!;
  expect(invalid.search).toHaveProperty('slackNoticeCapture', undefined);
});
