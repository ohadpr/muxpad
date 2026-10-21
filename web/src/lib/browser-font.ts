import { useEffect, useState } from 'react';

/** Same 14/16 rem scale as the app body, measured for xterm's pixel API. */
export function browserTerminalFontSize(): number {
  const root = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
  return (Number.isFinite(root) && root > 0 ? root : 16) * 0.875;
}

export function isBrowserZoomKey(
  event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey'>,
): boolean {
  return (
    (event.ctrlKey || event.metaKey) && !event.altKey && ['+', '=', '-', '0'].includes(event.key)
  );
}

/** A rem-sized probe changes dimensions when the browser's default font does.
 * Observing the viewport alone misses that change when its width stays fixed. */
export function useBrowserFontSize(): number {
  const [size, setSize] = useState(browserTerminalFontSize);
  useEffect(() => {
    const probe = document.createElement('span');
    probe.setAttribute('aria-hidden', 'true');
    probe.style.cssText =
      'position:fixed;visibility:hidden;pointer-events:none;width:1rem;height:1rem;inset:0;';
    document.body.appendChild(probe);
    const measure = () => setSize(browserTerminalFontSize());
    const observer = new ResizeObserver(measure);
    observer.observe(probe);
    measure();
    return () => {
      observer.disconnect();
      probe.remove();
    };
  }, []);
  return size;
}
