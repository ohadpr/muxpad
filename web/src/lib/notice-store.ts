/**
 * The chrome's own failure line — what replaced `window.alert`.
 *
 * Five actions reported failure by raising a NATIVE dialog with `String(err)`
 * in it: archive, delete chat, close workspace (twice), close pane. A system
 * modal is the wrong shape for every one of them. It takes the whole window
 * for something that happened in a 20px row, it cannot be styled, it says
 * "127.0.0.1:7777 says" above a raw Error, and it has to be dismissed before
 * anything else can be done — including looking at the thing that failed.
 *
 * So failures land where the moves and the external opens already land: a
 * toast in the corner, on the app's own surface, auto-expiring, with the row
 * still right there behind it. Same `createToastStore` engine as the other
 * two, so there is one lifecycle for transient chrome messages rather than
 * three.
 *
 * DELIBERATELY NOT the chat's `.chat-notice` strip: that is scoped to one
 * pane's composer, and these fire from the sidebar, which outlives any pane
 * and is visible when no chat is open at all.
 */
import { type ToastItem, createToastStore } from './toast-store';

export interface Notice extends ToastItem {
  /** One sentence, already human — "Couldn't close the workspace." */
  message: string;
  /** The underlying error, shown small beneath. Optional: a notice that needs
   *  no cause is better without an empty line under it. */
  detail?: string;
}

// Longer than the undo toast: there is no action to take, so the only thing
// the TTL buys is time to READ it, and a raw server error is not a glance.
const store = createToastStore<Notice>({ max: 3, ttlMs: 12_000 });

export function pushNotice(notice: { message: string; detail?: string }): void {
  store.push(notice);
}

/** The common call site: something threw, and the user should be told in a
 *  sentence rather than handed the exception. `console.error` stays with the
 *  caller — a toast expires, the log does not. */
export function noticeFromError(message: string, err: unknown): void {
  const detail = err instanceof Error ? err.message : String(err);
  pushNotice(detail ? { message, detail } : { message });
}

export const dismissNotice = store.dismiss;
export const getNotices = store.get;
export const subscribeNotices = store.subscribe;
