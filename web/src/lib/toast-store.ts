/**
 * Generic transient-toast pub/sub. Holds a list of items, each auto-expiring
 * after `ttlMs`; caps the list at `max`, dropping the OLDEST when over (fresh
 * entries better reflect current intent). The shared engine behind the
 * external-open and move-undo toast stores — both differ only in their item
 * shape, cap, and TTL.
 */
export interface ToastItem {
  id: number;
  createdAt: number;
}

export interface ToastStore<T extends ToastItem> {
  /** Add an item; `id`/`createdAt` are assigned here. */
  push(fields: Omit<T, 'id' | 'createdAt'>): void;
  dismiss(id: number): void;
  get(): T[];
  subscribe(listener: (items: T[]) => void): () => void;
}

export function createToastStore<T extends ToastItem>(opts: {
  max: number;
  ttlMs: number;
}): ToastStore<T> {
  let nextId = 1;
  let items: T[] = [];
  const listeners = new Set<(items: T[]) => void>();
  const timers = new Map<number, ReturnType<typeof setTimeout>>();

  const emit = (): void => {
    for (const l of listeners) l(items);
  };
  const clearTimer = (id: number): void => {
    const t = timers.get(id);
    if (t) {
      clearTimeout(t);
      timers.delete(id);
    }
  };
  const dismiss = (id: number): void => {
    const next = items.filter((i) => i.id !== id);
    if (next.length === items.length) return;
    items = next;
    clearTimer(id);
    emit();
  };
  const push = (fields: Omit<T, 'id' | 'createdAt'>): void => {
    const next = { ...fields, id: nextId++, createdAt: Date.now() } as T;
    const combined = [...items, next];
    if (combined.length > opts.max) {
      // Trimming the oldest: clear their expiry timers so they don't later
      // fire dismiss() on ids that no longer exist (harmless but wasteful).
      for (const d of combined.slice(0, combined.length - opts.max)) clearTimer(d.id);
      items = combined.slice(-opts.max);
    } else {
      items = combined;
    }
    timers.set(
      next.id,
      setTimeout(() => dismiss(next.id), opts.ttlMs),
    );
    emit();
  };

  return {
    push,
    dismiss,
    get: () => items,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
