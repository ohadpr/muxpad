import type { Tab, Workspace } from '@muxpad/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { useAllChats } from './use-all-chats';

const store = vi.hoisted(() => ({ tabs: [] as Tab[] }));
const workspaces = vi.hoisted(() => [{ id: 'w', slug: 'w', name: 'Work' }] as Workspace[]);
vi.mock('../tabs', () => ({ cachedTabsFor: () => store.tabs }));
vi.mock('../workspaces', () => ({
  useWorkspaces: () => ({ workspaces }),
  visibleWorkspaces: (rows: Workspace[]) => rows,
}));
vi.mock('./all-tabs', () => ({
  cachedAllTabs: () => null,
  loadAllTabs: async () => [],
  subscribeAllTabs: () => () => {},
}));

const tab = (id: string, corpus_live: boolean, done = false) => ({ id, corpus_live, done }) as Tab;
let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLDivElement | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  vi.unstubAllGlobals();
});

it('filters full workspace history before the corpus lands, keeping memo identity until the cache changes', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  store.tabs = [tab('history', false, true), tab('retired-owner', true, true)];
  const seen: ReturnType<typeof useAllChats>[] = [];
  function Probe({ tick }: { tick: number }) {
    seen.push(useAllChats());
    return <span>{tick}</span>;
  }
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(<Probe tick={1} />));
  const first = seen.at(-1)!;
  expect(first[0]?.tabs.map((t) => t.id)).toEqual(['retired-owner']);
  await act(async () => root!.render(<Probe tick={2} />));
  expect(seen.at(-1)).toBe(first);
  store.tabs = [tab('history', false, true), tab('retired-owner', false, true), tab('new', true)];
  await act(async () => root!.render(<Probe tick={3} />));
  expect(seen.at(-1)).not.toBe(first);
  expect(seen.at(-1)?.[0]?.tabs.map((t) => t.id)).toEqual(['new']);
});
