import type { AppWithStatus, Artifact } from '@muxpad/shared';
import { hostedApi } from './hosted';
import { type SearchableOutput, toSearchableOutputs } from './output-search';

/**
 * The hosted-output corpus behind ⌘K — apps and published artifacts.
 *
 * LAZY AND UNPOLLED, for the same reason as lib/all-tabs and one more of its
 * own. Nothing here runs until the palette is opened, so the first paint pays
 * nothing. And it is NOT the Hosted page's `useHosted`, which polls every
 * three seconds because an app's state is a measured thing: a search session
 * is seconds long, and one request per time you go looking for something is
 * the honest cost. Mounting a 3s poll behind a dialog nobody has opened would
 * be two requests a second across a day of having muxpad open.
 *
 * STALE BY DESIGN, within a bound. A reopened palette reuses what it has if it
 * is fresh and refetches otherwise; an app that went down in the last minute
 * can therefore be listed as running. That is the trade a cached list makes,
 * and it is the right one here because the row is a DESTINATION — you press
 * Enter, the thing either shows up or does not, and the page you land on is
 * the one with the real state on it. The alternative is making the user wait
 * for a probe of every app before their first keystroke ranks.
 *
 * Failure is silence. The outputs are a second tier under the chats, so a
 * request that fails must cost the search nothing but this tier: the box still
 * finds chats and still searches messages, with no error to dismiss.
 */

/** How long a loaded corpus is reused before the next open refetches. Long
 *  enough that typing, backspacing and retyping is one request; short enough
 *  that going away and coming back asks again. */
export const OUTPUTS_TTL_MS = 60_000;

let cache: SearchableOutput[] | null = null;
let loadedAt = 0;
let inflight: Promise<void> | null = null;
const listeners = new Set<(outputs: SearchableOutput[]) => void>();

export function cachedOutputs(): SearchableOutput[] | null {
  return cache;
}

export function subscribeOutputs(fn: (outputs: SearchableOutput[]) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Fetch them, unless a fresh copy is already held or a request is already out.
 *
 * Resolves rather than rejects on failure — see the file note. One request at a
 * time: opening the palette twice in a second must not ask twice.
 */
export function loadOutputs(now: number = Date.now()): Promise<void> {
  if (cache && now - loadedAt < OUTPUTS_TTL_MS) return Promise.resolve();
  if (inflight) return inflight;
  // STAMPED WITH WHEN WE ASKED, not when it landed. One clock, supplied by
  // the caller, so the TTL is testable without faking timers — and a slow
  // request does not quietly extend the life of the answer it returns.
  inflight = Promise.all([hostedApi.listApps(), hostedApi.listArtifacts()])
    .then(([a, p]) => {
      publish(toSearchableOutputs(appsOf(a), artifactsOf(p)), now);
    })
    .catch(() => {
      // Deliberately NOT cached as an empty list: a failed request must not
      // make the tier look empty for the next TTL. The next open asks again.
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** Tolerant readers. These two routes are the oldest shape in the app and a
 *  malformed answer must cost the palette a tier, never a throw inside a
 *  keystroke handler. */
function appsOf(res: { apps?: AppWithStatus[] } | null): AppWithStatus[] {
  return Array.isArray(res?.apps) ? res.apps : [];
}
function artifactsOf(res: { publishes?: Artifact[] } | null): Artifact[] {
  return Array.isArray(res?.publishes) ? res.publishes : [];
}

function publish(outputs: SearchableOutput[], at: number): void {
  cache = outputs;
  loadedAt = at;
  for (const fn of listeners) fn(outputs);
}

/** Tests only — the module holds process-wide state by design. */
export function resetOutputsCache(): void {
  cache = null;
  loadedAt = 0;
  inflight = null;
}
