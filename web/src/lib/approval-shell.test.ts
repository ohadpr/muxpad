import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';

const html = readFileSync(resolve(__dirname, '../../../broker/shell.html'), 'utf8');
const source = readFileSync(resolve(__dirname, '../../../broker/shell.js'), 'utf8').replace(
  "import { deviceClient } from './device-client.mjs';",
  "const deviceClient = { ensure: () => api('/human/session'), revoke: async () => api('/human/logout', {}) };",
);
const doms: JSDOM[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dom of doms.splice(0)) dom.window.close();
  vi.useRealTimers();
});
const request = (id = 'request-1') => ({
  id,
  fingerprint: `hash-${id}`,
  action: 'slack.post',
  payload: { channel: 'C123', text: '<script>window.attacked=true</script>' },
  expires: Date.now() + 300_000,
});

function sharedCoordination() {
  const entries = new Map<string, string>();
  let previous = Promise.resolve<unknown>(undefined);
  return {
    storage: {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => {
        entries.set(key, value);
      },
    },
    locks: {
      request: (_name: string, _options: unknown, work: () => unknown) => {
        const result = previous.then(work);
        previous = result.catch(() => undefined);
        return result;
      },
    },
  };
}
async function harness(
  options: {
    coordination?: ReturnType<typeof sharedCoordination>;
    id?: string;
    review?: boolean;
    node?: boolean;
  } = {},
) {
  // No browser launches or live network requests. Exercise the real protected
  // shell script in an isolated DOM; fetch and dialog APIs are controlled here.
  const dom = new JSDOM(html, { url: 'https://approve.example.test', runScripts: 'outside-only' });
  doms.push(dom);
  const win = dom.window;
  if (options.review) win.document.body.dataset.review = 'true';
  if (options.node) win.document.body.dataset.authMode = 'tailnet-peer';
  const coordination = options.coordination ?? sharedCoordination();
  Object.defineProperty(win, 'localStorage', { value: coordination.storage });
  Object.defineProperty(win.navigator, 'locks', { configurable: true, value: coordination.locks });
  let pending = [request(options.id)];
  let poll: (() => Promise<void>) | undefined;
  const delays: Array<() => void> = [];
  const permissions = win.document.getElementById('permissions') as unknown as HTMLDialogElement;
  permissions.showModal = () => {
    permissions.open = true;
  };
  permissions.close = () => {
    permissions.open = false;
  };
  const modal = win.document.getElementById('approval') as unknown as HTMLDialogElement;
  modal.showModal = () => {
    modal.open = true;
  };
  modal.close = () => {
    modal.open = false;
  };
  let outcome: 'complete' | 'failure' | 'warning' = 'complete';
  const closeWindow = vi.spyOn(win, 'close').mockImplementation(() => {});
  let sessionOffline = false;
  let sessionFailureData: Record<string, unknown> | undefined;
  let expired = false;
  let grants = [
    {
      id: 'grant-1',
      action: 'slack.all',
      // v2 — the scope the shell both SENDS on approval and matches when
      // deciding whether full-team access is already active. Left at v1 the
      // fixture described a grant the shell no longer recognises, so "once"
      // stopped warning that an existing grant survives it.
      permissionScope: 'slack-team-all-v2',
      teamID: 'T123',
      actions: ['slack.channels', 'slack.read', 'slack.search', 'slack.post', 'slack.unpost'],
      expires: Date.now() + 600_000,
    },
  ];
  const calls: Array<{ path: string; body?: Record<string, unknown> }> = [];
  Object.assign(win, {
    setInterval: (callback: () => Promise<void>) => {
      poll = callback;
      return 1;
    },
    setTimeout: (callback: () => void) => {
      delays.push(callback);
      return 1;
    },
    fetch: async (path: string, options?: RequestInit) => {
      const body = options?.body ? JSON.parse(String(options.body)) : undefined;
      calls.push({ path, ...(body ? { body } : {}) });
      if (path === '/human/session') {
        if (sessionOffline)
          throw Object.assign(Error('Temporary network outage'), { data: sessionFailureData });
        expired = false;
        return {
          ok: true,
          json: async () => ({
            csrf: 'paired-browser-csrf',
            expires: Date.now() + 3_600_000,
            config: { teamID: 'T123', muxpadURL: 'https://muxpad.example.test/' },
          }),
        };
      }
      if (['/human/pending', '/human/grants'].includes(path) && expired)
        return { ok: false, status: 401, json: async () => ({ error: 'expired' }) };
      if (path === '/human/pending')
        return { ok: true, json: async () => ({ requests: pending, grants }) };
      if (path === '/human/grants') return { ok: true, json: async () => ({ grants }) };
      if (path === '/human/grants/revoke') {
        grants = grants.filter((g) => body.id !== 'all' && g.id !== body.id);
        return { ok: true, json: async () => ({ grants }) };
      }
      if (path === '/human/decision') {
        if (outcome === 'failure') throw Error('Network lost after sending');
        pending = pending.filter((r) => r.id !== body.id);
        return {
          ok: true,
          json: async () => ({
            state: body.decision === 'reject' ? 'rejected' : 'complete',
            ...(outcome === 'warning' ? { grantWarning: 'Permission was not saved' } : {}),
          }),
        };
      }
      throw Error(`Unexpected endpoint ${path}`);
    },
  });
  win.eval(source);
  await vi.waitFor(() => {
    expect(modal.open).toBe(true);
    expect((win.document.getElementById('retry-connection') as HTMLButtonElement).hidden).toBe(
      true,
    );
  });
  return {
    closeWindow,
    warnDecision: () => {
      outcome = 'warning';
    },
    queuedTimers: () => delays.length,
    expireSession: () => {
      expired = true;
    },
    setSessionFailure: (data: Record<string, unknown>) => {
      sessionOffline = true;
      sessionFailureData = data;
    },
    setSessionOffline: (value: boolean) => {
      sessionOffline = value;
    },
    win,
    modal,
    calls,
    poll: async () => {
      await poll?.();
    },
    ready: () => {
      for (const callback of delays.splice(0)) callback();
    },
    setPending: (value: ReturnType<typeof request>[]) => {
      pending = value;
    },
    failDecision: () => {
      outcome = 'failure';
    },
    restoreDecision: () => {
      outcome = 'complete';
    },
    advance: (ms: number) => {
      const now = win.Date.now();
      win.Date.now = () => now + ms;
    },
  };
}

