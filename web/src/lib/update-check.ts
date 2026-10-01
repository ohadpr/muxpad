import { req } from '../api';
import { subscribeResync } from '../events';
import { documentBuildId } from './build-id';
import { flushChatScrollNow } from './chat-scroll';

/**
 * IS THERE A NEWER BUILD? — the in-app update prompt.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * An installed iOS PWA resumed from the app switcher does not re-navigate. It
 * restores the document it already had, so it never re-reads index.html and
 * never learns a deploy happened; and in standalone mode there is no URL bar and
 * no pull-to-refresh, so the user cannot force it either. Force-quitting from
 * the app switcher was the only way out.
 *
 * Caching is NOT the gap and is not what this fixes: the shell is `no-cache`
 * with an ETag, the hashed assets are `immutable`, and the service worker
 * (web/public/sw.js) is Web Push only — it has no fetch handler and caches
 * nothing. All of that is already correct. The gap is that a request is never
 * made at all.
 *
 * ── NO POLL ──────────────────────────────────────────────────────────────────
 * The signals already exist: `subscribeResync` in events.ts fires on every ws
 * RE-connect and on every document-visible — which is exactly the moment a
 * suspended PWA comes back, and the one event iOS can be relied on to deliver.
 * A timer here would repeat a bug class this codebase has already paid for
 * (a poll added for something that already fired a notification), and would ask
 * hardest while the user is asleep.
 *
 * Boot deliberately asks NOTHING: the document was just loaded, so the shell it
 * came from IS the current answer. The first meaningful question is the first
 * resume.
 *
 * The check is not retired once it finds something, which costs one ~30-byte
 * request per foreground and buys two behaviours worth having: a build NEWER
 * than the one already announced replaces it, and a rollback to the build we are
 * running retires the prompt instead of leaving a lie on screen.
 *
 * ── NO AUTO-RELOAD ───────────────────────────────────────────────────────────
 * Reloading is the user's call, always. They may be mid-message, and muxpad has
 * live agents; a reload chosen for them at the wrong instant costs a half-typed
 * prompt. So this module only ever raises a flag, and `applyUpdate` runs from
 * the tap. (The one exception in the app is main.tsx's `vite:preloadError`
 * recovery, which reloads on its own — but that fires only when a dynamic import
 * has ALREADY failed, i.e. from a state that is broken rather than merely old.)
 */

type Listener = (build: string | null) => void;

/** The build this document was loaded with. Null ⇒ the feature is inert. */
let ours: string | null = null;
/** The newest server build seen that differs from ours, else null. */
let theirs: string | null = null;
/** A build the user has already waved away. */
let dismissed: string | null = null;
let asking = false;
let started = false;
const listeners = new Set<Listener>();

/** The build the user should be offered, or null if there is nothing to say. */
export function pendingUpdate(): string | null {
  return theirs && theirs !== dismissed ? theirs : null;
}

function emit(): void {
  const v = pendingUpdate();
  for (const l of listeners) {
    try {
      l(v);
    } catch (err) {
      console.warn('update listener threw', err);
    }
  }
}

export function subscribeUpdate(l: Listener): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

async function check(): Promise<void> {
  // A resume commonly fires both signals at once — visible, then the socket iOS
  // killed without telling us reconnects. One question is enough.
  if (asking) return;
  asking = true;
  try {
    const { build } = await req<{ build: string | null }>('/api/build', { cache: 'no-store' });
    // Null is "I cannot name a build" (no built shell on disk), which is no
    // information at all — it must not retire a prompt we already raised.
    if (!build) return;
    const next = build === ours ? null : build;
    if (next === theirs) return;
    theirs = next;
    emit();
  } catch {
    // Offline, mid-deploy, or an older server with no such route. Silence is
    // the right answer to all three.
  } finally {
    asking = false;
  }
}

/**
 * Start watching. Idempotent, and a no-op when this document cannot name the
 * build it came from — which is the case on the vite dev server, whose shell
 * points at `/src/main.tsx`. Without that guard, every visibility flip during
 * development would compare a source path against the server's hashed `dist/`
 * shell and prompt an update that reloading cannot resolve.
 */
export function startUpdateCheck(): void {
  if (started) return;
  ours = documentBuildId();
  if (!ours) return;
  started = true;
  subscribeResync(() => void check());
}

/** Stop offering this build. Another deploy raises the prompt again. */
export function dismissUpdate(): void {
  dismissed = theirs;
  emit();
}

/**
 * Take the update: end this browsing context and load the new bundle.
 *
 * The flush is load-bearing. A chat reader parked up in history has their
 * position held in memory behind a 250ms debounce (see chat-scroll.ts), and the
 * reader most likely to tap this button is one who is READING rather than
 * typing. `pagehide` flushes too, so this is belt-and-braces — but it is the
 * cheap half of the belt, and it makes the ordering a property of this function
 * rather than of the browser's unload sequence.
 *
 * `reload` is injectable only so a test can observe the order; callers pass
 * nothing.
 */
export function applyUpdate(reload: () => void = () => window.location.reload()): void {
  flushChatScrollNow();
  reload();
}
