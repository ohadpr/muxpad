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

let nextId = 1;
let opens: PendingOpen[] = [];
const listeners = new Set<Listener>();

function emit(): void {
  for (const l of listeners) l(opens);
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
  opens = combined.length > MAX_PENDING ? combined.slice(-MAX_PENDING) : combined;
  emit();
}

export function dismissOpen(id: number): void {
  const next = opens.filter((o) => o.id !== id);
  if (next.length === opens.length) return;
  opens = next;
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
