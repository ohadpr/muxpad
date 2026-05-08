import { useEffect, useRef, useState } from 'react';

/**
 * Watches an element for horizontal overflow (its content doesn't fit in
 * its visible width) and returns a boolean. Used to switch between a
 * full row of tabs and a single dropdown when the bar gets cramped.
 *
 * The element should always render its full content for measurement —
 * hide it with visibility: hidden when the dropdown is shown rather than
 * not rendering, so the next "do we still overflow?" check has something
 * to measure. Otherwise we'd flip-flop the moment we collapse.
 */
export function useHorizontalOverflow<T extends HTMLElement>(
  // dependencies that should retrigger measurement (e.g. number of tabs)
  deps: ReadonlyArray<unknown> = [],
): { ref: React.MutableRefObject<T | null>; overflowing: boolean } {
  const ref = useRef<T | null>(null);
  const [overflowing, setOverflowing] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      // +1 to ignore sub-pixel rounding noise.
      setOverflowing(el.scrollWidth > el.clientWidth + 1);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    // Also observe the parent — clientWidth changes when the parent
    // resizes too, which ResizeObserver on the element itself misses
    // when the element is full-width and just clipping internally.
    if (el.parentElement) ro.observe(el.parentElement);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { ref, overflowing };
}
