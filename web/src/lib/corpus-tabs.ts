import type { Tab } from '@muxpad/shared';

/** Server-owned membership, including retired chats that still own live work.
 * Absence preserves compatibility with servers predating the structural corpus. */
export function isCorpusLive(tab: Tab): boolean {
  return tab.corpus_live !== false;
}

const projections = new WeakMap<readonly Tab[], Tab[]>();

/** Stable identity matters to useAllChats when it falls back to workspace lists. */
export function corpusTabs(tabs: readonly Tab[]): Tab[] {
  const held = projections.get(tabs);
  if (held) return held;
  const live = tabs.filter(isCorpusLive);
  projections.set(tabs, live);
  return live;
}
