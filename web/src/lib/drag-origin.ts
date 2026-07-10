/**
 * Module-level drag-origin mirror, one per drag family (tab drags, pane
 * drags). `dataTransfer.getData` is unreadable during dragover (only
 * `types` is exposed), so a drop target can't tell from the event alone
 * whether the dragged thing came from ITSELF (a no-op). The drag's start
 * handler mirrors the origin here (cleared on dragend); drop targets use
 * it only to gate the hover affordance — the drop itself always reads the
 * real payload. One factory so lifecycle fixes apply to every family.
 */
export function createDragOrigin<T>(): { set(origin: T | null): void; get(): T | null } {
  let active: T | null = null;
  return {
    set(origin: T | null): void {
      active = origin;
    },
    get(): T | null {
      return active;
    },
  };
}
