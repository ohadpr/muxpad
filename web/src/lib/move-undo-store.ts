/**
 * "Undo the last move" toasts for pane/tab moves. A move pushes one entry
 * here; `MoveUndoToast` (mounted in AppLayout, so it survives the navigation
 * a move triggers) subscribes and renders a transient toast with an Undo
 * button. Backed by the generic `createToastStore` engine — each entry just
 * carries a `run` callback (the reverse move) instead of a URL.
 */
import { type ToastItem, createToastStore } from './toast-store';

export interface UndoEntry extends ToastItem {
  message: string;
  /** Performs the reverse move. Awaited; the toast dismisses regardless. */
  run: () => Promise<void> | void;
}

// One move at a time is the realistic case; a longer TTL than a generic toast
// so there's time to react after the follow-navigation lands.
const store = createToastStore<UndoEntry>({ max: 4, ttlMs: 9_000 });

export function pushUndo(entry: { message: string; run: () => Promise<void> | void }): void {
  store.push(entry);
}

export const dismissUndo = store.dismiss;
export const getUndos = store.get;
export const subscribeUndos = store.subscribe;
