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
 * BOTH SURFACES are rendered and read here — the desktop rail and the mobile
 * sheet. That is only possible because the sheet's copy MOVED: it used to sit
 * in the workspace picker, so on a phone these were two taps deep inside a
 * list whose question is "which workspace", and a render of the sheet found no
 * foot at all. It is now at the foot of the sheet's own list, which is also
 * why this file can assert it rather than grep for it.
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
  // NavTree reads the path to decide whether a view PAGE owns the list's view
  // (railViewFor). These suites render beside a chat, which is the path that
  // leaves the stored view in charge.
  useRouterState: ({ select }: { select: (s: unknown) => unknown }) =>
    select({ location: { pathname: '/w/w1/t/a' } }),
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

it('puts no foot on the desktop list — Artifacts and Apps are entries of the destination rail', () => {
  expect(foot('sidebar')).toEqual([]);
});

it.each(['sheet'] as const)('lists Artifacts then Apps first on the %s', (variant) => {
  // ARTIFACTS FIRST: it is the half reached by the question that gets asked
  // (the same portal was asked for three times in five days), and the half
  // whose contents expire — a reason to meet the list rather than recall it.
  //
  // THE SHEET CASE IS THE REGRESSION. It answered with an empty list while
  // the foot lived in the workspace picker, which is exactly what "where do I
  // see artifacts on mobile" turned out to mean.
  expect(foot(variant).slice(0, 2)).toEqual([
    { href: '/artifacts', text: 'Artifacts' },
    { href: '/apps', text: 'Apps' },
  ]);
});

it('offers no Activity entry — the desktop rail’s Home | Unread | Activity switcher is the way in', () => {
  for (const variant of ['sidebar', 'sheet'] as const)
    expect(foot(variant).map((l) => l.href)).not.toContain('/activity');
});

it('no longer offers a single "Hosted" entry', () => {
  for (const variant of ['sidebar', 'sheet'] as const) {
    expect(foot(variant).map((l) => l.text)).not.toContain('Hosted');
    expect(foot(variant).map((l) => l.href)).not.toContain('/hosted');
  }
});

it('is mounted once — the sheet — and not in the picker', () => {
  // The desktop rail's mount went when Artifacts and Apps moved into the
  // destination rail (components/DestinationRail). A second here would be the
  // workspace picker getting it back, which is where it was hiding on mobile.
  const src = readFileSync(join(__dirname, 'NavTree.tsx'), 'utf8');
  expect(src.match(/<HostedFoot/g) ?? []).toHaveLength(1);
  expect(src).not.toContain('to="/hosted"');
});
