/**
 * Per-pane list of manually-entered web-face URLs, so "Enter URL…" isn't a
 * cold start every time. Device-local by design (like composer drafts) —
 * these are typing shortcuts, not shared state. Capped small; most-recent
 * first; deduped.
 */
const KEY = (paneId: string) => `muxpad.urlRecents.${paneId}`;
const MAX = 5;

export function getUrlRecents(paneId: string): string[] {
  try {
    const raw = localStorage.getItem(KEY(paneId));
    const arr: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((u): u is string => typeof u === 'string') : [];
  } catch {
    return [];
  }
}

export function addUrlRecent(paneId: string, url: string): void {
  try {
    const next = [url, ...getUrlRecents(paneId).filter((u) => u !== url)].slice(0, MAX);
    localStorage.setItem(KEY(paneId), JSON.stringify(next));
  } catch {
    // storage unavailable — recents just don't persist
  }
}
