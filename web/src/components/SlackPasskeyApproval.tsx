import { useEffect, useId, useRef, useState } from 'react';
import { describeRequest, marksFor } from '../lib/approval-request';
import { passkeyAPI, passkeyCeremony } from '../lib/slack-passkey';
import { SlackLogo } from './SlackLogo';
import { SourceMarks } from './SourceMarks';
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
  /** Which machine the asking side SAYS it is. A label, not a fact — shown
   *  because a human approving a duration should see what it is bound to. */
  origin?: string;
  timedRefusedReason?: string;
  grantWarning?: string;
  error?: string;
};
/**
 * WHAT A REQUEST SAYS IT IS — one description, in `approval-request.ts`.
 *
 * This file used to carry a `labels` map whose only consumer was a line
 * inside a collapsed <details>. The card now leads with that description
 * instead of burying it, and the verb's object, its limits and which of your
 * data it reaches come from the same table, so they cannot drift apart.
 */

/** Which system a request belongs to, from the action's own prefix — so what
 *  the card says can never disagree with what is about to run. */
const SLACK = { id: 'slack', name: 'Slack' } as const;
const CONNECTORS = [SLACK, { id: 'msgvault', name: 'your archive' } as const];
const connectorOf = (action: string | undefined) =>
  CONNECTORS.find((c) => c.id === String(action ?? '').split('.')[0]) ?? SLACK;
/** Which connector a live grant belongs to. A grant names its own actions, so
 *  the first of them answers it — and an "already active" note must only
 *  appear for the capability being asked about. */
const connectorOfGrant = (g: { action?: string; actions?: string[] }) =>
  connectorOf(g.actions?.[0] ?? g.action);
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
    // Shaped, not `unknown[]`: the "already active" note must only appear
    // for the capability being asked about, and that needs the grant's own
    // actions. Both fields optional — an older broker sends one or neither.
    grants?: Array<{ action?: string; actions?: string[] }>;
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
      // `once` whenever a duration would be refused at the decision — belt to
      // the UI's braces, and forced HERE rather than via setDuration, which
      // would not have landed before this line runs.
      const chosen =
        decision === 'reject' || diagnosticID || request.timedAllowed === false ? 'once' : duration;
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
  /** One description of the live request — heading, qualifier, the field the
   *  decision turns on, and everything else that will be sent. */
  const described = request
    ? describeRequest(request.action, request.payload)
    : { title: '', rest: [] as Array<[string, string]> };
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
            {/* ── THE ASK IS THE HEADLINE ──────────────────────────────────
                The mark says which system and which of YOUR DATA this
                reaches; the heading is the verb with its object. Neither
                repeats the other, and between them the old brand line
                ("muxpad ↔ your archive") and the old generic heading
                ("muxpad wants to access your archive") say nothing that is
                not already on screen, so both are gone. */}
            <div className="slack-passkey-head">
              <SourceMarks marks={marksFor(request.action)} />
              <div className="slack-passkey-headtext">
                <h2 id={titleID}>{described.title}</h2>
                {described.qualifier && (
                  <p className="slack-passkey-qualifier">{described.qualifier}</p>
                )}
              </div>
            </div>
            {/* THE THING YOU ARE ACTUALLY DECIDING, at the size that implies.
                It used to be the smallest text in the box, behind a
                disclosure triangle, under two lines that named the capability
                twice. */}
            {described.primary && (
              <p className="slack-passkey-payload">{described.primary.value}</p>
            )}
            {/* …AND THE REST OF THE PAYLOAD, VISIBLE. Not a <details>: a
                security prompt that hides part of what it is about is asking
                for approval of something it did not show. */}
            {described.rest.length > 0 && (
              <dl className="slack-passkey-rest">
                {described.rest.map(([key, value]) => (
                  <div key={key}>
                    <dt>{key}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
            )}
            {/* WHO ASKED, AND FOR HOW LONG — one row, because they are one
                question: this machine, this once. */}
            <div className="slack-passkey-foot">
              {/* THE MACHINE THAT ASKED. The broker's whole justification for
                  carrying `origin` is "it is shown to the human before they
                  approve", and in this mode it never was. It is a LABEL the
                  asking side asserts — said plainly, because a duration is now
                  refused for any origin the broker cannot attribute. */}
              <p className="slack-passkey-note">
                asked by <strong>{request.origin ?? 'unknown'}</strong>
                {/* The Slack workspace belongs with WHO ASKED, not on a line of
                    its own — and it means nothing at all on an archive read. */}
                {connectorOf(request.action) === SLACK ? ` · ${request.teamID}` : ''}
                {/* ── WHETHER THAT NAME IS EVIDENCE ──────────────────────
                    This said "unverified, so approve-once only" for ANY
                    remote origin, which was true when no remote machine could
                    prove anything. It is not any more, and the first proven
                    request showed the contradiction immediately: a full
                    duration menu under a line insisting the opposite. A
                    dialog that argues with itself is worse than one that says
                    nothing at all.

                    The broker is the only thing that knows — it holds the key
                    — so the answer comes from `timedAllowed`, its verdict on
                    THIS request, rather than from a guess about what the
                    origin's name implies. */}
                {request.origin === 'local'
                  ? ''
                  : request.timedAllowed === false
                    ? ' — unverified, so approve-once only'
                    : ' — verified'}
              </p>
              {/* ── ONLY OFFER WHAT THE BROKER WOULD ACCEPT ──────────────────
                  `timedAllowed: false` means a duration will be REFUSED at the
                  decision: the broker cannot attribute this request's origin,
                  so a lasting permission would rest on a claim anything on this
                  machine could make. Offering 10m/1h/1d anyway invited the one
                  failure that teaches people to distrust a dialog — pick an
                  option, sign the ceremony, watch it fail.
                  The reason is shown rather than the control being silently
                  missing: "unavailable" with no explanation is its own puzzle. */}
              {request.timedAllowed === false ? (
                <p className="slack-passkey-note">
                  This request can only be approved <strong>once</strong>.{' '}
                  {request.timedRefusedReason ??
                    'The broker cannot verify which machine asked, so a lasting permission is not offered.'}
                </p>
              ) : (
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
                    {/* NOT "forever", which this cannot be and must not
                        claim. Broker grants live in memory and cannot outlive
                        the session that minted them, so the honest name is
                        the one the scope line below then spells out. */}
                    <option value="until-revoked">Until I revoke it</option>
                  </select>
                </label>
              )}
            </div>
            {/* WHAT A DURATION ACTUALLY COVERS, for THIS capability. It said
                "read, search, send, edit, delete, react, open DMs and upload
                files in this Slack workspace" above an archive read — a
                description of a grant that was not being made. */}
            {duration !== 'once' && (
              <p className="slack-passkey-scope">
                {connectorOf(request.action) === SLACK
                  ? 'All agents can read, search, send, edit, delete, react, open DMs and upload files in this Slack workspace.'
                  : 'All agents on this machine can search and read your mail archive. It cannot send, draft or change anything.'}{' '}
                {duration === 'until-revoked'
                  ? ' Ends when you revoke it in Settings, when the broker restarts, or when this approval session expires — it is not stored on disk.'
                  : ' Ends within the selected period, on restart or when revoked in Settings.'}
              </p>
            )}
            {/* …and only for the SAME capability. "Timed Slack access is
                already active" appeared whenever any grant existed, archive
                grants included. */}
            {!!status?.grants?.some((g) => connectorOfGrant(g) === connectorOf(request.action)) && (
              <p className="slack-passkey-note">
                Timed {connectorOf(request.action).name} access is already active. Manage it in
                Settings.
              </p>
            )}
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
