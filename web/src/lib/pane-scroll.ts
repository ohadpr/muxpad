// Per-pane xterm scroll position for Cursor CLI (normal-buffer scrollback).
// Stored as a ratio (0 = live prompt, 1 = top of scrollback) so reload replay
// (truncated tail) can restore a proportional position instead of jumping to
// the top when an absolute line offset no longer fits in the buffer.
const KEY = 'muxpad.paneScroll.v2';

type State = Record<string, number>;

function read(): State {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    const out: State = {};
    for (const [id, v] of Object.entries(parsed)) {
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1) out[id] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function write(s: State): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // quota exceeded etc. — best-effort
  }
}

/** 0 = pinned to live prompt, 1 = scrolled to top of scrollback. */
export function getPaneScrollRatio(paneId: string): number | undefined {
  const v = read()[paneId];
  return v === undefined ? undefined : v;
}

export function setPaneScrollRatio(paneId: string, ratio: number): void {
  const n = Math.max(0, Math.min(1, ratio));
  const s = read();
  if (s[paneId] === n) return;
  s[paneId] = n;
  write(s);
}
