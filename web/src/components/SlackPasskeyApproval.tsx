import { useEffect, useId, useRef, useState } from 'react';
import { passkeyAPI, passkeyCeremony } from '../lib/slack-passkey';
import { BrandMark } from './Brand';
import { SlackLogo } from './SlackLogo';
import './SlackPasskeyApproval.css';
type RequestView = {
  id: string;
  fingerprint: string;
  action: string;
  teamID: string;
  payload: Record<string, unknown>;
  expires: number;
  state: string;
  /** What a timed approval of THIS request would cover. The broker computes
   *  it per capability; sending a hardcoded one approved the wrong thing. */
  timedScope?: string;
  timedAllowed?: boolean;
  grantWarning?: string;
  error?: string;
};
const labels: Record<string, string> = {
  'slack.post': 'Send Slack message',
  'slack.unpost': 'Delete Slack message',
  'slack.read': 'Read Slack messages',
  'slack.search': 'Search Slack',
  'slack.channels': 'List Slack channels',
  'slack.users': 'Look up Slack user',
  'slack.dm': 'Open direct message',
  'slack.thread': 'Read Slack thread',
  'slack.react': 'Change reaction',
  'slack.edit': 'Edit Slack message',
  'slack.upload': 'Upload file to Slack',
  // ── THE ARCHIVE IS NOT SLACK ─────────────────────────────────────────────
  // This card is the approval surface for EVERY connector now, and it was
  // written when there was one. An msgvault failure rendered as "Slack
  // request failed" under a Slack logo, in a chat on a machine where Slack is
  // not even supposed to be reachable — reported, reasonably, as alarm.
  //
  // Each label says WHAT IS READ, for the same reason the broker's own dialog
  // does: approving a verb with no object is approving nothing.
  'msgvault.search': 'Search your mail archive',
  'msgvault.show-message': 'Read one archived message',
  'msgvault.show-thread': 'Read an archived thread',
  'msgvault.list-senders': 'List who emails you most',
  'msgvault.stats': 'Read archive totals',
  'msgvault.meetings': 'Read archived meeting notes',
  'msgvault.person': 'Look up a contact',
};

/** Which system a request belongs to, from the action's own prefix — so what
 *  the card says can never disagree with what is about to run. */
const SLACK = { id: 'slack', name: 'Slack' } as const;
const CONNECTORS = [SLACK, { id: 'msgvault', name: 'your archive' } as const];
const connectorOf = (action: string | undefined) =>
  CONNECTORS.find((c) => c.id === String(action ?? '').split('.')[0]) ?? SLACK;
