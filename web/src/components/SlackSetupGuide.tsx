import { useEffect, useRef, useState } from 'react';
import { SlackPasskeyApproval } from './SlackPasskeyApproval';
const SLACK_APP_MANIFEST = {
  display_information: { name: 'muxpad' },
  oauth_config: {
    scopes: {
      user: [
        'channels:read',
        'groups:read',
        'channels:history',
        'groups:history',
        'im:history',
        'mpim:history',
        'search:read',
        'chat:write',
        'users:read',
        'im:write',
        'reactions:write',
        'files:write',
      ],
    },
  },
};
type Command = { id: string; kind: string; label: string; command: string; sha256: string };
type Setup = {
  checkedAt: number;
  platform: string;
  service: string;
  version: string | null;
  expectedVersion: string;
  registered: boolean;
  inline: boolean;
  teamID: string | null;
  next: string;
  commands: Command[];
};
async function api(path = '', body?: unknown) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), body === undefined ? 8000 : 45000);
  try {
    const r = await fetch(`/api/slack/setup${path}`, {
      cache: 'no-store',
      signal: controller.signal,
      ...(body === undefined
        ? {}
        : {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          }),
    });
    if (r.status === 404 && path.startsWith('?origin='))
      return {
        checkedAt: Date.now(),
        platform: 'unknown',
        service: 'app-update',
        version: null,
        expectedVersion: 'pending',
        registered: false,
        inline: false,
        next: 'restart-app',
        commands: [
          {
            id: 'restart-app',
            kind: 'app',
            label: 'Activate setup checks',
            command: 'muxpad restart\n',
            sha256: '66d97263c88dae7a516c65f5cf20477924eb1d3942d0b3cf5520b3dcf8d41527',
          },
        ],
      };
    const v = await r.json();
    if (!r.ok) throw Error(typeof v.error === 'string' ? v.error : 'Setup check unavailable');
    return v;
  } finally {
    clearTimeout(timer);
  }
}
export function SlackSetupGuide({ active }: { active: boolean }) {
  const [setup, setSetup] = useState<Setup | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');
  const [test, setTest] = useState<{ testID: string; requestID: string | null } | null>(null);
  const [result, setResult] = useState<Record<string, any> | null>(null);
  const [resultRefresh, setResultRefresh] = useState(0);
  const [testError, setTestError] = useState('');
  const operation = useRef<string | null>(null);
  const alive = useRef(true);
  const request = useRef(0);
  const testIdentity = useRef<string | null>(null);
  const refresh = async () => {
    const epoch = ++request.current;
    setChecking(true);
    setError('');
    try {
      const v = await api(`?origin=${encodeURIComponent(window.location.origin)}`);
      if (alive.current && epoch === request.current) {
        setSetup(v);
      }
    } catch (e) {
      if (alive.current && epoch === request.current) {
        setError((e as Error).message);
        setSetup(null);
      }
    } finally {
      if (alive.current && epoch === request.current) setChecking(false);
    }
  };
  /* `active` is the whole trigger: this starts and stops the five-second poll
     as the panel opens and closes. `refresh` is redefined every render, so
     depending on it would clear and recreate the interval continuously. */
  // biome-ignore lint/correctness/useExhaustiveDependencies: deliberate — see above
  useEffect(() => {
    alive.current = active;
    if (!active) return;
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => {
      alive.current = false;
      request.current++;
      clearInterval(timer);
    };
  }, [active]);
  /* `resultRefresh` is a deliberate manual nudge — bumping it re-runs this
     poll on request, which is the only reason it is in the list. */
  // biome-ignore lint/correctness/useExhaustiveDependencies: deliberate — see above
  useEffect(() => {
    if (!active || !test) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const r = await api(`/test/${test.testID}`);
        if (live && testIdentity.current === test.testID) {
          if (r.requestID !== test.requestID) throw Error('Mismatched live check result');
          setTestError('');
          setResult(r);
          if (['pending', 'verifying', 'executing'].includes(r.state))
            timer = setTimeout(() => void poll(), 1500);
        }
      } catch (e) {
        if (live && testIdentity.current === test.testID) setTestError((e as Error).message);
      }
    };
    void poll();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [active, test, resultRefresh]);
  const start = async () => {
    if (checking) return;
    setChecking(true);
    setError('');
    setResult(null);
    setTestError('');
    testIdentity.current = null;
    operation.current ||= crypto.randomUUID();
    try {
      const v = await api('/test', { operationID: operation.current });
      if (alive.current) {
        testIdentity.current = v.testID;
        setTest(v);
      }
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    } finally {
      if (alive.current) setChecking(false);
    }
  };
  const copy = async (c: Command) => {
    setError('');
    try {
      await navigator.clipboard.writeText(c.command);
      setCopied(c.id);
    } catch {
      setError('Copy unavailable. Select the command below and copy it manually.');
    }
  };
  const secureURL = new URL(window.location.href);
  secureURL.protocol = 'https:';
  secureURL.port = '';
  const fresh = setup?.version === setup?.expectedVersion && setup?.service === 'responding';
  const passed =
    result?.state === 'complete' &&
    !result.versionChanged &&
    result.version === setup?.version &&
    fresh &&
    Date.now() - result.checkedAt < 300000;
  const terminal =
    result &&
    (['failed', 'rejected', 'expired', 'complete', 'uncertain'].includes(result.state) ||
      result.versionChanged);
  const next = setup?.next;
  const kinds =
    next === 'restart-app'
      ? ['app']
      : next === 'install'
        ? ['install']
        : next === 'update'
          ? ['update']
          : next === 'enroll'
            ? ['enroll']
            : next === 'configure'
              ? []
              : ['connect'];
  const commands = (setup?.commands || []).filter((c) => kinds.includes(c.kind));
  if (next === 'restart-app')
    return (
      <section className="settings-setup" aria-label="Activate setup checks">
        <strong>Activate the updated Settings</strong>
        <p>
          The page updated before the running app server. Run this command in Terminal on the
          hosting Mac, then these live checks will appear automatically.
        </p>
        <button
          type="button"
          onClick={() => {
            if (commands[0]) void copy(commands[0]);
          }}
        >
          {copied === 'restart-app' ? 'Command copied' : 'Copy Mac command'}
        </button>
        <pre>muxpad restart</pre>
        {error && <p role="alert">{error}</p>}
      </section>
    );
  return (
    <section className="settings-setup" aria-label="Slack setup checks">
      <div className="settings-row settings-setup-status">
        <div>
          <strong>
            {passed
              ? 'Slack verified'
              : next === 'update'
                ? 'Slack update available'
                : fresh && setup?.registered
                  ? 'Ready to test Slack'
                  : 'Set up Slack'}
          </strong>
        </div>
      </div>
      {window.location.protocol !== 'https:' && (
        <p className="settings-error">
          Passkeys need HTTPS. Open muxpad at its configured HTTPS hostname before creating or using
          a passkey.
        </p>
      )}
      {setup?.service === 'unreachable' && (
        <p className="settings-error">
          Service unavailable. Check the hosting Mac. Do not reinstall or reset a passkey.
        </p>
      )}
      {fresh && setup?.registered && (
        <div className="settings-setup-test">
          <p>
            {passed
              ? `Read-only Slack test passed at ${new Date(result.checkedAt).toLocaleTimeString()}.`
              : 'Test the connection. Nothing will be sent.'}
          </p>
          <button
            type="button"
            disabled={checking || !fresh || !setup?.registered || !!(test && !terminal && !passed)}
            onClick={() => {
              if (terminal || passed) {
                operation.current = null;
                setTest(null);
              }
              void start();
            }}
          >
            Test Slack
          </button>
          {test && !terminal && !passed && (
            <output>
              {result?.state === 'executing'
                ? 'Checking Slack…'
                : 'Waiting for approval or the check result…'}
            </output>
          )}
          {result && ['failed', 'rejected', 'expired'].includes(result.state) && (
            <output className="settings-error">
              {result.state === 'rejected'
                ? 'The test was denied. Nothing was sent. You can run it again.'
                : result.state === 'expired'
                  ? 'The test expired. Run Test Slack again when ready.'
                  : String(
                      result.error ||
                        'Slack check failed. Check Slack permissions, then run the test again.',
                    )}
            </output>
          )}
          {test && !terminal && !passed && testError && (
            <div>
              <button type="button" onClick={() => setResultRefresh((n) => n + 1)}>
                Check test result
              </button>
              <button
                type="button"
                onClick={() => {
                  operation.current = null;
                  testIdentity.current = null;
                  setTest(null);
                  void start();
                }}
              >
                Start a new read-only test
              </button>
            </div>
          )}
          {result?.state === 'uncertain' && (
            <output>
              The check could not be confirmed. It will not be submitted again automatically. You
              can start an explicitly new read-only test.
            </output>
          )}
          {result?.versionChanged && (
            <p className="settings-error">
              The service changed. Start a new test once it reconnects.
            </p>
          )}
        </div>
      )}
      {next === 'configure' && (
        <p className="settings-error">
          The service responds, but approval status is unavailable or incompatible. Do not reset
          your passkey or reinstall. Recover the existing service, then check again.
        </p>
      )}
      {commands.map((c) => (
        <details
          className="settings-setup-command"
          key={c.id}
          open={
            c.kind !== 'connect' ||
            /missing_scope|invalid_auth|token_revoked|not_authed/.test(String(result?.error || ''))
          }
        >
          <summary>
            {c.kind === 'update'
              ? 'Update required'
              : c.kind === 'install'
                ? 'Install Slack connection'
                : c.kind === 'enroll'
                  ? 'Set up passkey'
                  : 'Repair connection'}
          </summary>
          <p>Run on the Mac hosting muxpad.</p>
          <button className="settings-primary" type="button" onClick={() => void copy(c)}>
            {copied === c.id ? 'Command copied' : 'Copy Mac command'}
          </button>
          <details>
            <summary>Command &amp; checksum</summary>
            <pre>{c.command}</pre>
            <small>
              SHA-256: <code>{c.sha256}</code>
            </small>
          </details>
          <p>Checks refresh automatically. Your passkey is kept.</p>
        </details>
      ))}
      {setup && ['install', 'update', 'enroll'].includes(next || '') && !commands.length && (
        <p className="settings-error">
          No compatible setup command is available for this installation. Do not run an update
          intended for another version.{' '}
          <a
            // THE REPO, NOT A PERSONAL HOST. This pointed at the author's own
            // publish domain — a private hostname baked into a public app, and
            // shown to anyone who ever hits this state. The broker's own
            // README is the reviewed instructions, and it travels with the
            // checkout.
            href="https://github.com/ohadpr/muxpad/blob/main/broker/README.md"
            target="_blank"
            rel="noopener noreferrer"
          >
            Reviewed setup instructions
          </a>
        </p>
      )}
      <details className="settings-details">
        <summary>Connection details</summary>
        <p>
          {setup?.service === 'responding' ? 'Service connected' : 'Service unavailable'} ·{' '}
          {setup?.registered ? 'Passkey active' : 'Passkey needed'}
        </p>
        <p>Version: {setup?.version || 'Unknown'}</p>
        <p>{setup ? `Checked ${new Date(setup.checkedAt).toLocaleTimeString()}` : 'Not checked'}</p>
      </details>
      {
        <details className="settings-details" open={setup?.service === 'not-configured'}>
          <summary>Slack account setup</summary>
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard
                .writeText(JSON.stringify(SLACK_APP_MANIFEST, null, 2))
                .then(() => setCopied('slack-manifest'))
                .catch(() => setError('Could not copy the Slack app manifest.'));
            }}
          >
            {copied === 'slack-manifest' ? 'Manifest copied' : 'Copy Slack app manifest'}
          </button>
          <p>
            Open{' '}
            <a href="https://api.slack.com/apps" target="_blank" rel="noopener noreferrer">
              Slack app settings
            </a>
            , choose Create App → From a manifest, and paste the copied manifest. Review these User
            Token Scopes:
          </p>
          <p>
            <code>
              channels:read groups:read channels:history groups:history im:history mpim:history
              search:read chat:write users:read im:write reactions:write files:write
            </code>
          </p>
          <p>
            Install the app to Slack. Copy its User OAuth Token only into the hidden prompt in the
            trusted Mac setup Terminal. Never paste it into muxpad, a chat, or this Settings window.
          </p>
        </details>
      }
      {testError && (
        <p className="settings-error" role="alert">
          {testError}
        </p>
      )}
      {error && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}
      {test?.requestID && active && !terminal && !passed && (
        <SlackPasskeyApproval paneId={`setup-${test.testID}`} diagnosticID={test.testID} />
      )}
    </section>
  );
}
