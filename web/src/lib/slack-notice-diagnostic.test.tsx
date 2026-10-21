import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { SlackNoticeDiagnostic } from '../components/SlackNoticeDiagnostic';
import {
  collectNoticeEvidence,
  mountApprovalPoll,
  startNoticeDiagnostic,
} from './slack-notice-diagnostic';
const nonce = '11111111-1111-4111-8111-111111111111';
let stop: (() => void) | undefined;
afterEach(() => {
  stop?.();
  stop = undefined;
  document.body.innerHTML = '';
  window.history.replaceState({}, '', '/');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const response = (data: unknown, status = 200) => ({
  ok: status === 200,
  status,
  json: async () => data,
});
function transport() {
  window.history.replaceState({}, '', `/?slackNoticeCapture=${nonce}`);
  vi.useFakeTimers();
  let config: Record<string, unknown> = {
    enabled: true,
    pane: 'target',
    nonce,
    remainingMs: 300000,
  };
  const reports: Record<string, any>[] = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/report')) {
      reports.push(JSON.parse(String(init?.body)));
      return response({ accepted: true });
    }
    if (url.includes('/approvals?')) return response({ pane: 'target', pending: 1 });
    return response(config);
  });
  vi.stubGlobal('fetch', fetch);
  return {
    fetch,
    reports,
    setConfig(v: Record<string, unknown>) {
      config = v;
    },
  };
}
const flush = async () => {
  for (let n = 0; n < 20; n++) await Promise.resolve();
};
it('root sibling reports never-mounted pane/alert with separate successful server GET, no fake UI or Slack calls', async () => {
  const t = transport();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<SlackNoticeDiagnostic />));
  await flush();
  expect(t.reports).toHaveLength(1);
  expect(t.reports[0]!.sample).toMatchObject({
    shells: 0,
    chats: 0,
    alerts: 0,
    poll: { state: 'absent' },
    server: { state: 'success', pending: 1 },
  });
  expect(collectNoticeEvidence('target').poll.state).toBe('absent');
  expect(document.querySelector('.slack-approval-alert')).toBeNull();
  expect(
    t.fetch.mock.calls.every(
      ([u]) =>
        u.startsWith('/api/slack/notice-diagnostic') || u.startsWith('/api/slack/approvals?'),
    ),
  ).toBe(true);
  await act(async () => root.unmount());
  const n = t.fetch.mock.calls.length;
  await vi.advanceTimersByTimeAsync(10000);
  expect(t.fetch).toHaveBeenCalledTimes(n);
});
it('collects only target inactive flags and hidden ancestors, no content/attribute leakage', () => {
  document.body.innerHTML =
    '<div hidden><div data-slack-shell-pane="target" data-slack-active="false" data-slack-face="chat"><div data-slack-chat-pane="target" data-slack-active="false" data-slack-session="true"><div class="chat-composer-wrap"><output data-slack-alert-pane="target" data-secret="TOKEN">SECRET CHAT</output></div></div></div></div><div data-slack-chat-pane="other"></div>';
  const v = collectNoticeEvidence('target');
  expect(v).toMatchObject({
    shells: 1,
    shellActive: false,
    chats: 1,
    chatActive: false,
    hasSession: true,
    alerts: 1,
    ancestorHidden: true,
    ancestorDisplayNone: true,
  });
  expect(JSON.stringify(v)).not.toMatch(/TOKEN|SECRET CHAT|data-secret|other/);
});
it('records actual alert lifecycle separately and clears it on unmount', () => {
  const p = mountApprovalPoll('target');
  expect(collectNoticeEvidence('target').poll.state).toBe('never');
  p.start();
  expect(collectNoticeEvidence('target').poll.state).toBe('in-flight');
  p.fail(503);
  expect(collectNoticeEvidence('target').poll).toMatchObject({
    state: 'failed',
    http: 503,
  });
  p.success(200, 1, false);
  expect(collectNoticeEvidence('target').poll).toMatchObject({
    state: 'success',
    pending: 1,
  });
  p.unmount();
  expect(collectNoticeEvidence('target').poll.state).toBe('absent');
});
it('does not submit a late sample after disarm/target change while scoped GET awaits', async () => {
  const t = transport();
  let release!: (v: ReturnType<typeof response>) => void;
  t.fetch.mockImplementation(async (url: string) =>
    url.includes('/approvals?')
      ? await new Promise((r) => {
          release = r;
        })
      : response({ enabled: true, pane: 'target', nonce, remainingMs: 300000 }),
  );
  stop = startNoticeDiagnostic();
  await flush();
  t.fetch.mockImplementation(async () => response({ enabled: false }));
  release(response({ pane: 'target', pending: 1 }));
  await flush();
  expect(t.fetch.mock.calls.some(([u]) => u.endsWith('/report'))).toBe(false);
});
it('stops and aborts outstanding requests with no late report', async () => {
  const t = transport();
  let signal: AbortSignal | undefined;
  t.fetch.mockImplementation(async (_url: string, init?: RequestInit) => {
    signal = init?.signal as AbortSignal;
    return await new Promise(() => {});
  });
  stop = startNoticeDiagnostic();
  await flush();
  stop();
  expect(signal?.aborted).toBe(true);
  await vi.advanceTimersByTimeAsync(10000);
  expect(t.fetch).toHaveBeenCalledTimes(1);
});
it('per-jar sample count stays bounded and then stops network calls', async () => {
  const t = transport();
  stop = startNoticeDiagnostic();
  await flush();
  expect(t.reports).toHaveLength(1);
  for (let n = 0; n < 25; n++) await vi.advanceTimersByTimeAsync(5000);
  expect(t.reports).toHaveLength(20);
});
it('bounds response-body hangs and starts no overlapping diagnostic call', async () => {
  const t = transport();
  t.fetch.mockImplementation(async (_url: string, init?: RequestInit) => ({
    ok: true,
    status: 200,
    json: () =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(Error('PRIVATE EXCEPTION')));
      }),
  }));
  stop = startNoticeDiagnostic();
  await flush();
  expect(t.fetch).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(2999);
  expect(t.fetch).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(t.fetch).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(5000);
  expect(t.fetch).toHaveBeenCalledTimes(2);
  expect(t.reports).toHaveLength(0);
});
it('discards evidence when arm expires during independent status read', async () => {
  const t = transport();
  let release!: (v: ReturnType<typeof response>) => void;
  t.fetch.mockImplementation(async (url: string) =>
    url.includes('/approvals?')
      ? await new Promise((r) => {
          release = r;
        })
      : response({ enabled: true, pane: 'target', nonce, remainingMs: 1 }),
  );
  stop = startNoticeDiagnostic();
  await flush();
  await vi.advanceTimersByTimeAsync(2);
  release(response({ pane: 'target', pending: 1 }));
  await flush();
  expect(t.fetch.mock.calls.some(([u]) => u.endsWith('/report'))).toBe(false);
});

