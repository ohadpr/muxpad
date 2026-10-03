import { useEffect, useRef, useState } from 'react';
import type { BrowserCardData } from '../lib/browser-card.js';
import { browserViewerPath, shouldRenewWheel, wheelCountdown } from '../lib/browser-card.js';
import './BrowserModal.css';

/**
 * Taking the wheel, on a desktop.
 *
 * The browser itself is headless on the machine and always will be — this is a
 * live JPEG stream in an iframe, and the clicks and keystrokes go back over the
 * same socket. Nothing here renders the page; the viewer served by the browser
 * host does, and this is the frame around it.
 *
 * WHY AN IFRAME AND NOT A CANVAS IN THIS COMPONENT. Because the viewer already
 * exists, is served by the process that owns the browser, and is the same URL a
 * phone opens in a tab. Reimplementing it here would mean two input stacks to
 * keep correct, and the input stack is the part with the long tail.
 *
 * THE LEASE IS RENEWED FROM HERE, not from the server's side. A person with the
 * modal open is the only evidence that a person is still there — the server
 * cannot tell an open tab from a closed laptop. Closing the modal hands the
 * wheel back immediately rather than letting it lapse, so an agent is not left
 * waiting out a ten-minute timer for a browser nobody is using.
 */

export interface BrowserModalProps {
  data: BrowserCardData;
  /** `watch` frames the viewer read-only, so the agent keeps working. */
  intent?: 'watch' | 'drive';
  /** Identifies this claimant to the wheel — the pane holding the modal. */
  by: string;
  onClose: () => void;
  onRenew: () => void;
  /** Injected in tests. */
  now?: () => number;
  /** Injected in tests; real one is window.setInterval. */
  intervalMs?: number;
}

export function BrowserModal({
  data,
  intent = 'drive',
  by,
  onClose,
  onRenew,
  now = () => Date.now(),
  intervalMs = 15_000,
}: BrowserModalProps) {
  const [taken, setTaken] = useState(false);
  const driving = intent === 'drive' || taken;
  const frameRef = useRef<HTMLIFrameElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  // Escape closes, which also hands the wheel back. Bound on the document
  // because focus is inside a cross-origin iframe for most of this component's
  // life, and a keydown there never reaches a React handler.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // Only a lease you HOLD needs renewing. Watching holds nothing.
  useEffect(() => {
    if (!driving) return;
    const id = setInterval(() => {
      if (shouldRenewWheel(data.wheel, now())) onRenew();
    }, intervalMs);
    return () => clearInterval(id);
  }, [data.wheel, onRenew, now, intervalMs, driving]);

  /**
   * DONE, PRESSED INSIDE THE VIEWER, CLOSES THIS.
   *
   * The viewer has its own Done — it is the only one a phone gets, where there is
   * no dialog around it. On a desktop it released the wheel and could do nothing
   * else, because it is in a frame: reported as "I clicked done then had to
   * close". Two close buttons, one of which only half worked.
   *
   * Origin-checked, because a message handler on the window accepts messages from
   * anywhere by default and this one closes things.
   */
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return;
      if (
        e.data?.muxpad === 'takeover' &&
        e.source === frameRef.current?.contentWindow &&
        e.data.by === by
      )
        setTaken(true);
      if ((e.data as { muxpad?: string } | null)?.muxpad === 'handback') closeRef.current();
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [by]);

  const countdown = wheelCountdown(data.wheel, now());
  const yours = data.wheel?.holder === 'human' && data.wheel.by === by;

  return (
    <div className="browser-modal" data-testid="browser-modal">
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: Escape is handled on the document above. */}
      <div className="browser-modal__scrim" onClick={onClose} />
      <div className="browser-modal__panel" role="dialog" aria-label={`browser · ${data.profile}`}>
        <div className="browser-modal__bar">
          <span className="browser-modal__title">browser · {data.profile}</span>
          <span className="browser-modal__wheel" data-yours={yours ? 'true' : 'false'}>
            {!driving ? 'watching — the agent keeps working' : 'you have the wheel'}
          </span>
          {countdown ? <span className="browser-modal__countdown">{countdown}</span> : null}
          <button type="button" className="browser-modal__close" onClick={onClose}>
            Done
          </button>
        </div>
        <iframe
          className="browser-modal__frame"
          title={`browser ${data.profile}`}
          ref={frameRef}
          // Keep the initial mode in the URL: changing it after takeover would
          // reload the iframe and discard the focus the person just chose.
          src={`${
            browserViewerPath(data.profile, intent) + (intent === 'watch' ? '&' : '?')
          }by=${encodeURIComponent(by)}`}
          // RELATIVE, so the frame is same-origin however you reached the
          // cockpit — loopback at the desk, tailnet from the sofa. Not
          // sandboxed: taking keyboard and pointer input is the entire point,
          // and it has no access to this document either way.
          allow="clipboard-read; clipboard-write"
        />
      </div>
    </div>
  );
}
