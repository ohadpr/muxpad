import { deviceClient } from './device-client.mjs';
// This file is served from root-installed code by the protected broker, never
// by muxpad's mutable backend. There is deliberately no postMessage listener.
const $ = (id) => document.getElementById(id);
const nodeMode = document.body.dataset.authMode === 'tailnet-peer';
const reviewOnly = document.body.dataset.review === 'true';
let csrf = null;
let current = null;
let busy = false;
let retryAt = 0;
let sessionValid = false;
let polling = false;
let failed = false;
let readyAt = 0;
let config;
let sessionExpires = null;
let activePermissions = [];
let durableAccess = true;
let reconnectTimer = null;
let reconnectDelay = 1500;
let connecting = false;
let workspaceInitialized = false;
function scheduleReconnect() {
  if (reconnectTimer !== null) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void recoverConnection();
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, 30000);
}
async function recoverConnection() {
  if (connecting) return;
  connecting = true;
  $('retry-connection').hidden = false;
  try {
    await connect();
    reconnectDelay = 1500;
    $('retry-connection').hidden = sessionValid;
  } catch (error) {
    if (nodeMode) {
      $('pairing').hidden = true;
      $('node-access').hidden = false;
      $('node-access-status').textContent = error.data?.storageFault
        ? 'Approval storage is uncertain. Authority is disabled; an administrator must reconcile persisted state before restart.'
        : error.data?.resumeRequired
          ? 'Approvals are signed out on this device.'
          : 'This device cannot access approvals. Check Tailscale connectivity or ask the administrator to authorize this private device.';
      $('resume-access').hidden = !error.data?.resumeRequired;
      $('connection').textContent = 'Approval access unavailable';
      $('retry-connection').hidden = false;
      return;
    }
    $('retry-connection').hidden = false;
    if (!workspaceInitialized) $('pairing').hidden = false;
    $('connection').textContent =
      'Approval access unavailable. Retrying connection; pairing may be needed if browser credentials were lost or revoked.';
    scheduleReconnect();
  } finally {
    connecting = false;
  }
}
const HISTORY_KEY = 'muxpad-approval-attempts';
function attemptedRequests() {
  const entries = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
  if (!Array.isArray(entries) || entries.length > 500) throw Error('Invalid approval history');
  return entries.filter(
    (entry) =>
      Array.isArray(entry) &&
      typeof entry[0] === 'string' &&
      Number.isFinite(entry[1]) &&
      entry[1] > Date.now(),
  );
}
async function claimAttempt(request) {
  if (!navigator.locks?.request)
    throw Error('This browser cannot safely coordinate approvals across tabs');
  await navigator.locks.request(HISTORY_KEY, { mode: 'exclusive' }, () => {
    const history = new Map(attemptedRequests());
    if (history.has(request.id)) throw Error('This request was already attempted in another tab');
    // Use this device's clock for retention, not the server's wall clock.
    history.set(request.id, Date.now() + 10 * 60_000);
    // Every writer uses the same origin-scoped lock. A second tab can neither
    // claim the same ID nor overwrite a different tab's recorded attempt.
    localStorage.setItem(HISTORY_KEY, JSON.stringify([...history]));
  });
}
function markUncertain(message) {
  failed = true;
  setButtons(true);
  $('decision-status').textContent = `${message}. No automatic retry.`;
  $('reject').textContent = 'Close';
  $('reject').disabled = false;
}
function closeCurrent() {
  $('approval').close();
  current = null;
  $('review-idle').hidden = !reviewOnly;
  failed = false;
  retryAt = Date.now() + 900;
  $('reject').textContent = 'Cancel';
  setButtons(true);
}
async function api(path, body) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    cache: 'no-store',
    ...(body === undefined
      ? {}
      : {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-muxpad-csrf': csrf || '' },
          body: JSON.stringify(body),
        }),
  });
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401) {
      sessionValid = false;
      setButtons(true);
      $('retry-connection').hidden = false;
      scheduleReconnect();
    }
    throw Error(result.error || 'Approval service unavailable');
  }
  return result;
}
const setButtons = (disabled) => {
  $('approve').disabled = disabled;
  $('reject').disabled = disabled;
  $('duration').disabled = disabled;
};
function describeDuration() {
  if (!current) return;
  const duration = $('duration').value;
  const labels = { once: 'once', '10m': '10 min', '1h': '1 hour', '1d': '1 day' };
  $('approve').textContent = 'Approve';
  const existing = activePermissions.some(
    (grant) => grant.permissionScope === 'slack-team-all-v2' && grant.teamID === config.teamID,
  );
  const limits = { '10m': 600_000, '1h': 3_600_000, '1d': 86_400_000 };
  const deadline = Number.isFinite(sessionExpires)
    ? Math.min(Date.now() + limits[duration], sessionExpires)
    : null;
  $('grant-scope').textContent =
    duration === 'once'
      ? `This request only.${existing ? ' Full Slack access is already active for ALL agents in this team; choosing once does not revoke it. Manage access to revoke.' : ' Existing timed permissions, if any, stay active.'}`
      : `Full Slack access for ${labels[duration]}: ALL agents may list channels and users, open DMs, read history and threads, search, send, edit and delete messages, react and upload files in team ${config.teamID}, across all policy-permitted channels and searches without further approval. Different message text and search queries are allowed. Protected broker policy still applies. ${deadline ? `Ends no later than ${new Date(deadline).toLocaleString()}. ` : ''}Ends sooner on session expiry, sign-out or broker restart. Revoke under Manage access.`;
}
$('duration').onchange = describeDuration;
$('close-window').onclick = () => window.close();
function show(request) {
  current = request;
  $('review-idle').hidden = true;
  failed = false;
  readyAt = Date.now() + 650;
  $('team').textContent = config.teamID;
  const titles = {
    'slack.post': 'Send message',
    'slack.unpost': 'Delete message',
    'slack.read': 'Read history',
    'slack.search': 'Search messages',
    'slack.channels': 'List channels',
  };
  $('approval-title').textContent = titles[request.action] || 'Approve Slack action';
  const { text, ...details } = request.payload;
  const message = $('message');
  message.hidden = typeof text !== 'string';
  message.textContent = typeof text === 'string' ? text : '';
  // Every payload field remains visible, including unknown/future fields.
  const payload = $('payload');
  payload.replaceChildren();
  const fields = typeof text === 'string' ? details : request.payload;
  const labels = {
    channel: 'Channel',
    ts: 'Message timestamp',
    query: 'Exact search',
    limit: 'Result limit',
    oldest: 'Since',
  };
  for (const [key, value] of Object.entries(fields)) {
    const term = document.createElement('dt');
    term.textContent = labels[key] || key;
    const definition = document.createElement('dd');
    definition.textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    payload.append(term, definition);
  }
  $('expiry').textContent = `Expires ${new Date(request.expires).toLocaleTimeString()}`;
  $('decision-status').textContent = '';
  $('reject').textContent = 'Cancel';
  $('duration').value = 'once';
  describeDuration();
  setButtons(true);
  $('approval').showModal();
  // Do not make a new request actionable underneath an earlier tap/double click.
  setTimeout(() => {
    if (current?.id === request.id && sessionValid && !busy && !failed) {
      try {
        if (new Map(attemptedRequests()).has(request.id))
          markUncertain('This request was attempted in another tab');
        else setButtons(false);
      } catch {
        markUncertain('Approval history unavailable');
      }
    }
  }, 650);
}
async function refresh() {
  if (!sessionValid || busy || polling || Date.now() < retryAt) return;
  polling = true;
  try {
    const { requests, grants = [] } = await api('/human/pending');
    activePermissions = grants;
    $('permissions-button').textContent = `Permissions (${grants.length})`;
    if (current) describeDuration();
    if (busy || Date.now() < retryAt) return;
    $('connection').textContent = durableAccess
      ? 'Slack approvals ready'
      : 'Browser access works, but could not be remembered';
    if (current) {
      // Never swap the action beneath an open modal. External completion or
      // expiry closes it and enforces a pause before showing anything else.
      if (!requests.some((r) => r.id === current.id && r.fingerprint === current.fingerprint)) {
        if (!failed) closeCurrent();
      } else if (!failed) {
        if (new Map(attemptedRequests()).has(current.id))
          markUncertain('This request was attempted in another tab');
        else if (Date.now() >= readyAt) setButtons(false);
      }
      return;
    }
    const attempted = new Set(attemptedRequests().map(([id]) => id));
    const next = requests.find((request) => !attempted.has(request.id));
    if (next && !$('permissions').open) show(next);
  } catch {
    setButtons(true);
    $('connection').textContent = sessionValid
      ? 'Approval connection lost. Existing timed permissions may remain active; revocation is unconfirmed.'
      : 'Approval session expired — administrator must pair your device again';
  } finally {
    polling = false;
    if (!sessionValid) scheduleReconnect();
  }
}
async function decide(decision) {
  if (!current || busy || !sessionValid || $('approve').disabled) return;
  busy = true;
  setButtons(true);
  const shown = current;
  const duration = decision === 'approve' ? $('duration').value : 'once';
  try {
    await claimAttempt(shown);
    const result = await api('/human/decision', {
      id: shown.id,
      fingerprint: shown.fingerprint,
      decision,
      duration,
      ...(duration !== 'once' ? { scope: 'slack-team-all-v2' } : {}),
    });
    if (!['complete', 'rejected'].includes(result.state)) throw Error(result.error || result.state);
    if (result.grantWarning) {
      markUncertain(`Action ${result.state}. ${result.grantWarning}`);
      return;
    }
    closeCurrent();
    if (reviewOnly) {
      // A confirmed write alone is insufficient: keep the window for every
      // additional pending action (including attempts made in another tab).
      // A failed read must also leave a useful, open fallback.
      try {
        const { requests } = await api('/human/pending');
        if (!Array.isArray(requests)) throw Error('Invalid pending response');
        if (requests.length === 0 && !$('permissions').open) {
          $('review-idle').querySelector('p').textContent =
            'Decision confirmed. You can close this window.';
          window.close();
        }
      } catch {
        $('connection').textContent =
          'Decision confirmed. Could not check for more requests; keep this window open.';
      }
    }
  } catch (error) {
    // An uncertain write is never retried. Close only after showing its status;
    // the user must inspect Slack rather than click Send again.
    markUncertain(error.message);
  } finally {
    busy = false;
  }
}
window.addEventListener('storage', (event) => {
  if (event.key !== HISTORY_KEY || !current || busy || failed) return;
  try {
    if (new Map(attemptedRequests()).has(current.id))
      markUncertain('This request was attempted in another tab');
  } catch {
    markUncertain('Approval history unavailable');
  }
});
$('approval').addEventListener('cancel', (event) => event.preventDefault());
$('approve').onclick = () => decide('approve');
$('reject').onclick = () => {
  if (failed) closeCurrent();
  else decide('reject');
};
async function connect() {
  const session = await deviceClient.ensure();
  csrf = session.csrf;
  durableAccess = session.durable !== false;
  config = session.config;
  sessionExpires = session.expires;
  sessionValid = true;
  // Config is protected administrator data; agent messages cannot set this URL.
  if (!reviewOnly && !workspaceInitialized) {
    $('muxpad').src = config.muxpadURL;
    workspaceInitialized = true;
  }
  $('muxpad').hidden = reviewOnly;
  $('review-idle').hidden = !reviewOnly;
  $('pairing').hidden = true;
  if (nodeMode) {
    $('node-access').hidden = true;
    $('sign-out').textContent = 'Sign out this browser';
    $('revoke-device').hidden = false;
  }
  $('session-management').hidden = false;
  $('sign-out').hidden = false;
  $('permissions-button').hidden = false;
  $('pair-status').textContent = session.durable
    ? ''
    : 'This browser could not save lasting access. Keep its browser data; recovery may be needed later.';
  await refresh();
}
if (nodeMode) {
  $('resume-access').onclick = async () => {
    $('resume-access').disabled = true;
    try {
      await deviceClient.resume();
      await recoverConnection();
    } catch {
      $('node-access-status').textContent = 'Could not resume approvals. Try again explicitly.';
    } finally {
      $('resume-access').disabled = false;
    }
  };
  $('revoke-device').onclick = async () => {
    try {
      await deviceClient.revokeNode();
      location.reload();
    } catch (error) {
      $('connection').textContent = error.data?.storageFault
        ? 'Device access disabled here; persistence uncertain. Administrator reconciliation required before restart.'
        : 'Device revocation could not be confirmed';
    }
  };
}
$('pair-form').onsubmit = async (event) => {
  event.preventDefault();
  const secret = $('pair-secret').value;
  $('pair-secret').value = '';
  const button = $('pair-form').querySelector('button');
  button.disabled = true;
  try {
    await api('/human/pair', { secret });
    await connect();
  } catch {
    $('pair-status').textContent =
      'Pairing failed. Check the secret or ask the administrator to reset pairing.';
  } finally {
    button.disabled = false;
  }
};
$('sign-out').onclick = async () => {
  try {
    await deviceClient.revoke();
    sessionValid = false;
    csrf = null;
    location.reload();
  } catch (error) {
    $('connection').textContent = error.data?.storageFault
      ? 'Access disabled here; persistence uncertain. Administrator reconciliation required before restart.'
      : 'Could not revoke this session; check the connection';
  }
};
$('retry-connection').onclick = () => {
  if (reconnectTimer !== null) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  void recoverConnection();
};
void recoverConnection();
setInterval(refresh, 1500);

