import { useEffect, useState } from 'react';
import { passkeyAPI } from '../lib/slack-passkey';
import { SlackApprovalsButton } from './SlackApprovalsButton';
import { SlackLogo } from './SlackLogo';
import { SlackPasskeyApproval } from './SlackPasskeyApproval';
import './SlackApprovalAlert.css';
import { mountApprovalPoll } from '../lib/slack-notice-diagnostic';
/** This advisory notification cannot authorize anything. */
export function SlackApprovalAlert({ paneId }: { paneId: string }) {
  const [mode, setMode] = useState<'unknown' | 'legacy' | 'passkey-inline'>('unknown');
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await passkeyAPI('status');
        if (active && (result.mode === 'legacy' || result.mode === 'passkey-inline'))
          setMode(result.mode);
      } catch {
        /* Unknown mode never launches a fallback approval page. */
      } finally {
        if (active) timer = setTimeout(() => void poll(), 15000);
      }
    };
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, []);
  return mode === 'passkey-inline' ? (
    <SlackPasskeyApproval key={paneId} paneId={paneId} />
  ) : mode === 'legacy' ? (
    <LegacySlackApprovalAlert key={paneId} paneId={paneId} />
  ) : null;
}
function LegacySlackApprovalAlert({ paneId }: { paneId: string }) {
  const [waiting, setWaiting] = useState<{
    pane: string;
    pending: number;
    url: string;
    incomplete: boolean;
    stale: boolean;
  } | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    let active = true;
    const diagnostic = mountApprovalPoll(paneId);
    let timer: ReturnType<typeof setTimeout>;
    let deadline: ReturnType<typeof setTimeout>;
    let controller: AbortController;
    let delay = 2000;
    const poll = async () => {
      controller = new AbortController();
      let status = 0;
      diagnostic.start();
      try {
        const result = await Promise.race([
          fetch(`/api/slack/approvals?pane=${encodeURIComponent(paneId)}`, {
            cache: 'no-store',
            signal: controller.signal,
          }).then(async (response) => {
            status = response.status;
            if (!response.ok) throw Error('Unavailable');
            return response.json();
          }),
          new Promise<never>((_, reject) => {
            deadline = setTimeout(() => {
              controller.abort();
              reject(Error('Timeout'));
            }, 8000);
          }),
        ]);
        if (result.pane !== paneId) throw Error('Mismatched pane');
        if (!Number.isSafeInteger(result.pending) || result.pending < 0)
          throw Error('Invalid status');
        if (active) {
          setWaiting(
            typeof result.approval_url === 'string'
              ? {
                  pane: paneId,
                  pending: result.pending,
                  url: result.approval_url,
                  incomplete: result.incomplete === true,
                  stale: result.stale === true,
                }
              : null,
          );
          setUnavailable(false);
          diagnostic.success(status, result.pending, result.stale === true);
        }
        delay = 2000;
      } catch {
        if (active) {
          setUnavailable(true);
          diagnostic.fail(status);
        }
        delay = Math.min(delay * 2, 30_000);
      } finally {
        clearTimeout(deadline);
        if (active) timer = setTimeout(poll, delay);
      }
    };
    void poll();
    return () => {
      active = false;
      diagnostic.unmount();
      clearTimeout(timer);
      clearTimeout(deadline);
      controller?.abort();
    };
  }, [paneId]);
  if (
    !waiting ||
    waiting.pane !== paneId ||
    (!waiting.pending && !waiting.incomplete && !waiting.stale)
  )
    return null;
  return (
    <output className="slack-approval-alert" aria-live="polite" data-slack-alert-pane={paneId}>
      <SlackLogo />
      <strong>
        {waiting.incomplete
          ? 'Slack approvals may be waiting'
          : waiting.pending
            ? `Slack approval needed${waiting.pending > 1 ? ` (${waiting.pending})` : ''}`
            : 'Slack approval status unavailable'}
      </strong>
      {(unavailable || waiting.stale) && <small>Reconnecting…</small>}
      <SlackApprovalsButton approvalURL={waiting.url} />
    </output>
  );
}
