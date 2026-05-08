import { useEffect } from 'react';
import type { Workspace } from '@muxpad/shared';

const FAVICON = '/favicon.svg';
const FAVICON_ATTENTION = '/favicon-attention.svg';

/**
 * Surface "any workspace needs attention" at the browser-tab level by
 * swapping the favicon to an alert-colored variant. Reverts when nothing
 * is flagged. (We intentionally don't touch document.title — the page
 * title shows the workspace name, and a prefix there fights with the
 * per-page useDocumentTitle hooks.)
 */
export function useWindowAttention(workspaces: Workspace[]): void {
  const anyAttention = workspaces.some((w) => w.attention);

  useEffect(() => {
    const link = document.querySelector('link[rel="icon"]') as HTMLLinkElement | null;
    if (link) link.href = anyAttention ? FAVICON_ATTENTION : FAVICON;
  }, [anyAttention]);
}