async function renderPermissions() {
  const { grants } = await api('/human/grants');
  const list = $('grant-list');
  list.replaceChildren();
  activePermissions = grants;
  if (current) describeDuration();
  $('permissions-button').textContent = `Permissions (${grants.length})`;
  if (!grants.length) list.textContent = 'No active timed permissions.';
  for (const grant of grants) {
    const row = document.createElement('div');
    row.className = 'grant-row';
    const description = document.createElement('p');
    description.textContent = `Full Slack access · team ${grant.teamID} · ALL agents · list channels and users, open DMs, read history and threads, search, send, edit and delete messages, react and upload files · until ${new Date(grant.expires).toLocaleString()}. Protected broker policy applies. Revoking this permission does not revoke other listed permissions.`;
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Revoke';
    button.onclick = async () => {
      button.disabled = true;
      try {
        await api('/human/grants/revoke', { id: grant.id });
        await renderPermissions();
      } catch {
        $('permissions-status').textContent = 'Could not confirm revocation. Check the connection.';
        button.disabled = false;
      }
    };
    row.append(description, button);
    list.append(row);
  }
}
$('permissions-button').onclick = async () => {
  $('permissions-status').textContent = '';
  $('permissions').showModal();
  try {
    await renderPermissions();
  } catch {
    $('permissions-status').textContent = 'Could not load permissions. Check the connection.';
  }
};
$('permissions-close').onclick = () => $('permissions').close();
$('revoke-all').onclick = async () => {
  $('revoke-all').disabled = true;
  try {
    await api('/human/grants/revoke', { id: 'all' });
    await renderPermissions();
  } catch {
    $('permissions-status').textContent = 'Could not confirm revocation. Check the connection.';
  } finally {
    $('revoke-all').disabled = false;
  }
};

$('approval-permissions').onclick = () => $('permissions-button').onclick();
