import { useEffect, useState } from 'react';
import {
  type BrowserMoment,
  browserLiveShotUrl,
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

/**
 * How often an expanded card re-photographs the page.
 *
 * A still, not a stream, deliberately: a live screencast per card is a socket
 * and a frame rate per card, and the question a peek answers — "what is it
 * doing?" — is answered by a picture every couple of seconds. The server
 * coalesces captures per browser, so several cards peeking at one browser cost
 * one screenshot.
 */
const PEEK_EVERY_MS = 2_500;

/**
 * The expanded picture, refreshed while it is on screen.
 *
 * PAUSED WHEN THE TAB IS HIDDEN. Otherwise a phone in a pocket keeps a browser
 * taking screenshots of itself every two and a half seconds, forever, for
 * nobody — and the capture is a real CDP round trip into a real page.
 */
function useLiveShot(profile: string, on: boolean): string | null {
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const beat = () => {
      if (!document.hidden) setTick(Date.now());
    };
    const id = setInterval(beat, PEEK_EVERY_MS);
    const wake = () => {
      // Straight away on return, rather than up to one interval of a stale
      // picture that looks like a frozen browser.
      if (!document.hidden) setTick(Date.now());
    };
    document.addEventListener('visibilitychange', wake);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', wake);
    };
  }, [on]);
  return on ? browserLiveShotUrl(profile, tick) : null;
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

  // PER CARD, and several can be open at once: peeking at two browsers side by
  // side in one conversation is the case this is for.
  const [peeking, setPeeking] = useState(false);
  const peekUrl = useLiveShot(moment.profile, peeking && view.openable);

  const act = () => onOpen(browserOpenMode(viewportWidth ?? window.innerWidth));

  return (
    <div
      className={`browser-card browser-card--${view.tone}${view.passive ? ' browser-card--passive' : ''}`}
      data-testid="browser-card"
      data-tone={view.tone}
      // THE WHOLE CARD IS THE TARGET, button or no button. A passive card
      // always took its own click — looking is always allowed; being ASKED to
      // look is what was wrong. But a card WITH an "Open" button was a 60px
      // target inside a 400px card that plainly looks like one thing you can
      // open, and aiming at the button is work the card can do for you. Asked
      // for directly: "make it so clicking anywhere in this card opens it".
      //
      // ROLE AND KEYBOARD ONLY WHEN THERE IS NO BUTTON. Nesting a button inside
      // a role="button" announces one control containing another and gives the
      // same action two tab stops. When the card carries its own button, that
      // button IS the accessible control and this is a pointer convenience on
      // top of it.
      {...(view.openable
        ? view.action
          ? { onClick: act }
          : {
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
        {/* biome-ignore lint/a11y/noSvgWithoutTitle: decorative — the wrapper is aria-hidden, so a <title> would be announced to nobody and the card's text carries the meaning */}
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
      {/* PEEK — the control for "what is it doing right now?".
        Separate from opening, because opening is a decision: the modal is a
        window you have to dismiss, and on a phone it is a whole tab. This is
        the question you actually have most of the time, and the answer is a
        picture in the chat that keeps up. It does NOT take the wheel; the
        agent carries on, unaware anyone is looking. */}
      {view.openable ? (
        <button
          type="button"
          className="browser-card__peek"
          aria-expanded={peeking}
          aria-label={peeking ? 'Hide the page' : 'Show what it is doing'}
          title={peeking ? 'Hide the page' : 'Show what it is doing'}
          onClick={(e) => {
            // The card opens the viewer, so a peek has to stop here or looking
            // would always be followed by a window nobody asked for.
            e.stopPropagation();
            setPeeking((v) => !v);
          }}
        >
          {/* biome-ignore lint/a11y/noSvgWithoutTitle: labelled on the button, where a screen reader reads it once rather than twice */}
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            {peeking ? (
              <path d="M3 10.5 8 5.5l5 5" />
            ) : (
              <path d="M3 5.5 8 10.5l5-5" />
            )}
          </svg>
        </button>
      ) : null}
      {view.action ? (
        <button
          type="button"
          className="browser-card__action"
          // The card around it opens it too, so a click here would otherwise
          // run `act` twice — once for the button, once on the way up.
          onClick={(e) => {
            e.stopPropagation();
            act();
          }}
          data-urgent="true"
        >
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
      {peekUrl ? (
        // THE LIVE ONE REPLACES THE FROZEN ONE while peeking. Two pictures of
        // the same browser, one of them minutes old, is a card asking you to
        // work out which is which.
        //
        // Clicking it opens the viewer: the picture is the thing you were
        // looking at, so it is also the thing you reach for when looking is no
        // longer enough. The card's own click would do it, but this is inside
        // the card and says so by being a control.
        <img
          className="browser-card__shot browser-card__shot--live"
          src={peekUrl}
          alt=""
          decoding="async"
          onClick={(e) => {
            e.stopPropagation();
            act();
          }}
          onError={(e) => {
            // A capture that failed is not a broken card: the previous frame
            // stays on screen rather than collapsing to a torn image icon.
            e.currentTarget.classList.add('browser-card__shot--stale');
          }}
          onLoad={(e) => {
            e.currentTarget.classList.remove('browser-card__shot--stale');
          }}
        />
      ) : view.shotUrl ? (
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