it('retains ancestor visibility evidence even when no notice ever mounts', () => {
  document.body.innerHTML =
    '<div style="display:none"><div data-slack-shell-pane="target" data-slack-active="false" data-slack-face="chat"><div data-slack-chat-pane="target" data-slack-active="false" data-slack-session="true"></div></div></div>';
  expect(collectNoticeEvidence('target')).toMatchObject({
    alerts: 0,
    ancestorDisplayNone: true,
    shellActive: false,
    chatActive: false,
  });
});

it('requires opt-in link query: unrelated clients emit no requests; SPA navigation can opt in', async () => {
  const t = transport();
  window.history.replaceState({}, '', '/');
  stop = startNoticeDiagnostic();
  await flush();
  await vi.advanceTimersByTimeAsync(10000);
  expect(t.fetch).not.toHaveBeenCalled();
  window.history.replaceState({}, '', `/?slackNoticeCapture=${nonce}`);
  await vi.advanceTimersByTimeAsync(5000);
  expect(t.reports).toHaveLength(1);
});
it('wrong or expired capture link stops, without any scopedGET or report', async () => {
  const t = transport();
  t.setConfig({ enabled: false });
  stop = startNoticeDiagnostic();
  await flush();
  await vi.advanceTimersByTimeAsync(20000);
  expect(t.fetch).toHaveBeenCalledTimes(1);
  expect(t.reports).toHaveLength(0);
});

it('rejects ambiguous duplicate opt-in query parameters without network', async () => {
  const t = transport();
  window.history.replaceState({}, '', `/?slackNoticeCapture=${nonce}&slackNoticeCapture=${nonce}`);
  stop = startNoticeDiagnostic();
  await flush();
  await vi.advanceTimersByTimeAsync(10000);
  expect(t.fetch).not.toHaveBeenCalled();
});
