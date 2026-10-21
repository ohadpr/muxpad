/** Temporary advisory evidence only: no content, credentials or approval authority. */
type Poll = {
  state: 'never' | 'in-flight' | 'failed' | 'success';
  http: number | null;
  pending: number | null;
  stale: boolean | null;
  at: number;
};
const polls = new Map<string, Poll>();
export function noticeCaptureNonce(value: unknown): string | undefined {
  return typeof value === 'string' &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
    ? value
    : undefined;
}
export function mountApprovalPoll(pane: string) {
  const value: Poll = {
    state: 'never',
    http: null,
    pending: null,
    stale: null,
    at: Date.now(),
  };
  if (polls.size >= 64) polls.delete(polls.keys().next().value!);
  polls.set(pane, value);
  return {
    start() {
      value.state = 'in-flight';
      value.at = Date.now();
    },
    success(http: number, pending: number, stale: boolean) {
      Object.assign(value, {
        state: 'success',
        http,
        pending,
        stale,
        at: Date.now(),
      });
    },
    fail(http: number) {
      Object.assign(value, { state: 'failed', http, at: Date.now() });
    },
    unmount() {
      if (polls.get(pane) === value) polls.delete(pane);
    },
  };
}
const bounded = (n: number, min = 0, max = 100000) =>
  Math.max(min, Math.min(max, Math.round(Number.isFinite(n) ? n : 0)));
