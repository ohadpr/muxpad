import { useEffect, useState } from 'react';

/**
 * Which face a shell pane is currently showing: its terminal, or a web view
 * of an app it serves. One mosaic node, two faces, toggled in place — the
 * terminal keeps running underneath while the web face is up (see
 * ShellPaneBody). The chosen face + url is per-pane and persisted so it
 * survives a reload, but defaults to 'terminal' (we never auto-flip to web —
 * switching is always a user action).
 *
 * Both the chrome control (PaneWebSwitch) and the pane body (ShellPaneBody)
 * live in independent React subtrees, so this is a tiny shared store with
 * subscribers rather than prop-drilled state — same shape as the tabs /
 * workspaces caches.
 */
export interface PaneFace {
  face: 'terminal' | 'web' | 'chat';
  /** The web URL to show when face === 'web'. Null until one is chosen. */
  url: string | null;
}

const DEFAULT: PaneFace = { face: 'terminal', url: null };
const KEY = 'muxpad.paneFace.v1';

type State = Record<string, PaneFace>;
const listeners = new Map<string, Set<() => void>>();
let cache: State | null = null;

function read(): State {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    const out: State = {};
    if (parsed && typeof parsed === 'object') {
      for (const [id, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (v && typeof v === 'object') {
          const raw = (v as PaneFace).face;
          const face = raw === 'web' || raw === 'chat' ? raw : 'terminal';
          const url = typeof (v as PaneFace).url === 'string' ? (v as PaneFace).url : null;
          out[id] = { face, url };
        }
      }
    }
    cache = out;
  } catch {
    cache = {};
  }
  return cache;
}

function write(s: State): void {
  cache = s;
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // best-effort (quota / private mode)
  }
}

export function getPaneFace(paneId: string): PaneFace {
  return read()[paneId] ?? DEFAULT;
}

export function setPaneFace(paneId: string, next: PaneFace): void {
  const s = { ...read() };
  const prev = s[paneId] ?? DEFAULT;
  if (prev.face === next.face && prev.url === next.url) return;
  s[paneId] = next;
  write(s);
  const subs = listeners.get(paneId);
  if (subs) for (const fn of subs) fn();
}

/** Subscribe-and-read hook used by both the chrome switch and the pane body. */
export function usePaneFace(paneId: string): PaneFace {
  const [face, setFace] = useState<PaneFace>(() => getPaneFace(paneId));
  useEffect(() => {
    // Resync on paneId change (the hook may be reused across panes).
    setFace(getPaneFace(paneId));
    let subs = listeners.get(paneId);
    if (!subs) {
      subs = new Set();
      listeners.set(paneId, subs);
    }
    const onChange = () => setFace(getPaneFace(paneId));
    subs.add(onChange);
    return () => {
      subs?.delete(onChange);
      if (subs && subs.size === 0) listeners.delete(paneId);
    };
  }, [paneId]);
  return face;
}

/** Normalize a user-typed URL the way the chrome's URL field does. */
export function normalizePaneUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}