export function SlackPasskeyApproval({
  paneId,
  diagnosticID,
}: { paneId: string; diagnosticID?: string }) {
  const titleID = useId();
  const [request, setRequest] = useState<RequestView | null>(null);
  const [duration, setDuration] = useState('once');
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [error, setError] = useState('');
  const [secureURL, setSecureURL] = useState('');
  const [outcome, setOutcome] = useState('');
  const [status, setStatus] = useState<{
    serverNow: number;
    sessionExpires: number | null;
    grants?: unknown[];
  } | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const busyRef = useRef(false);
  const alive = useRef(true);
  const current = useRef<RequestView | null>(null);
  const generation = useRef(0);
  const blocked = useRef(false);
  const finished = useRef(new Set<string>());
  const refresh = async () => {
    const result = await passkeyAPI(
      diagnosticID
        ? `../setup/test/${encodeURIComponent(diagnosticID)}/pending`
        : `pending?pane=${encodeURIComponent(paneId)}`,
    );
    if (
      result.pane !== paneId ||
      !Array.isArray(result.requests) ||
      typeof result.more !== 'boolean'
    )
      throw Error('Invalid pending status');
    return result;
  };
  /* A RESET for a new pane or diagnostic, not a subscription to `refresh`.
     `refresh` is redefined every render, so including it would tear down and
     rebuild the poll continuously; paneId/diagnosticID are exactly the pair
     that should trigger a reset. */
  // biome-ignore lint/correctness/useExhaustiveDependencies: deliberate — see above
  useEffect(() => {
    generation.current++;
    finished.current.clear();
    blocked.current = false;
    busyRef.current = false;
    setBusy(false);
    current.current = null;
    setRequest(null);
    setDuration('once');
    setError('');
    setOutcome('');
    dialog.current?.close();
    alive.current = true;
    let timer: ReturnType<typeof setTimeout>;
    let active = true;
    const poll = async () => {
      try {
        if (!busyRef.current) {
          const pollEpoch = generation.current;
          const r = await refresh();
          if (active && !busyRef.current && generation.current === pollEpoch) {
            setStatus(r.status);
            const waiting = r.requests.filter(
              (item: RequestView) => !finished.current.has(item.id),
            );
            const next = (waiting.find((item: RequestView) => item.id === current.current?.id) ??
              waiting[0]) as RequestView | undefined;
            if (!next && !r.more && current.current) {
              current.current = null;
              setRequest(null);
              setError('');
              blocked.current = false;
              dialog.current?.close();
            } else if (!blocked.current && next && next.id !== current.current?.id) {
              current.current = next;
              setRequest(next);
              setDuration('once');
              setError('');
            } else if (current.current && current.current.expires <= Date.now()) {
              setError('This request expired. Nothing was approved.');
            }
          }
        }
      } catch {
        /* No unrelated outage notice and no automatic approval retry. */
      } finally {
        if (active) timer = setTimeout(() => void poll(), 2000);
      }
    };
    void poll();
    return () => {
      active = false;
      alive.current = false;
      generation.current++;
      clearTimeout(timer);
      dialog.current?.close();
    };
  }, [paneId, diagnosticID]);
  /* Keyed on the request's IDENTITY on purpose: `request` is a fresh object
     on every poll of the pending list, so depending on it would re-run this —
     and call showModal() — several times a second. Only a genuinely different
     request should reopen the dialog. */
  // biome-ignore lint/correctness/useExhaustiveDependencies: deliberate — see above
  useEffect(() => {
    if (request) {
      setDismissed(false);
      if (!dialog.current?.open) dialog.current?.showModal();
    }
  }, [request?.id]);
  const [outcomeConnector, setOutcomeConnector] = useState<(typeof CONNECTORS)[number]>(SLACK);
  const decide = async (decision: 'approve' | 'reject') => {
    if (!request || busyRef.current) return;
    const epoch = ++generation.current;
    const selected = request;
    const live = () => alive.current && generation.current === epoch;
    const intentLive = () => live() && current.current === selected;
    busyRef.current = true;
    setBusy(true);
    setError('');
    setSecureURL('');
    if (decision === 'reject') {
      dialog.current?.close();
      setDismissed(true);
    }
    try {
      const chosen = decision === 'reject' || diagnosticID ? 'once' : duration;
      const ceremony = await passkeyAPI('options', {
        id: request.id,
        fingerprint: request.fingerprint,
        decision,
        duration: chosen,
        // THE REQUEST'S OWN SCOPE. Hardcoding Slack's meant a timed approval
        // of an archive read asked for `slack-team-all-v2` — the broker then
        // refused it, and had it not, the human would have granted something
        // other than what the card described.
        ...(chosen === 'once' ? {} : { scope: request.timedScope ?? 'slack-team-all-v2' }),
      });
      if (!intentLive()) return;
      const response = await passkeyCeremony(ceremony, false, {
        purpose: 'slack-decision',
        requestID: request.id,
        fingerprint: request.fingerprint,
        action: request.action,
        teamID: request.teamID,
        payload: request.payload,
        decision,
        duration: chosen,
        scope: chosen === 'once' ? null : (request.timedScope ?? 'slack-team-all-v2'),
      });
      if (!intentLive()) return;
      // The native confirmation is finished. Return to chat while the single
      // signed submission completes; closing is never evidence of approval.
      dialog.current?.close();
      setDismissed(true);
      // Signed decisions are submitted ONCE. Lost/uncertain responses are never retried.
      const result = await passkeyAPI('decision', { ceremonyID: ceremony.ceremonyID, response });
      if (!live()) return;
      if (result.id !== request.id || result.fingerprint !== request.fingerprint)
        throw Error('Mismatched decision result. Check status before continuing.');
      if (!['complete', 'rejected', 'failed', 'expired'].includes(result.state))
        throw Error('Approval status is uncertain. Check the request before trying again.');
      finished.current.add(selected.id);
      // A confirmed terminal result is finished even when Slack itself failed.
      // Close immediately: a later pending-status outage must not trap the modal.
      current.current = null;
      setRequest(null);
      dialog.current?.close();
      // `request` was nulled two lines up when the dialog closed; `selected`
      // is the one this result belongs to.
      setOutcomeConnector(connectorOf(selected.action));
      const who = connectorOf(selected.action).name;
      if (result.state === 'failed') setOutcome(`${who} request failed. Nothing was retried.`);
      else if (result.state === 'expired') setOutcome(`${who} request expired.`);
      else if (result.grantWarning) setOutcome('Request finished; timed access was not granted.');
      const snapshot = await refresh();
      if (!live()) return;
      setStatus(snapshot.status);
      const next = snapshot.requests.find((item: RequestView) => !finished.current.has(item.id));
      if (next) {
        current.current = next;
        setRequest(next);
        setDuration('once');
      }
    } catch (e) {
      if (live()) {
        if (current.current) {
          blocked.current = true;
          setError(e instanceof Error ? e.message : 'Approval unavailable. No automatic retry.');
          const target = (e as { secureURL?: unknown })?.secureURL;
          if (typeof target === 'string' && target.startsWith('https://')) setSecureURL(target);
        }
      }
    } finally {
      if (live()) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  };
  const close = () => {
    dialog.current?.close();
    setDismissed(true);
    blocked.current = false;
  };
  return (
    <>
      {outcome && (
        <output className="slack-passkey-inline">
          {/* NO SLACK MARK ON A NON-SLACK RESULT. A Slack logo over "request
              failed" for an archive read is a claim about which system was
              touched, on a machine where Slack is not meant to be reachable
              at all — which is exactly how it was read when it happened. */}
          {outcomeConnector === SLACK ? <SlackLogo /> : <span aria-hidden="true">📥</span>}
          <span>{outcome}</span>
          <button type="button" aria-label="Dismiss status" onClick={() => setOutcome('')}>
            Dismiss
          </button>
        </output>
      )}
      {dismissed && request && (
        <div className="slack-passkey-inline">
          {connectorOf(request.action) === SLACK ? (
            <SlackLogo />
          ) : (
            <span aria-hidden="true">📥</span>
          )}
          <output>
            {busy
              ? `Finishing ${connectorOf(request.action).name} approval…`
              : error || `${connectorOf(request.action).name} approval`}
          </output>
          {!busy && (
            <button
              type="button"
              onClick={() => {
                setDismissed(false);
                dialog.current?.showModal();
              }}
            >
              Review
            </button>
          )}
        </div>
      )}
      <dialog
        className="slack-passkey-dialog"
        ref={dialog}
        onCancel={(e) => {
          e.preventDefault();
          if (!busyRef.current) close();
        }}
        aria-labelledby={titleID}
      >
        {request && (
          <>
            <div className="slack-passkey-brand">
              <BrandMark />
              <span>muxpad</span>
              <span aria-hidden="true">↔</span>
              {connectorOf(request.action) === SLACK ? (
                <SlackLogo />
              ) : (
                <span aria-hidden="true">📥</span>
              )}
              <span>{connectorOf(request.action).name}</span>
            </div>
            <h2 id={titleID}>muxpad wants to access {connectorOf(request.action).name}</h2>
            <label className="slack-passkey-duration">
              Allow for
              <select
                aria-label="Approval duration"
                disabled={busy || !!diagnosticID}
                value={duration}
                onChange={(e) => setDuration(e.target.value)}
              >
                <option value="once">This request</option>
                <option value="10m">10 minutes</option>
                <option value="1h">1 hour</option>
                <option value="1d">1 day</option>
              </select>
            </label>
            {duration !== 'once' && (
              <p className="slack-passkey-scope">
                All agents can read, search, send, edit, delete, react, open DMs and upload files in
                this Slack workspace. Ends within the selected period, on restart or when revoked in
                Settings.
              </p>
            )}
            {!!status?.grants?.length && (
              <p className="slack-passkey-note">
                Timed Slack access is already active. Manage it in Settings.
              </p>
            )}
            <details className="slack-passkey-details">
              <summary>Request details</summary>
              <p>
                {labels[request.action] ?? request.action} · {request.teamID}
              </p>
              <dl>
                {Object.entries(request.payload).map(([key, value]) => (
                  <div key={key}>
                    <dt>{key}</dt>
                    <dd>{typeof value === 'string' ? value : JSON.stringify(value)}</dd>
                  </div>
                ))}
              </dl>
            </details>
            {error && <output className="slack-passkey-error">{error}</output>}
            {secureURL && (
              <p>
                <a href={secureURL}>Open secure muxpad</a>
              </p>
            )}
            <div className="slack-passkey-actions">
              <button type="button" disabled={busy} onClick={() => void decide('reject')}>
                Deny
              </button>
              <button
                type="button"
                className="slack-passkey-approve"
                disabled={busy}
                onClick={() => void decide('approve')}
              >
                {busy ? 'Confirming…' : 'Approve'}
              </button>
            </div>
            {error && (
              <button type="button" className="slack-passkey-close" disabled={busy} onClick={close}>
                Close
              </button>
            )}
          </>
        )}
      </dialog>
    </>
  );
}
