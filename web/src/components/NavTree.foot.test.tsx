import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Workspace } from '@muxpad/shared';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';

/**
 * THE FOOT — two destinations, not one called "Hosted".
 *
 * The rail carried a single entry whose label named the only property its two
 * contents share: having a URL. "Where is the thing I made" and "is that
 * server up" are the questions people actually arrive with, and neither was
 * answered by that word. The reasoning in full is in pages/HostedView.
 *
 * TWO SURFACES mount it — the desktop rail and the sheet's workspace picker —
 * and the sheet's copy was its own duplicated block that has been forgotten
 * in a change before. The rail's is rendered and read; the sheet's is
 * asserted on the source, because reaching it means driving the picker open
 * and the subject here is the destinations, not that interaction.
 */
vi.mock('@tanstack/react-router', () => ({
  // An <a> with a real href here, unlike the span stub the row tests use: the
  // DESTINATION is the subject of this file.
  Link: ({
    children,
    className,
    to,
  }: { children?: ReactNode; className?: string; to?: string }) => (
    <a className={className} href={to}>
      {children}
    </a>
  ),
  useNavigate: () => () => {},
}));
vi.mock('../tabs', () => ({
  useTabs: () => ({ tabs: [], refresh: async () => {} }),
  refreshTabs: async () => {},
  applyTabOrder: () => {},
  applyTabUnread: () => {},
}));
vi.mock('../workspaces', () => ({
  useWorkspaces: () => ({ workspaces: [] as Workspace[], refresh: async () => [] }),
  visibleWorkspaces: () => [],
  refreshWorkspaces: async () => {},
  applyWorkspaceOrder: () => {},
}));
vi.mock('../lib/nav-expansion', () => ({
  useNavExpansion: () => ({ isExpanded: () => false, toggle: () => {}, setExpanded: () => {} }),
}));

const { NavTree } = await import('./NavTree');

const foot = (variant: 'sidebar' | 'sheet') => {
  const html = renderToStaticMarkup(
    <NavTree activeWorkspaceSlug="personal" activeTabSlug={null} variant={variant} />,
  );
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return [...doc.querySelectorAll('.navtree-foot-link')].map((a) => ({
    href: a.getAttribute('href'),
    text: a.textContent?.trim(),
  }));
};

it('lists Artifacts then Apps', () => {
  // ARTIFACTS FIRST: it is the half reached by the question that gets asked
  // (the same portal was asked for three times in five days), and the half
  // whose contents expire — a reason to meet the list rather than recall it.
  expect(foot('sidebar')).toEqual([
    { href: '/artifacts', text: 'Artifacts' },
    { href: '/apps', text: 'Apps' },
  ]);
});

it('no longer offers a single "Hosted" entry', () => {
  expect(foot('sidebar').map((l) => l.text)).not.toContain('Hosted');
  expect(foot('sidebar').map((l) => l.href)).not.toContain('/hosted');
});

it('is mounted by both surfaces, from one definition', () => {
  // One component, two mounts. It was two copies of the same markup, and a
  // duplicated foot is how one surface keeps an entry the other dropped.
  const src = readFileSync(join(__dirname, 'NavTree.tsx'), 'utf8');
  expect(src.match(/<HostedFoot/g) ?? []).toHaveLength(2);
  expect(src).not.toContain('to="/hosted"');
});
