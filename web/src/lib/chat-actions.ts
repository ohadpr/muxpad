import type { ChatAction } from '@muxpad/shared';
import { useEffect, useState } from 'react';
import { injectByTime } from './log-window';

/**
 * THE CHAT'S ACTS ON OUTSIDE SYSTEMS, fetched and placed.
 *
 * The client half of shared/src/chat-actions.ts. Two functions, both thin on
 * purpose: the card's shape is in the component, the rule for placing timed
 * things in a partially-loaded log is in lib/log-window, and what is left here
 * is "ask the server" and "hand them to that rule".
 */

/**
 * How often to re-ask.
 *
 * A POLL, and the same reasoning as the browser cards': the state that matters
 * — "did that message actually go?" — is a fact on the server, and the point of
 * the card is that you learn it by LOOKING rather than by having been present.
 * A poll is correct after a reload, after a reconnect and on a phone that was
 * asleep; a subscription is correct only while it is connected, which is
 * exactly when you did not need it.
 *
 * Slower than the browsers' 4s: nothing here moves on its own, it moves when a
 * person approves something, and that is a human-speed event.
 */
export const ACTIONS_POLL_MS = 8_000;

/**
 * This chat's acts, oldest first. `[]` until the first answer, and `[]`
 * forever on a server that has no such route — an older server must degrade to
 * "no cards", never to a broken transcript.
 */
export function useChatActions(paneId: string, pollMs = ACTIONS_POLL_MS): ChatAction[] {
  const [actions, setActions] = useState<ChatAction[]>([]);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // NOT cleared between polls on failure: a card that vanishes because one
    // request timed out is worse than a card that is a few seconds stale, and
    // the next poll will correct it either way.
    const load = async () => {
      try {
        const res = await fetch(`/api/panes/${encodeURIComponent(paneId)}/actions`, {
          headers: { accept: 'application/json' },
        });
        if (res.ok) {
          const body = (await res.json()) as { actions?: ChatAction[] };
          if (alive && Array.isArray(body.actions)) setActions(body.actions);
        }
      } catch {
        /* keep what we have; the next poll corrects it */
      } finally {
        if (alive) timer = setTimeout(() => void load(), pollMs);
      }
    };
    void load();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [paneId, pollMs]);
  return actions;
}

/**
 * Drop the cards into the log at the moment each act happened.
 *
 * Entries in, entries out — so this composes with the browser-moment injector
 * and the spawn-card interleave without any of the three knowing about the
 * others. See lib/log-window for why the loop is not written out here.
 */
export function injectActionCards<T>(
  entries: readonly { at: number | null; node: T }[],
  actions: readonly ChatAction[],
  render: (action: ChatAction) => T,
  opts?: { floor?: number | null },
): { at: number | null; node: T }[] {
  return injectByTime(entries, actions, render, (e) => e.node, opts?.floor ?? null);
}
