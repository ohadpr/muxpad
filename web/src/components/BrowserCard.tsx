import { useEffect, useState } from 'react';
import {
  type BrowserMoment,
  browserMomentView,
  browserOpenMode,
  wheelCountdown,
} from '../lib/browser-card.js';
import './BrowserCard.css';

/**
 * One browser MOMENT, as it appears in a conversation.
 *
 * The shape follows the spawn card deliberately, and now so does the placement:
 * a card sits at the point in the log where the thing happened, and the chat
 * continues past it. Opening a browser is one card; getting stuck at a login
 * wall, twenty minutes later, is another.
 *
 * It was previously one pinned card per browser, above the transcript. That
 * made a sequence of events look like a status light, and it meant every
 * conversation carried it whether or not anything had happened there.
 *
 * The moment is fixed; the LIVE browser is read at render time, so "can I still
 * open this" and "is it still asking for me" are answered by looking rather
 * than by what was true when the line was written.
 */

export interface BrowserCardProps {
  moment: BrowserMoment;
  /** Opens the stream. Modal on a desktop, a new tab on a phone. */
  onOpen: (mode: 'modal' | 'tab') => void;
  /** Injected in tests; defaults to the real viewport. */
  viewportWidth?: number;
  now?: number;
}

export function BrowserCard({ moment, onOpen, viewportWidth, now }: BrowserCardProps) {
  const view = browserMomentView(moment);
  const data = moment.browser;
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

  const act = () => onOpen(browserOpenMode(viewportWidth ?? window.innerWidth));

  return (
    <div
      className={`browser-card browser-card--${view.tone}${view.passive ? ' browser-card--passive' : ''}`}
      data-testid="browser-card"
      data-tone={view.tone}
      // A passive card takes the click ITSELF rather than carrying a button.
      // Looking is always allowed; being ASKED to look is what was wrong — a
      // button, however quiet, reads as a thing that needs dealing with, and
      // almost always there is nothing to deal with.
      {...(view.passive && view.openable
        ? {
            role: 'button',
            tabIndex: 0,
            onClick: act,
            onKeyDown: (e: React.KeyboardEvent) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                act();
              }
            },
          }
        : {})}
    >
      {/* A BROWSER, unmistakably. A dot said "some card"; next to a spawn card
        in the same log the two were tellable apart only by their words. A
        window with a title bar and one light reads as a browser at 15px, which
        is the size it has to work at. */}
      <span className="browser-card__glyph" aria-hidden="true">
        <svg viewBox="0 0 16 14" width="15" height="14">
          <rect x="0.75" y="0.75" width="14.5" height="12.5" rx="2.5" />
          <path d="M0.75 4.25h14.5" />
          <circle cx="3.1" cy="2.5" r="0.75" className="browser-card__light" />
        </svg>
      </span>
      <div className="browser-card__body">
        {view.title ? <div className="browser-card__title">{view.title}</div> : null}
        {view.detail ? (
          // The full text on the title attribute, since the visible line is clamped.
          <div className="browser-card__detail" title={view.detail}>
            {view.detail}
          </div>
        ) : null}
      </div>
      {view.countdown && countdown ? (
        <div className="browser-card__countdown">{countdown}</div>
      ) : null}
      {view.action ? (
        <button type="button" className="browser-card__action" onClick={act} data-urgent="true">
          {view.action}
        </button>
      ) : null}
      {/* THE PAGE ITSELF, when we have it.
        A card saying "Amazon needs a login" is a claim you take on trust and a
        tap to check; the same card showing the sign-in page is the claim with
        its evidence attached. It spans the full width underneath, so the line
        above stays one line and the picture is the thing that grows.

        `loading="lazy"` because a long chat can hold several, and onError
        removes it rather than leaving a broken frame — the still is cache, and
        one that has been pruned must read as "no picture", not as a fault. */}
      {view.shotUrl ? (
        <img
          className="browser-card__shot"
          src={view.shotUrl}
          alt=""
          loading="lazy"
          decoding="async"
          onError={(e) => {
            e.currentTarget.remove();
          }}
        />
      ) : null}
    </div>
  );
}
