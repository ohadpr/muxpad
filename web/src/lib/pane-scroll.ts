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

// Last-known foreground command. After a main-server restart, decoratePane
// reports `foreground_cmd: null` for the life of a parked process (until a
// ptyd bounce makes flushDecorations land). Wheel routing, Cursor replay
// restore, and Ink-vs-shell decisions must not fall back to "this is a
// shell" for that entire window. Null means unknown, not empty.
const FG_KEY = 'muxpad.paneFg.v1';

type FgState = Record<string, string>;

function readFg(): FgState {
  try {
    const raw = localStorage.getItem(FG_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    const out: FgState = {};
    for (const [id, v] of Object.entries(parsed)) {
      if (typeof v === 'string' && v.trim()) out[id] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function writeFg(s: FgState): void {
  try {
    localStorage.setItem(FG_KEY, JSON.stringify(s));
  } catch {
    // quota exceeded etc. — best-effort
  }
}

export function getPaneForegroundCmd(paneId: string): string | undefined {
  return readFg()[paneId];
}

/** Persist a non-empty live decoration. Null/blank does not clear. */
export function rememberPaneForegroundCmd(paneId: string, cmd: string | null | undefined): void {
  const trimmed = cmd?.trim();
  if (!trimmed) return;
  const s = readFg();
  if (s[paneId] === trimmed) return;
  s[paneId] = trimmed;
  writeFg(s);
}

/**
 * Live decoration if present, else last-known, else infer cursor-agent from a
 * saved scroll ratio (only Cursor panes write muxpad.paneScroll.v2).
 */
export function stickyForegroundCmd(
  paneId: string,
  live: string | null | undefined,
): string | null {
  const trimmed = live?.trim();
  if (trimmed) {
    rememberPaneForegroundCmd(paneId, trimmed);
    return trimmed;
  }
  const remembered = getPaneForegroundCmd(paneId);
  if (remembered) return remembered;
  if (getPaneScrollRatio(paneId) !== undefined) return 'cursor-agent';
  return live ?? null;
}
