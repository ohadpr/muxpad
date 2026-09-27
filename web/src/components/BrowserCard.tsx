import { useEffect, useState } from 'react';
import {
  type BrowserCardData,
  browserCardView,
  browserOpenMode,
  wheelCountdown,
} from '../lib/browser-card.js';
import './BrowserCard.css';

/**
 * A browser, as it appears in a conversation.
 *
 * The shape follows the spawn card deliberately: muxpad says it opened a
 * browser, the card stays in the log, and it stays clickable forever after. The
 * difference is that this one can become URGENT — a spawn card reports what
 * happened, this one sometimes needs you right now.
 *
 * WHY THE CARD AND NOT A LINK. A link in a transcript is findable only by
 * scrolling to the moment it was written, which on a conversation that has been
 * running for two days is the same as not having it. The card is a component
 * with live state read at render time, so "is the browser waiting for me" is
 * answered by looking, not by remembering.
 */

export interface BrowserCardProps {
  data: BrowserCardData;
  /** Opens the stream. Modal on a desktop, a new tab on a phone. */
  onOpen: (mode: 'modal' | 'tab') => void;
  /** Starts a browser that is registered but not running. */
  onStart?: () => void;
  /** Injected in tests; defaults to the real viewport. */
  viewportWidth?: number;
  now?: number;
}

export function BrowserCard({ data, onOpen, onStart, viewportWidth, now }: BrowserCardProps) {
  const view = browserCardView(data);
  const [tick, setTick] = useState(() => now ?? Date.now());

  // The countdown is the only live thing on the card. One timer, one second,
  // and only while somebody actually holds the wheel — a card per conversation
  // ticking forever would be a hundred timers on a busy morning.
  useEffect(() => {
    if (now !== undefined || !data.wheel) return;
    const id = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, [now, data.wheel]);

  const countdown = wheelCountdown(data.wheel, now ?? tick);

  const act = () => {
    if (view.action === 'Start') return onStart?.();
    onOpen(browserOpenMode(viewportWidth ?? window.innerWidth));
  };

  return (
    <div
      className={`browser-card browser-card--${view.tone}`}
      data-testid="browser-card"
      data-tone={view.tone}
    >
      <div className="browser-card__glyph" aria-hidden="true">
        {view.tone === 'blocked' ? '!' : '◉'}
      </div>
      <div className="browser-card__body">
        <div className="browser-card__title">{view.title}</div>
        {view.detail ? <div className="browser-card__detail">{view.detail}</div> : null}
      </div>
      {countdown ? <div className="browser-card__countdown">{countdown}</div> : null}
      {view.action ? (
        <button
          type="button"
          className="browser-card__action"
          onClick={act}
          // The urgent one is the only button on the card that should read as a
          // call to action; the rest are "you may look at this".
          data-urgent={view.urgent ? 'true' : 'false'}
        >
          {view.action}
        </button>
      ) : null}
    </div>
  );
}
