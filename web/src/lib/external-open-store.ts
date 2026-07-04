/**
 * Pending "open URL in real browser tab" requests from the server. main.tsx
 * pushes incoming `external_url.open` events here; `ExternalOpenToasts`
 * subscribes and renders one clickable toast per pending request.
 *
 * The toast must call window.open() from inside the click handler so the
 * browser treats it as a user gesture (popup blockers will silently drop
 * window.open() calls made directly from a WebSocket message handler).
 *
 * Backed by the generic `createToastStore` engine (pub/sub + TTL + cap).
 */
import { type ToastItem, createToastStore } from './toast-store';

export interface PendingOpen extends ToastItem {
  url: string;
  tab_id: string | null;
  pane_id: string | null;
}

// Cap pending toasts so a misbehaving script (`for i in {1..1000}; do
// muxpad open …`) can't blow up the DOM. A request that's sat unclicked for
// a minute is stale — the feature is "escape this pane to a real tab right
// now" — so TTL it; without one, tab_id-scoped toasts would resurface
// whenever the user navigated back to the originating tab.
const store = createToastStore<PendingOpen>({ max: 20, ttlMs: 60_000 });

export function pushOpen(req: { url: string; tab_id?: string; pane_id?: string }): void {
  store.push({ url: req.url, tab_id: req.tab_id ?? null, pane_id: req.pane_id ?? null });
}

export const dismissOpen = store.dismiss;
export const getOpens = store.get;
export const subscribeOpens = store.subscribe;
