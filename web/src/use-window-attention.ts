import { useEffect } from 'react';
import type { Tab } from '@muxpad/shared';

const FAVICON = '/favicon.svg';
const FAVICON_ATTENTION = '/favicon-attention.svg';

/**
 * Surface "any tab needs attention" at the browser-tab level by swapping
 * the favicon to an alert-colored variant. Reverts when nothing is
 * flagged. Doesn't touch document.title to avoid fighting per-page title
 * hooks.
 */
export function useWindowAttention(tabs: Tab[]): void {
  const anyAttention = tabs.some((t) => t.attention);

  useEffect(() => {
    const link = document.querySelector('link[rel="icon"]') as HTMLLinkElement | null;
    if (link) link.href = anyAttention ? FAVICON_ATTENTION : FAVICON;
  }, [anyAttention]);
}
