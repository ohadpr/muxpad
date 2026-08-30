import type { Workspace } from '@muxpad/shared';
import { useEffect } from 'react';

const FAVICON = '/favicon.svg';
const FAVICON_ATTENTION = '/favicon-attention.svg';

/**
 * Surface "anything in this browser session needs attention" by swapping
 * the favicon to an alert-colored variant. Reads from the workspace list
 * (which carries a server-side per-workspace rollup) rather than the
 * current workspace's tabs — so a browser tab parked on Workspace A still
 * shows the bell when a pane in Workspace B fires BEL. Doesn't touch
 * document.title to avoid fighting per-page title hooks.
 */
export function useWindowAttention(workspaces: Workspace[]): void {
  const anyAttention = workspaces.some((w) => w.attention);

  useEffect(() => {
    const link = document.querySelector('link[rel="icon"]') as HTMLLinkElement | null;
    if (link) link.href = anyAttention ? FAVICON_ATTENTION : FAVICON;
  }, [anyAttention]);
}