describe('protected muxpad approval modal', () => {
  it('standalone review opens the protected approval without loading the workspace', async () => {
    const f = await harness({ review: true });
    const frame = f.win.document.getElementById('muxpad') as HTMLIFrameElement;
    expect(frame.getAttribute('src')).toBeNull();
    expect(frame.hidden).toBe(true);
    expect(f.modal.open).toBe(true);
    f.ready();
    (f.win.document.getElementById('reject') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(f.modal.open).toBe(false));
    expect(f.win.document.getElementById('review-idle')?.hidden).toBe(false);
    expect(f.calls.find((c) => c.path === '/human/decision')?.body?.decision).toBe('reject');
  });

  it.each(['approve', 'reject'])(
    'closes standalone review only after confirmed %s and an empty queue',
    async (decision) => {
      const f = await harness({ review: true });
      f.ready();
      (f.win.document.getElementById(decision) as HTMLButtonElement).click();
      await vi.waitFor(() => expect(f.closeWindow).toHaveBeenCalledTimes(1));
      expect(f.calls.at(-1)?.path).toBe('/human/pending');
    },
  );

  it('keeps standalone review open for additional requests', async () => {
    const f = await harness({ review: true });
    f.setPending([request(), request('next')]);
    f.ready();
    (f.win.document.getElementById('approve') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(f.modal.open).toBe(false));
    expect(f.closeWindow).not.toHaveBeenCalled();
    f.advance(1000);
    await f.poll();
    expect(f.modal.open).toBe(true);
  });

  it.each(['warning', 'failure'])(
    'keeps %s visible even after polling removes the request',
    async (outcome) => {
      const f = await harness({ review: true });
      if (outcome === 'warning') f.warnDecision();
      else f.failDecision();
      f.ready();
      (f.win.document.getElementById('approve') as HTMLButtonElement).click();
      await vi.waitFor(() =>
        expect(f.win.document.getElementById('reject')?.textContent).toBe('Close'),
      );
      f.setPending([]);
      await f.poll();
      expect(f.modal.open).toBe(true);
      expect(f.closeWindow).not.toHaveBeenCalled();
    },
  );

  it('leaves a confirmed decision open when checking the remaining queue fails', async () => {
    const f = await harness({ review: true });
    const fetch = f.win.fetch;
    f.win.fetch = async (...args) => {
      if (args[0] === '/human/pending') throw Error('offline');
      return fetch(...args);
    };
    f.ready();
    (f.win.document.getElementById('approve') as HTMLButtonElement).click();
    await vi.waitFor(() =>
      expect(f.win.document.getElementById('connection')?.textContent).toContain('Could not check'),
    );
    expect(f.closeWindow).not.toHaveBeenCalled();
    expect(f.calls.filter((c) => c.path === '/human/decision')).toHaveLength(1);
  });

  it('discloses every field while presenting message text literally', async () => {
    const f = await harness();
    expect(f.win.document.getElementById('approval-title')?.textContent).toBe('Send message');
    expect(f.win.document.getElementById('message')?.textContent).toBe(request().payload.text);
    expect(f.win.document.querySelector('#payload dt')?.textContent).toBe('Channel');
    expect(f.win.document.querySelector('#payload dd')?.textContent).toBe('C123');
    expect(f.closeWindow).not.toHaveBeenCalled();
  });

  it('starts each new request at once and never silently repeats full-team permission', async () => {
    const f = await harness();
    f.setPending([request(), request('next')]);
    const select = f.win.document.getElementById('duration') as HTMLSelectElement;
    select.value = '1d';
    select.dispatchEvent(new f.win.Event('change'));
    expect(f.win.document.getElementById('grant-scope')?.textContent).toContain(
      'Full Slack access',
    );
    f.ready();
    (f.win.document.getElementById('approve') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(f.modal.open).toBe(false));
    expect(f.calls.find((c) => c.path === '/human/decision')?.body).toMatchObject({
      duration: '1d',
      scope: 'slack-team-all-v2',
    });
    f.advance(1000);
    await f.poll();
    expect(select.value).toBe('once');
    expect(f.win.document.getElementById('grant-scope')?.textContent).toContain(
      'choosing once does not revoke',
    );
  });

  it('keeps exact unknown payload fields visible and management secondary with local brand marks', async () => {
    const f = await harness();
    const detailed = {
      ...request('next'),
      payload: {
        ...request().payload,
        metadata: { exact: '<script>unsafe</script>' },
        thread_ts: '1.2',
      },
    };
    f.setPending([detailed]);
    await f.poll();
    f.advance(1000);
    await f.poll();
    expect(f.win.document.getElementById('payload')?.textContent).toContain('metadata');
    expect(f.win.document.getElementById('payload')?.textContent).toContain(
      '<script>unsafe</script>',
    );
    expect(f.win.document.querySelector('#payload script')).toBeNull();
    expect(
      f.win.document.getElementById('approval-permissions')?.closest('details'),
    ).not.toBeNull();
    expect(f.win.document.querySelectorAll('.brand-pair svg')).toHaveLength(2);
    expect(f.win.document.querySelector('.brand-pair')?.getAttribute('aria-label')).toBe(
      'muxpad connected to Slack',
    );
    expect(f.win.document.querySelector('svg image, svg use, img')).toBeNull();
  });

  it('renews after Permissions is the first endpoint to report expiry without replaying the operation', async () => {
    const f = await harness();
    f.ready();
    f.expireSession();
    (f.win.document.getElementById('permissions-button') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(f.queuedTimers()).toBeGreaterThan(0));
    expect((f.win.document.getElementById('retry-connection') as HTMLButtonElement).hidden).toBe(
      false,
    );
    const sessions = f.calls.filter((c) => c.path === '/human/session').length;
    f.ready();
    await vi.waitFor(() =>
      expect(f.calls.filter((c) => c.path === '/human/session').length).toBe(sessions + 1),
    );
    await vi.waitFor(() =>
      expect((f.win.document.getElementById('retry-connection') as HTMLButtonElement).hidden).toBe(
        true,
      ),
    );
    expect(f.calls.filter((c) => c.path === '/human/grants')).toHaveLength(1);
    expect(f.calls.filter((c) => c.path === '/human/decision')).toHaveLength(0);
  });

  it('recovers from repeated renewal outages without replaying a Slack decision', async () => {
    const f = await harness();
    f.expireSession();
    f.setSessionOffline(true);
    await f.poll();
    f.ready();
    await vi.waitFor(() =>
      expect(f.win.document.getElementById('connection')?.textContent).toContain(
        'Retrying connection',
      ),
    );
    const attempts = f.calls.filter((c) => c.path === '/human/session').length;
    f.ready();
    await vi.waitFor(() =>
      expect(f.calls.filter((c) => c.path === '/human/session').length).toBe(attempts + 1),
    );
    await vi.waitFor(() =>
      expect(f.win.document.getElementById('connection')?.textContent).toContain(
        'Retrying connection',
      ),
    );
    await vi.waitFor(() => expect(f.queuedTimers()).toBeGreaterThan(0));
    f.setSessionOffline(false);
    f.ready();
    await vi.waitFor(() =>
      expect((f.win.document.getElementById('retry-connection') as HTMLButtonElement).hidden).toBe(
        true,
      ),
    );
    expect(f.calls.filter((c) => c.path === '/human/decision')).toHaveLength(0);
    expect(f.calls.filter((c) => c.path === '/human/pair')).toHaveLength(0);
  });

  it('reconnects without navigating the existing workspace iframe', async () => {
    const f = await harness();
    const frame = f.win.document.getElementById('muxpad') as HTMLIFrameElement;
    const changes: MutationRecord[] = [];
    const observer = new f.win.MutationObserver((records) => changes.push(...records));
    observer.observe(frame, { attributes: true, attributeFilter: ['src'] });
    const sessions = f.calls.filter((c) => c.path === '/human/session').length;
    (f.win.document.getElementById('retry-connection') as HTMLButtonElement).click();
    await vi.waitFor(() =>
      expect(f.calls.filter((c) => c.path === '/human/session').length).toBe(sessions + 1),
    );
    await vi.waitFor(() =>
      expect((f.win.document.getElementById('retry-connection') as HTMLButtonElement).hidden).toBe(
        true,
      ),
    );
    expect([...changes, ...observer.takeRecords()]).toHaveLength(0);
    observer.disconnect();
  });

  it('opens automatically, escapes message content and approves the shown request with one click without a passkey ceremony', async () => {
    const f = await harness();
    expect(f.modal.open).toBe(true);
    expect(f.win.document.getElementById('message')?.textContent).toContain('<script>');
    expect(f.win.document.querySelector('#message script')).toBeNull();
    expect(f.win.document.getElementById('approve')?.textContent).toBe('Approve');
    expect(f.calls.some((c) => c.path === '/human/decision')).toBe(false);
    f.ready();
    (f.win.document.getElementById('approve') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(f.modal.open).toBe(false));
    const decisions = f.calls.filter((c) => c.path === '/human/decision');
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.body).toEqual({
      id: 'request-1',
      fingerprint: 'hash-request-1',
      decision: 'approve',
      duration: 'once',
    });
    expect(f.modal.open).toBe(false);
    expect(f.calls.some((c) => c.path.includes('/options'))).toBe(false);
  });

  it('does not replace the action underneath an open modal or approve a second queued action with a double click', async () => {
    const f = await harness();
    f.ready();
    f.setPending([request('request-1'), request('request-2')]);
    await f.poll();
    const button = f.win.document.getElementById('approve') as HTMLButtonElement;
    button.click();
    button.click();
    await vi.waitFor(() => expect(f.modal.open).toBe(false));
    expect(f.calls.filter((c) => c.path === '/human/decision')).toHaveLength(1);
    await f.poll();
    expect(f.modal.open).toBe(false);
  });

  it('ignores iframe postMessage attempts to authorize or swap an action', async () => {
    const f = await harness();
    f.win.dispatchEvent(
      new f.win.MessageEvent('message', {
        origin: 'https://muxpad.example.test',
        data: { approve: true, id: 'request-2' },
      }),
    );
    expect(f.calls.filter((c) => c.path === '/human/decision')).toHaveLength(0);
    expect(f.win.document.getElementById('payload')?.textContent).toContain('C123');
  });

  it('does not retry after an uncertain send or allow the Send button again', async () => {
    const f = await harness();
    f.ready();
    f.failDecision();
    const button = f.win.document.getElementById('approve') as HTMLButtonElement;
    button.click();
    await vi.waitFor(() =>
      expect(f.win.document.getElementById('decision-status')?.textContent).toContain(
        'No automatic retry',
      ),
    );
    expect(button.disabled).toBe(true);
    expect(f.win.document.getElementById('decision-status')?.textContent).toContain(
      'No automatic retry',
    );
    button.click();
    expect(f.calls.filter((c) => c.path === '/human/decision')).toHaveLength(1);
  });

  it('restores a real Reject handler when polling advances after a failed decision', async () => {
    const f = await harness();
    f.ready();
    f.failDecision();
    (f.win.document.getElementById('approve') as HTMLButtonElement).click();
    await vi.waitFor(() =>
      expect(f.win.document.getElementById('reject')?.textContent).toBe('Close'),
    );
    f.setPending([request('request-2')]);
    await f.poll();
    expect(f.modal.open).toBe(true);
    (f.win.document.getElementById('reject') as HTMLButtonElement).click();
    f.advance(1000);
    await f.poll();
    f.ready();
    f.restoreDecision();
    expect(f.modal.open).toBe(true);
    expect(f.win.document.getElementById('reject')?.textContent).toBe('Cancel');
    (f.win.document.getElementById('reject') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(f.modal.open).toBe(false));
    expect(f.calls.filter((c) => c.path === '/human/decision').at(-1)?.body).toMatchObject({
      id: 'request-2',
      decision: 'reject',
    });
  });

  it('does not redisplay an uncertain still-pending action after Close', async () => {
    const f = await harness();
    f.ready();
    f.failDecision();
    (f.win.document.getElementById('approve') as HTMLButtonElement).click();
    await vi.waitFor(() =>
      expect(f.win.document.getElementById('reject')?.textContent).toBe('Close'),
    );
    (f.win.document.getElementById('reject') as HTMLButtonElement).click();
    f.advance(1000);
    await f.poll();
    expect(f.modal.open).toBe(false);
    expect(f.calls.filter((c) => c.path === '/human/decision')).toHaveLength(1);
    expect(f.win.localStorage.getItem('muxpad-approval-attempts')).toContain('request-1');
  });

  it('atomically refuses another tab trying the same uncertain request even before its next poll', async () => {
    const coordination = sharedCoordination();
    const first = await harness({ coordination });
    const second = await harness({ coordination });
    first.ready();
    second.ready();
    first.failDecision();
    (first.win.document.getElementById('approve') as HTMLButtonElement).click();
    (second.win.document.getElementById('approve') as HTMLButtonElement).click();
    await vi.waitFor(() =>
      expect(second.win.document.getElementById('decision-status')?.textContent).toContain(
        'already attempted',
      ),
    );
    expect(first.calls.filter((c) => c.path === '/human/decision')).toHaveLength(1);
    expect(second.calls.filter((c) => c.path === '/human/decision')).toHaveLength(0);
  });

  it('disables an already-open modal when polling notices another tab attempted it', async () => {
    const coordination = sharedCoordination();
    const first = await harness({ coordination });
    const second = await harness({ coordination });
    first.ready();
    second.ready();
    first.failDecision();
    (first.win.document.getElementById('reject') as HTMLButtonElement).click();
    await vi.waitFor(() =>
      expect(first.win.document.getElementById('decision-status')?.textContent).toContain(
        'No automatic retry',
      ),
    );
    await second.poll();
    expect((second.win.document.getElementById('approve') as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(second.win.document.getElementById('decision-status')?.textContent).toContain(
      'another tab',
    );
    expect(second.calls.filter((c) => c.path === '/human/decision')).toHaveLength(0);
  });

  it('preserves both history entries when different tabs attempt different requests concurrently', async () => {
    const coordination = sharedCoordination();
    const first = await harness({ coordination, id: 'one' });
    const second = await harness({ coordination, id: 'two' });
    first.ready();
    second.ready();
    first.failDecision();
    second.failDecision();
    (first.win.document.getElementById('approve') as HTMLButtonElement).click();
    (second.win.document.getElementById('approve') as HTMLButtonElement).click();
    await vi.waitFor(() =>
      expect(second.win.document.getElementById('decision-status')?.textContent).toContain(
        'No automatic retry',
      ),
    );
    const history = JSON.parse(coordination.storage.getItem('muxpad-approval-attempts') || '[]');
    expect(history.map((entry: [string, number]) => entry[0]).sort()).toEqual(['one', 'two']);
  });

  it('fails closed without Web Locks instead of using a non-atomic storage fallback', async () => {
    const f = await harness();
    f.ready();
    Object.defineProperty(f.win.navigator, 'locks', { value: undefined });
    (f.win.document.getElementById('approve') as HTMLButtonElement).click();
    await vi.waitFor(() =>
      expect(f.win.document.getElementById('decision-status')?.textContent).toContain(
        'cannot safely coordinate',
      ),
    );
    expect(f.calls.filter((c) => c.path === '/human/decision')).toHaveLength(0);
  });

  it('offers finite durations, defaults to once and explicitly states full-team all-action scope', async () => {
    const f = await harness();
    const select = f.win.document.getElementById('duration') as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(['once', '10m', '1h', '1d']);
    expect(select.value).toBe('once');
    select.value = '10m';
    select.dispatchEvent(new f.win.Event('change'));
    expect(f.win.document.getElementById('approve')?.textContent).toBe('Approve');
    const scope = f.win.document.getElementById('grant-scope')?.textContent || '';
    expect(scope).toContain('ALL agents');
    expect(scope).toContain('Full Slack access');
    for (const action of [
      'list channels',
      'read history',
      'search',
      // The shell spells the capability out in full — "send, edit and delete
      // messages" — so the old 'send messages' / 'delete your messages'
      // substrings no longer appear anywhere in it.
      'send, edit and delete messages',
    ])
      expect(scope).toContain(action);
    expect(scope).toContain('Ends no later than');
    expect(scope).toContain('T123');
    expect(scope).toContain('all policy-permitted channels and searches');
    f.ready();
    (f.win.document.getElementById('approve') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(f.modal.open).toBe(false));
    expect(f.calls.filter((c) => c.path === '/human/decision')[0]?.body).toMatchObject({
      duration: '10m',
      scope: 'slack-team-all-v2',
      decision: 'approve',
    });
  });

  it('does not claim disconnection revokes existing timed permissions', async () => {
    const f = await harness();
    f.win.fetch = async () => {
      throw Error('offline');
    };
    await f.poll();
    expect(f.win.document.getElementById('connection')?.textContent).toContain(
      'Existing timed permissions may remain active',
    );
  });

  it('Reject never creates a timed permission even when a duration is selected', async () => {
    const f = await harness();
    f.ready();
    (f.win.document.getElementById('duration') as HTMLSelectElement).value = '1d';
    (f.win.document.getElementById('reject') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(f.modal.open).toBe(false));
    expect(f.calls.filter((c) => c.path === '/human/decision')[0]?.body).toMatchObject({
      duration: 'once',
      decision: 'reject',
    });
  });

  it('lists scoped permissions and revokes them through the human-only endpoint', async () => {
    const f = await harness();
    expect(f.modal.open).toBe(true);
    (f.win.document.getElementById('approval-permissions') as HTMLButtonElement).click();
    await vi.waitFor(() =>
      expect(f.win.document.getElementById('grant-list')?.textContent).toContain(
        'Full Slack access',
      ),
    );
    const revoke = f.win.document.querySelector('#grant-list button') as HTMLButtonElement;
    revoke.click();
    await vi.waitFor(() =>
      expect(f.win.document.getElementById('grant-list')?.textContent).toContain('No active'),
    );
    expect(f.calls.filter((c) => c.path === '/human/grants/revoke')[0]?.body).toEqual({
      id: 'grant-1',
    });
  });
});

describe('tailnet peer shell', () => {
  it('shows node management after automatic session and never exposes pairing on identity outage', async () => {
    const h = await harness({ review: true, node: true });
    expect(h.win.document.getElementById('revoke-device')?.hidden).toBe(false);
    expect(h.win.document.getElementById('sign-out')?.textContent).toBe('Sign out this browser');
    h.setSessionOffline(true);
    (h.win.document.getElementById('retry-connection') as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect(h.win.document.getElementById('node-access')?.hidden).toBe(false);
    });
    expect(h.win.document.getElementById('pairing')?.hidden).toBe(true);
    expect(h.win.document.getElementById('resume-access')?.hidden).toBe(true);
    expect(h.win.document.getElementById('node-access-status')?.textContent).toContain('Tailscale');
    expect(h.calls.some((c) => c.path === '/human/pair')).toBe(false);
  });
});

it('peer storage uncertainty gives reconciliation guidance without exposing browser pairing', async () => {
  const h = await harness({ review: true, node: true });
  h.setSessionFailure({ storageFault: true });
  (h.win.document.getElementById('retry-connection') as HTMLButtonElement).click();
  await vi.waitFor(() => {
    expect(h.win.document.getElementById('node-access-status')?.textContent).toContain('reconcile');
  });
  expect(h.win.document.getElementById('pairing')?.hidden).toBe(true);
  expect(h.win.document.getElementById('resume-access')?.hidden).toBe(true);
  expect(h.calls.some((c) => c.path === '/human/pair')).toBe(false);
});