function box(e: Element | null) {
  if (!e) return null;
  const r = e.getBoundingClientRect();
  return {
    x: bounded(r.x, -100000),
    y: bounded(r.y, -100000),
    w: bounded(r.width),
    h: bounded(r.height),
  };
}
export function collectNoticeEvidence(pane: string) {
  // Compare values, never interpolate a caller-supplied pane into a selector.
  const shells = [...document.querySelectorAll<HTMLElement>('[data-slack-shell-pane]')]
    .filter((e) => e.dataset.slackShellPane === pane)
    .slice(0, 64);
  const chats = [...document.querySelectorAll<HTMLElement>('[data-slack-chat-pane]')]
    .filter((e) => e.dataset.slackChatPane === pane)
    .slice(0, 64);
  const alerts = [...document.querySelectorAll<HTMLElement>('[data-slack-alert-pane]')]
    .filter((e) => e.dataset.slackAlertPane === pane)
    .slice(0, 64);
  const shell = shells.find((e) => e.dataset.slackActive === 'true') ?? shells[0];
  const chat = chats.find((e) => e.dataset.slackActive === 'true') ?? chats[0];
  const alert = alerts[0] ?? null;
  let ancestorHidden = false;
  let ancestorDisplayNone = false;
  let ancestorVisibilityHidden = false;
  for (
    let e: Element | null = alert ?? chat ?? shell ?? null, i = 0;
    e && i < 32;
    e = e.parentElement, i++
  ) {
    const style = getComputedStyle(e);
    ancestorHidden ||= e.hasAttribute('hidden');
    ancestorDisplayNone ||= style.display === 'none';
    ancestorVisibilityHidden ||= style.visibility === 'hidden' || style.visibility === 'collapse';
  }
  const r = alert?.getBoundingClientRect();
  const alertInViewport =
    !!r &&
    r.width > 0 &&
    r.height > 0 &&
    r.bottom > 0 &&
    r.right > 0 &&
    r.top < innerHeight &&
    r.left < innerWidth;
  const hit =
    alertInViewport && r && document.elementFromPoint
      ? document.elementFromPoint(
          Math.max(0, Math.min(innerWidth - 1, r.left + r.width / 2)),
          Math.max(0, Math.min(innerHeight - 1, r.top + r.height / 2)),
        )
      : null;
  const value = polls.get(pane);
  const asset = [...document.scripts]
    .map((s) => s.getAttribute('src') ?? '')
    .map((s) => s.match(/^\/assets\/(index-[A-Za-z0-9_-]{1,80}\.js)$/)?.[1])
    .find(Boolean);
  const face = shell?.dataset.slackFace;
  return {
    build:
      asset ??
      ([...document.scripts].some((s) => s.getAttribute('src') === '/src/main.tsx')
        ? 'dev'
        : 'unknown'),
    visibility: document.visibilityState === 'hidden' ? 'hidden' : 'visible',
    viewportW: bounded(innerWidth),
    viewportH: bounded(innerHeight),
    shells: shells.length,
    shellActive: shell ? shell.dataset.slackActive === 'true' : null,
    face: face === 'chat' || face === 'web' || face === 'terminal' ? face : null,
    chats: chats.length,
    chatActive: chat ? chat.dataset.slackActive === 'true' : null,
    hasSession: chat ? chat.dataset.slackSession === 'true' : null,
    alerts: alerts.length,
    shellRect: box(shell ?? null),
    chatRect: box(chat ?? null),
    visualViewport: window.visualViewport
      ? {
          x: bounded(window.visualViewport.offsetLeft, -100000),
          y: bounded(window.visualViewport.offsetTop, -100000),
          w: bounded(window.visualViewport.width),
          h: bounded(window.visualViewport.height),
        }
      : null,
    alertRect: box(alert),
    composerRect: box(chat?.querySelector('.chat-composer-wrap') ?? null),
    ancestorHidden,
    ancestorDisplayNone,
    ancestorVisibilityHidden,
    alertInViewport,
    alertHitTest: hit ? !!alert?.contains(hit) : null,
    poll: value
      ? {
          state: value.state,
          http: value.http,
          pending: value.pending,
          stale: value.stale,
          ageMs: bounded(Date.now() - value.at, 0, 600000),
        }
      : {
          state: 'absent' as const,
          http: null,
          pending: null,
          stale: null,
          ageMs: null,
        },
  };
}
export function startNoticeDiagnostic() {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  let controller: AbortController | null = null;
  let nonce = '';
  let retired = '';
  let sent = 0;
  const optIn = () => {
    const values = new URLSearchParams(window.location.search).getAll('slackNoticeCapture');
    return values.length === 1 ? (noticeCaptureNonce(values[0]) ?? '') : '';
  };
  let client: string;
  try {
    // getRandomValues also works on ordinary HTTP LAN origins; randomUUID may not.
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6]! & 15) | 64;
    b[8] = (b[8]! & 63) | 128;
    const h = [...b].map((n) => n.toString(16).padStart(2, '0')).join('');
    client = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  } catch {
    return () => {};
  }
  const request = async (url: string, init?: RequestInit) => {
    controller = new AbortController();
    const timeout = setTimeout(() => controller?.abort(), 3000);
    try {
      const r = await fetch(url, {
        ...init,
        cache: 'no-store',
        signal: controller.signal,
      });
      const data = await r.json();
      return { ok: r.ok, status: r.status, data };
    } finally {
      clearTimeout(timeout);
    }
  };
  const run = async () => {
    try {
      const requested = optIn();
      if (!requested || requested === retired) return;
      if (requested === nonce && sent >= 20) {
        retired = requested;
        return;
      }
      const config = (await request('/api/slack/notice-diagnostic')).data;
      if (stopped || optIn() !== requested) return;
      if (!config.enabled || config.nonce !== requested) {
        retired = requested;
        nonce = '';
        sent = 0;
        return;
      }
      if (
        typeof config.nonce !== 'string' ||
        typeof config.pane !== 'string' ||
        !(config.remainingMs > 0 && config.remainingMs <= 300000)
      )
        return;
      if (nonce !== config.nonce) {
        nonce = config.nonce;
        sent = 0;
      }
      if (sent >= 20) {
        retired = requested;
        return;
      }
      const deadline = Date.now() + config.remainingMs;
      // This independent GET NEVER records an alert poll; absent stays absent.
      const evidence = collectNoticeEvidence(config.pane);
      let server: {
        state: 'success' | 'failed' | 'mismatch';
        http: number;
        pending: number | null;
      } = { state: 'failed', http: 0, pending: null };
      try {
        const r = await request(`/api/slack/approvals?pane=${encodeURIComponent(config.pane)}`);
        server.http = r.status;
        const v = r.ok ? r.data : null;
        if (
          r.ok &&
          v?.pane === config.pane &&
          Number.isSafeInteger(v.pending) &&
          v.pending >= 0 &&
          v.pending <= 64
        )
          server = { state: 'success', http: r.status, pending: v.pending };
        else if (r.ok) server.state = 'mismatch';
      } catch {
        /* Fixed failure only; never capture exception text. */
      }
      if (stopped || optIn() !== requested || Date.now() >= deadline) return;
      // Confirm arm nonce after the await; disarm/target change cannot reuse it.
      const latest = (await request('/api/slack/notice-diagnostic')).data;
      if (
        stopped ||
        optIn() !== requested ||
        !latest.enabled ||
        latest.nonce !== nonce ||
        latest.pane !== config.pane ||
        Date.now() >= deadline
      )
        return;
      sent++;
      await request('/api/slack/notice-diagnostic/report', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          nonce,
          pane: config.pane,
          client,
          sample: { ...evidence, server },
        }),
      });
    } catch {
      /* Diagnostic failure cannot affect application or authority. */
    } finally {
      if (!stopped) timer = setTimeout(() => void run(), 5000);
    }
  };
  void run();
  return () => {
    stopped = true;
    clearTimeout(timer);
    controller?.abort();
  };
}
