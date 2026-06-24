/**
 * Tiny pub/sub store for "undo the last move" toasts. A move (pane → tab,
 * or tab → workspace) pushes one entry here; `MoveUndoToast` (mounted in
 * AppLayout, so it survives the navigation that follows a move) subscribes
 * and renders a transient toast with an Undo button.
 *
 * Modelled on `external-open-store` — same subscribe/dismiss/TTL shape — but
 * each entry carries a `run` callback (the reverse move) instead of a URL.
 */

export interface UndoEntry {
  id: number;
  message: string;
  /** Performs the reverse move. Awaited; the toast dismisses regardless. */
  run: () => Promise<void> | void;
  createdAt: number;
}

type Listener = (entries: UndoEntry[]) => void;

// One move at a time is the realistic case; cap so a burst can't pile up.
const MAX_PENDING = 4;
// A move-undo is a brief "oops, put it back" affordance — longer than a
// generic toast so there's time to react after the follow-navigation lands.
const TTL_MS = 9_000;

let nextId = 1;
let entries: UndoEntry[] = [];
const listeners = new Set<Listener>();
const expiryTimers = new Map<number, ReturnType<typeof setTimeout>>();

function emit(): void {
  for (const l of listeners) l(entries);
}

function clearExpiry(id: number): void {
  const t = expiryTimers.get(id);
  if (t) {
    clearTimeout(t);
    expiryTimers.delete(id);
  }
}

export function pushUndo(entry: { message: string; run: () => Promise<void> | void }): void {
  const next: UndoEntry = {
    id: nextId++,
    message: entry.message,
    run: entry.run,
    createdAt: Date.now(),
  };
  const combined = [...entries, next];
  if (combined.length > MAX_PENDING) {
    const dropped = combined.slice(0, combined.length - MAX_PENDING);
    for (const d of dropped) clearExpiry(d.id);
    entries = combined.slice(-MAX_PENDING);
  } else {
    entries = combined;
  }
  expiryTimers.set(
    next.id,
    setTimeout(() => dismissUndo(next.id), TTL_MS),
  );
  emit();
}

export function dismissUndo(id: number): void {
  const next = entries.filter((e) => e.id !== id);
  if (next.length === entries.length) return;
  entries = next;
  clearExpiry(id);
  emit();
}

export function getUndos(): UndoEntry[] {
  return entries;
}

export function subscribeUndos(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
