import { useEffect, useRef, useState } from 'react';
import { passkeyAPI, passkeyCeremony } from '../lib/slack-passkey';
import { SlackLogo } from './SlackLogo';
import { SlackSetupGuide } from './SlackSetupGuide';
export function SlackPasskeySettings({
  section = 'integrations',
  active: visible = true,
}: {
  section?: 'general' | 'notifications' | 'integrations';
  active?: boolean;
}) {
  const setupEpoch = useRef(0);
  const [status, setStatus] = useState<Record<string, any> | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [copied, setCopied] = useState(false);
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [receipt, setReceipt] = useState<Record<string, any> | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh explicitly restarts polling after a manual status check.
  useEffect(() => {
    if (!visible) {
      setSecret('');
      return;
    }
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const epoch = setupEpoch.current;
      try {
        const v = await passkeyAPI('status');
        if (active && epoch === setupEpoch.current) {
          setStatus(v);
          setUnreachable(false);
          setReceipt((current) =>
            current &&
            !v.registered &&
            (!v.candidate ||
              v.candidate.candidateID !== current.candidateID ||
              (typeof v.candidate.expires === 'number' &&
                v.candidate.expires <= (v.serverNow || Date.now())))
              ? null
              : current,
          );
        }
      } catch {
        if (active && epoch === setupEpoch.current) {
          setUnreachable(true);
          setStatus(null);
        }
        /* Setup never falls back to unauthenticated enrollment. */
      } finally {
        if (active) timer = setTimeout(() => void poll(), 5000);
      }
    };
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [refresh, visible]);
  const create = async () => {
    if (busy) return;
    setupEpoch.current++;
    const bootstrap = secret;
    setSecret('');
    setBusy(true);
    setError('');
    try {
      const options = await passkeyAPI('registration-options', { secret: bootstrap });
      const { localKeyFingerprint, ...response } = await passkeyCeremony(options, true);
      const result = await passkeyAPI('registration-verify', { response });
      const c = result.candidate;
      if (
        typeof localKeyFingerprint !== 'string' ||
        !c ||
        c.credentialID !== response.id ||
        c.fingerprint !== localKeyFingerprint ||
        c.rpID !== window.location.hostname ||
        c.origin !== window.location.origin
      )
        throw Error('Enrollment key mismatch');
      setupEpoch.current++;
      setReceipt(c);
      setStatus((v) => ({ ...v, ...result }));
    } catch {
      setError('Passkey setup did not complete. No approval authority was activated.');
    } finally {
      setBusy(false);
    }
  };
  const revoke = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const c = await passkeyAPI('management-options', { purpose: 'revoke-timed-permissions' });
      const response = await passkeyCeremony(c, false, { purpose: 'revoke-timed-permissions' });
      await passkeyAPI('management-verify', { ceremonyID: c.ceremonyID, response });
      setStatus(await passkeyAPI('status'));
    } catch {
      setError('Permission revocation was not confirmed. Check status; no automatic retry.');
    } finally {
      setBusy(false);
    }
  };
  const inline = status?.mode === 'passkey-inline';
  const ready = inline && status.registered;
  const pending = inline && !ready && (receipt || status.candidate);
  const label = unreachable
    ? 'Service unreachable'
    : !status
      ? 'Checking service…'
      : !inline
        ? 'Setup required'
        : ready
          ? 'Approval ready'
          : pending
            ? 'Confirmation pending'
            : 'Passkey setup required';
  const candidate = receipt;
  const confirmation = candidate
    ? Object.fromEntries(
        ['candidateID', 'credentialID', 'fingerprint', 'rpID', 'origin', 'generation'].map((k) => [
          k,
          candidate[k],
        ]),
      )
    : null;
  const passkey = (
    <div className="settings-passkey">
      {ready ? (
        <p>Approve each request with your passkey.</p>
      ) : candidate ? (
        <>
          <p>
            Passkey created, but not active. Finish the one-time trusted Mac confirmation for this
            exact key.
          </p>
          <p>
            Keep the Mac setup Terminal above open and paste the confirmation below into its prompt.
            Compare this browser’s receipt before confirming; creating a passkey alone does not
            grant approval authority.
          </p>
          {/* biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users need to scroll the long receipt horizontally. */}
          <pre tabIndex={0} aria-label="Locally verified setup confirmation">
            {JSON.stringify(confirmation, null, 2)}
          </pre>
          <button
            type="button"
            onClick={() => {
              void Promise.resolve()
                .then(() => navigator.clipboard.writeText(JSON.stringify(confirmation)))
                .then(() => setCopied(true))
                .catch(() =>
                  setError('Could not copy. Select and copy the setup confirmation above.'),
                );
            }}
          >
            {copied ? 'Confirmation copied' : 'Copy setup confirmation'}
          </button>
        </>
      ) : pending ? (
        <p>
          Setup is pending. Return to the window that created the passkey and use its exact, locally
          verified confirmation on the trusted Mac. Unverified relay status is not a trusted key
          confirmation. Do not start another enrollment.
        </p>
      ) : inline ? (
        <>
          <p>Get a one-time enrollment code from the host Mac, then save a passkey.</p>
          <p>Confirm the exact key on that Mac to activate approvals.</p>
          <label className="settings-enrollment">
            Enrollment code
            <input
              type="password"
              autoComplete="off"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
            />
          </label>
          <button
            type="button"
            disabled={busy || !secret || unreachable}
            onClick={() => void create()}
          >
            {busy ? 'Creating…' : 'Create passkey'}
          </button>
        </>
      ) : (
        <p>
          Passkey setup becomes available when the protected service reports passkey support.
          Complete the prerequisites in Integrations, then check status again.
        </p>
      )}
    </div>
  );
  return (
    <>
      <section hidden={section !== 'integrations'} aria-label="Slack integration">
        <div className="settings-card">
          <div className="settings-service">
            <SlackLogo />
            <div>
              <strong>Slack</strong>
            </div>
            {!ready && <output className="settings-badge">{label}</output>}
          </div>
          <SlackSetupGuide active={visible && section === 'integrations'} />
          {ready ? (
            <>
              <div className="settings-row settings-access">
                <div>
                  <strong>Access</strong>
                  {!Array.isArray(status.grants) ? (
                    <p>Timed permission status not reported by the service.</p>
                  ) : status.grants.length === 0 ? (
                    <p>Ask each time.</p>
                  ) : (
                    <ul>
                      {status.grants.map((grant: { id: string; expires: number }) => (
                        <li key={grant.id}>
                          Slack access · expires {new Date(grant.expires).toLocaleString()}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                {(!Array.isArray(status.grants) || status.grants.length > 0) && (
                  <button
                    type="button"
                    disabled={busy || unreachable}
                    onClick={() => void revoke()}
                  >
                    {busy ? 'Confirming…' : 'Revoke timed permissions'}
                  </button>
                )}
              </div>
              {Array.isArray(status?.grants) && status.grants.length > 0 && (
                <p className="settings-note">
                  Timed access covers all agents and supported Slack actions in this Slack
                  workspace.
                </p>
              )}
              <details className="settings-details">
                <summary>Connection &amp; passkey</summary>
                <dl>
                  <div>
                    <dt>Approval method</dt>
                    <dd>Passkey</dd>
                  </div>
                  <div>
                    <dt>Service</dt>
                    <dd>Responding</dd>
                  </div>
                  {status.teamID && (
                    <div>
                      <dt>Slack workspace</dt>
                      <dd>
                        <code>{status.teamID}</code>
                      </dd>
                    </div>
                  )}
                </dl>
                <p>Service status does not verify a live Slack connection.</p>
                <p>Approvals and revoking timed access require your passkey.</p>
                <p>
                  To replace a lost passkey, contact the host administrator. Confirm the replacement
                  key on the host Mac.
                </p>
                <button
                  type="button"
                  className="settings-text-button"
                  disabled={busy}
                  onClick={() => setRefresh((n) => n + 1)}
                >
                  Refresh status
                </button>
              </details>
            </>
          ) : (
            <>
              {unreachable && (
                <p>
                  The Slack service is offline or not installed. Ask the host administrator to check
                  it.
                </p>
              )}
              <button
                type="button"
                className="settings-text-button"
                disabled={busy}
                onClick={() => setRefresh((n) => n + 1)}
              >
                Refresh status
              </button>
              {inline && passkey}
            </>
          )}
        </div>
        <p className="settings-note">Slack requests in any workspace use this passkey.</p>
      </section>
      {section !== 'general' && error && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
