/**
 * Tiny pub/sub store for pending "open URL in real browser tab" requests
 * from the server. main.tsx pushes incoming `external_url.open` events
 * here; the `ExternalOpenToasts` component subscribes and renders one
 * clickable toast per pending request.
 *
 * The toast must call window.open() from inside the click handler so the
 * browser treats it as a user gesture (popup blockers will silently drop
 * window.open() calls made directly from a WebSocket message handler).
 */

export interface PendingOpen {
  id: number;
  url: string;
  tab_id: string | null;
  pane_id: string | null;
  createdAt: number;
}

type Listener = (opens: PendingOpen[]) => void;

// Hard cap on pending toasts. A misbehaving script
// (`for i in {1..1000}; do muxpad open …`) shouldn't be able to blow
// up the DOM. When at capacity we drop the OLDEST entry — fresh
// requests are more likely to reflect current user intent.
const MAX_PENDING = 20;

// Auto-dismiss a toast that's been sitting unclicked this long. The
// feature is meant for "I'm working in a pane and want to escape it to
// a real browser tab right now" — a request that hasn't been acted on
// in a minute is stale and was probably already forgotten. Without a
// TTL, tab_id-scoped toasts would re-surface whenever the user
// navigated back to the originating tab, sometimes long after the
// request was relevant.
const TTL_MS = 60_000;

let nextId = 1;
let opens: PendingOpen[] = [];
const listeners = new Set<Listener>();
const expiryTimers = new Map<number, ReturnType<typeof setTimeout>>();

function emit(): void {
  for (const l of listeners) l(opens);
}

function clearExpiry(id: number): void {
  const t = expiryTimers.get(id);
  if (t) {
    clearTimeout(t);
    expiryTimers.delete(id);
  }
}

export function pushOpen(req: {
  url: string;
  tab_id?: string;
  pane_id?: string;
}): void {
  const next: PendingOpen = {
    id: nextId++,
    url: req.url,
    tab_id: req.tab_id ?? null,
    pane_id: req.pane_id ?? null,
    createdAt: Date.now(),
  };
  const combined = [...opens, next];
  // When trimming to MAX_PENDING, clear expiry timers for entries we're
  // dropping — otherwise they fire later and call dismissOpen on ids
  // that no longer exist (harmless but wasteful).
  if (combined.length > MAX_PENDING) {
    const dropped = combined.slice(0, combined.length - MAX_PENDING);
    for (const d of dropped) clearExpiry(d.id);
    opens = combined.slice(-MAX_PENDING);
  } else {
    opens = combined;
  }
  expiryTimers.set(
    next.id,
    setTimeout(() => dismissOpen(next.id), TTL_MS),
  );
  emit();
}

export function dismissOpen(id: number): void {
  const next = opens.filter((o) => o.id !== id);
  if (next.length === opens.length) return;
  opens = next;
  clearExpiry(id);
  emit();
}

export function getOpens(): PendingOpen[] {
  return opens;
}

export function subscribeOpens(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
