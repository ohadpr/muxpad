import { useEffect, useState } from 'react';
import { api } from '../api';

/**
 * Which face a shell pane is currently showing: its terminal, a web view of
 * an app it serves, or the chat view of its agent session. One mosaic node,
 * multiple faces, toggled in place — the terminal keeps running underneath
 * whichever face is up (see ShellPaneBody).
 *
 * The face + web url are SERVER-persisted (panes.face / panes.face_url,
 * PATCH /api/panes/:id) so the choice survives reloads and follows the user
 * across devices — same shape as tabs.view_mode. This module is the client's
 * optimistic overlay: setPaneFace() flips the in-memory state immediately and
 * PATCHes behind it; syncPaneFace() adopts the server's value (from the pane
 * object, kept live by pane.updated events) unless a local flip is still
 * settling. The old localStorage store is read once per pane purely as a
 * migration source, then dropped.
 *
 * Both the chrome controls (PaneWebSwitch / PaneSurfaceSwitch) and the pane
 * body (ShellPaneBody) live in independent React subtrees, so this is a tiny
 * shared store with subscribers rather than prop-drilled state.
 */
export interface PaneFace {
  face: 'terminal' | 'web' | 'chat';
  /** The web URL to show when face === 'web'. Null until one is chosen. */
  url: string | null;
}

const DEFAULT: PaneFace = { face: 'terminal', url: null };
// The pre-server-persistence store (per-device localStorage). Kept ONLY as a
// one-time migration source: a pane whose server row still has the default
// but had a face chosen here keeps that choice (pushed up to the server),
// after which the entry is deleted and the server is the sole source of truth.
const LEGACY_KEY = 'muxpad.paneFace.v1';

// How long a local flip outranks an incoming server snapshot. A pane object
// fetched BEFORE our PATCH landed still carries the old face; adopting it
// would revert the toggle. Our own PATCH echo (pane.updated) carries the new
// face and reconciles once this window passes.
const LOCAL_WINS_MS = 4000;

const faces = new Map<string, PaneFace>();
const lastLocalSet = new Map<string, number>();
const listeners = new Map<string, Set<() => void>>();

function notify(paneId: string): void {
  const subs = listeners.get(paneId);
  if (subs) for (const fn of subs) fn();
}

export function getPaneFace(paneId: string): PaneFace {
  return faces.get(paneId) ?? DEFAULT;
}

/** Pop this pane's entry from the legacy localStorage store, if any. */
function takeLegacy(paneId: string): PaneFace | null {
  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const record = parsed as Record<string, unknown>;
    if (!(paneId in record)) return null;
    const v = record[paneId] as Partial<PaneFace> | undefined;
    delete record[paneId];
    if (Object.keys(record).length === 0) localStorage.removeItem(LEGACY_KEY);
    else localStorage.setItem(LEGACY_KEY, JSON.stringify(record));
    if (!v || typeof v !== 'object') return null;
    const face = v.face === 'web' || v.face === 'chat' ? v.face : 'terminal';
    const url = typeof v.url === 'string' ? v.url : null;
    return { face, url };
  } catch {
    return null;
  }
}

/** Flip the face: optimistic local update + server PATCH (fire-and-forget). */
export function setPaneFace(paneId: string, next: PaneFace): void {
  const prev = getPaneFace(paneId);
  if (prev.face === next.face && prev.url === next.url) return;
  faces.set(paneId, next);
  lastLocalSet.set(paneId, Date.now());
  notify(paneId);
  api.patchPane(paneId, { face: next.face, face_url: next.url }).catch((e) => {
    // Keep the optimistic value — the next server snapshot re-syncs if the
    // write really didn't land.
    console.error('failed to persist pane face', e);
  });
}

/**
 * Reconcile with the server's value for this pane (from the pane object the
 * page already holds, kept live by pane.updated events). Server wins —
 * except inside the short window after a local flip, whose PATCH echo will
 * confirm it. A legacy localStorage choice migrates up the first time the
 * pane is seen with a still-default server row.
 */
export function syncPaneFace(
  paneId: string,
  serverFace: PaneFace['face'] | undefined,
  serverUrl: string | null | undefined,
): void {
  const legacy = takeLegacy(paneId);
  if (
    legacy &&
    (legacy.face !== 'terminal' || legacy.url) &&
    (serverFace ?? 'terminal') === 'terminal' &&
    !serverUrl
  ) {
    // One-time migration: this device chose a face before the columns
    // existed; keep the choice and make it durable.
    setPaneFace(paneId, legacy);
    return;
  }
  if (serverFace === undefined) return;
  const next: PaneFace = { face: serverFace, url: serverUrl ?? null };
  const cur = getPaneFace(paneId);
  if (cur.face === next.face && cur.url === next.url) return;
  const setAt = lastLocalSet.get(paneId) ?? 0;
  if (Date.now() - setAt < LOCAL_WINS_MS) return;
  faces.set(paneId, next);
  notify(paneId);
}

/**
 * Subscribe-and-read hook. Pass the pane's server-reported face/face_url
 * (kept live by pane.updated events) so flips on other devices sync in.
 */
export function usePaneFace(
  paneId: string,
  serverFace?: PaneFace['face'],
  serverUrl?: string | null,
): PaneFace {
  const [face, setFace] = useState<PaneFace>(() => {
    // Cold-load seed: adopt the server value synchronously on first render
    // (no notify — nothing to reconcile yet) so a chat/web pane doesn't
    // flash its terminal face for a frame before the sync effect runs.
    if (serverFace !== undefined && !faces.has(paneId)) {
      faces.set(paneId, { face: serverFace, url: serverUrl ?? null });
    }
    return getPaneFace(paneId);
  });
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
  // Adopt the server's value whenever it changes (initial load, pane.updated
  // from another device, our own PATCH echo).
  useEffect(() => {
    syncPaneFace(paneId, serverFace, serverUrl);
  }, [paneId, serverFace, serverUrl]);
  return face;
}

/** Normalize a user-typed URL the way the chrome's URL field does. */
export function normalizePaneUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}
