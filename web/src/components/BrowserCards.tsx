import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  type BrowserCardData,
  type BrowserMoment,
  type BrowserOpenIntent,
  browserMoments,
  browserOpenIntent,
  browserViewerPath,
} from '../lib/browser-card';
import { BrowserCard } from './BrowserCard';
import { BrowserModal } from './BrowserModal';

/**
 * Every browser muxpad owns, as cards in a conversation.
 *
 * WHY THIS POLLS RATHER THAN SUBSCRIBING. The state that matters — "an agent is
 * waiting for you" — is a fact on the server, and the whole point of the card is
 * that you learn it by LOOKING rather than by having been present when it
 * happened. A poll is correct after a reload, after a reconnect, and on a phone
 * that was asleep; a subscription is correct only while it is connected, which
 * is exactly when you did not need it.
 *
 * WHY THE WHEEL IS TAKEN ON OPEN, NOT ON A SEPARATE BUTTON. Opening the stream
 * IS the act of taking over — a person looking at a live page will click on it,
 * and a viewer that renders input while the agent still holds the wheel is the
 * two-writers race the wheel exists to prevent. So: take, then show. Closing
 * hands it straight back rather than letting a ten-minute lease lapse with an
 * agent waiting on it.
 */

const POLL_MS = 4000;

export interface BrowserCardsProps {
  /** Identifies this pane to the wheel. */
  by: string;
  /** The chat these cards belong to; moments from elsewhere are not shown. */
  tabId: string;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
  pollMs?: number;
  openTab?: (url: string) => void;
  viewportWidth?: number;
}

/**
 * The browser machinery, as a hook.
 *
 * A hook rather than a wrapper component because the CARDS belong inside the
 * conversation's log, interleaved by time, and only ChatPane knows where that
 * is — while the polling, the wheel and the modal belong here. Wrapping the log
 * in a render prop would have meant reshaping six thousand lines of JSX to move
 * two cards.
 */
export function useBrowsers({
  by,
  tabId,
  fetchImpl,
  pollMs = POLL_MS,
  openTab,
  viewportWidth,
}: BrowserCardsProps) {
  const doFetch = fetchImpl ?? fetch;
  const [browsers, setBrowsers] = useState<BrowserCardData[]>([]);
  const [openProfile, setOpenProfile] = useState<string | null>(null);
  const [openIntent, setOpenIntent] = useState<BrowserOpenIntent>('watch');

  const refresh = useCallback(async () => {
    try {
      const res = await doFetch('/api/browsers');
      if (!res.ok) return;
      const body = (await res.json()) as { browsers?: BrowserCardData[] };
      setBrowsers(body.browsers ?? []);
    } catch {
      // A failed poll leaves the last known state on screen. Blanking the cards
      // on one dropped request would make a brief hiccup look like "the browser
      // is gone", which is the opposite of what a card is for.
    }
  }, [doFetch]);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), pollMs);
    return () => clearInterval(id);
  }, [refresh, pollMs]);

  const post = useCallback(
    async (path: string, body: unknown) => {
      try {
        await doFetch(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
      } catch {
        // Same reasoning as refresh: the next poll re-reads the truth.
      }
      void refresh();
    },
    [doFetch, refresh],
  );

  const open = useCallback(
    async (data: BrowserCardData, mode: 'modal' | 'tab', intent: BrowserOpenIntent) => {
      // WATCHING TAKES NOTHING. Looking over the agent's shoulder is the common
      // case — the session card exists so you can — and seizing the browser to
      // do it stalls a task you asked for, for a reason the agent cannot see.
      //
      // Answering a summons takes the wheel FIRST, before any input can reach
      // the page: a viewer accepting clicks while the agent still holds it is
      // the exact race the wheel exists to prevent.
      if (intent === 'drive') {
        await post(`/api/browsers/${data.profile}/wheel/take`, {
          by,
          ...(data.needsYou ? { reason: data.needsYou.reason } : {}),
        });
      }
      if (mode === 'tab') {
        const url = data.viewerUrl + (intent === 'watch' ? '?mode=watch' : '');
        (openTab ?? ((u: string) => window.open(u, '_blank')))(url);
      } else {
        setOpenProfile(data.profile);
        setOpenIntent(intent);
      }
    },
    [by, post, openTab],
  );

  const close = useCallback(
    async (profile: string) => {
      setOpenProfile(null);
      try {
        await doFetch(`/api/browsers/${profile}/wheel`, {
          method: 'DELETE',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ by }),
        });
      } catch {
        // The lease expires on its own; this only makes it prompt.
      }
      void refresh();
    },
    [by, doFetch, refresh],
  );

  // One card per MOMENT, in the conversation where it happened. See
  // browserMoments — a browser that merely exists produces no cards at all.
  //
  // MEMOIZED, and not as a micro-optimisation: this array is a dependency of
  // the transcript memo in ChatPane. A fresh identity every render would
  // rebuild a six-thousand-line conversation on every keystroke.
  const moments = useMemo(() => browserMoments(browsers, tabId), [browsers, tabId]);
  // Stable identity for the same reason `moments` is memoized.
  const openSync = useCallback(
    (browser: BrowserCardData, mode: 'modal' | 'tab', intent: BrowserOpenIntent) =>
      void open(browser, mode, intent),
    [open],
  );

  const active = browsers.find((b) => b.profile === openProfile) ?? null;

  return {
    /** What this conversation should draw, oldest first. */
    moments,
    /** Takes the wheel and shows the stream. Stable — see `moments`. */
    open: openSync,
    /** Render this anywhere; it is fixed-position and draws nothing when closed. */
    modal: active ? (
      <BrowserModal
        data={active}
        intent={openIntent}
        by={by}
        onClose={() => void close(active.profile)}
        onRenew={() => void post(`/api/browsers/${active.profile}/wheel/renew`, { by })}
      />
    ) : null,
    viewportWidth,
  };
}

/** Standalone use: draws every moment in order, then the modal. */
export function BrowserCards(props: BrowserCardsProps) {
  const { moments, open, modal, viewportWidth } = useBrowsers(props);
  return (
    <>
      {moments.map((moment: BrowserMoment) => (
        <BrowserCard
          key={`${moment.profile}:${moment.at}:${moment.kind}`}
          moment={moment}
          {...(viewportWidth !== undefined ? { viewportWidth } : {})}
          onOpen={(mode) => open(moment.browser, mode, browserOpenIntent(moment))}
        />
      ))}
      {modal}
    </>
  );
}
