import { useCallback, useEffect, useState } from 'react';
import { type BrowserCardData, visibleBrowsers } from '../lib/browser-card';
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
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
  pollMs?: number;
  openTab?: (url: string) => void;
  viewportWidth?: number;
}

export function BrowserCards({
  by,
  fetchImpl,
  pollMs = POLL_MS,
  openTab,
  viewportWidth,
}: BrowserCardsProps) {
  const doFetch = fetchImpl ?? fetch;
  const [browsers, setBrowsers] = useState<BrowserCardData[]>([]);
  const [openProfile, setOpenProfile] = useState<string | null>(null);

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
    async (data: BrowserCardData, mode: 'modal' | 'tab') => {
      // Take FIRST. A viewer that accepts input while the agent still holds the
      // wheel is the exact race the wheel exists to prevent.
      await post(`/api/browsers/${data.profile}/wheel/take`, {
        by,
        ...(data.needsYou ? { reason: data.needsYou.reason } : {}),
      });
      if (mode === 'tab')
        (openTab ?? ((url: string) => window.open(url, '_blank')))(data.viewerUrl);
      else setOpenProfile(data.profile);
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

  // A browser that is not running gets no card. See visibleBrowsers — without
  // this, the profile registered at boot sits at the top of every conversation
  // forever, saying nothing.
  const shown = visibleBrowsers(browsers);
  const active = shown.find((b) => b.profile === openProfile) ?? null;

  return (
    <>
      {shown.map((data) => (
        <BrowserCard
          key={data.profile}
          data={data}
          {...(viewportWidth !== undefined ? { viewportWidth } : {})}
          onOpen={(mode) => void open(data, mode)}
        />
      ))}
      {active ? (
        <BrowserModal
          data={active}
          by={by}
          onClose={() => void close(active.profile)}
          onRenew={() => void post(`/api/browsers/${active.profile}/wheel/renew`, { by })}
        />
      ) : null}
    </>
  );
}
