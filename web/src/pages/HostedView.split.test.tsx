import type { AppWithStatus, Artifact, PublicBaseInfo } from '@muxpad/shared';
import { act } from 'react';
import { type Root, createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { HostedState } from '../lib/hosted';

/**
 * TWO DESTINATIONS, NOT ONE CALLED "HOSTED".
 *
 * The page listed apps and artifacts together under one sidebar entry whose
 * label named the only property they share — having a URL. These assert the
 * split: each route shows ONE kind, says which privacy it has, and does not
 * leak the other kind's rows or the other kind's chrome onto the page.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const app = (name: string): AppWithStatus =>
  ({
    id: `app-${name}`,
    slug: name,
    name,
    url: `https://${name}.example:4322`,
    cwd: '/tmp',
    command: './start',
    state: 'running',
    pane_id: null,
  }) as unknown as AppWithStatus;

const artifact = (slug: string): Artifact =>
  ({
    slug,
    url: `https://pub.example/${slug}/`,
    created: 1_800_000_000_000,
    files: 1,
    bytes: 100,
    versions: [],
  }) as unknown as Artifact;

const BASE = {
  url: 'https://pub.example',
  reachable: true,
  durability: 'stable',
} as unknown as PublicBaseInfo;

const FULL: HostedState = {
  apps: [app('notes')],
  artifacts: [artifact('report')],
  base: BASE,
  loading: false,
  error: null,
  refresh: async () => {},
};
/** Read through a mutable binding so a test can swap the whole reading
 *  without a spy on a module it also imports from. */
let state: HostedState = FULL;

vi.mock('../lib/hosted', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, useHosted: () => state };
});
// The rows link with the router's <Link>; this view's identity is the heading
// and which rows it lists, not the routing, which the router's own test covers.
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children?: unknown }) => children,
  useNavigate: () => () => Promise.resolve(),
  useParams: () => ({ slug: 'notes' }),
}));

const { AppsView, ArtifactsView } = await import('./HostedView');

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  state = FULL;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const render = (el: React.ReactElement) => {
  act(() => root.render(el));
  return host;
};

const title = () => host.querySelector('.hosted-title')?.textContent;
const rows = () =>
  [...host.querySelectorAll('.hosted-row')].map((r) => r.getAttribute('data-kind'));

it('Artifacts lists published artifacts and no apps', () => {
  render(<ArtifactsView />);
  expect(title()).toBe('Artifacts');
  expect(rows()).toEqual(['artifact']);
});

it('Apps lists running apps and no artifacts', () => {
  render(<AppsView />);
  expect(title()).toBe('Apps');
  expect(rows()).toEqual(['app']);
});

it('says which privacy each kind has — the one thing a title cannot imply', () => {
  // "public" and "tailnet only" are the facts the undivided page carried
  // beside its two section headings. Losing them in the split would be the
  // whole cost of it: a reader who cannot tell publishing from serving.
  render(<ArtifactsView />);
  expect(host.querySelector('.hosted-section-note')?.textContent).toBe('public');
  expect(host.querySelector('.hosted-section-note-public')).not.toBeNull();
  act(() => root.render(<AppsView />));
  expect(host.querySelector('.hosted-section-note')?.textContent).toBe('tailnet only');
  expect(host.querySelector('.hosted-section-note-public')).toBeNull();
});

it('shows the public base on Artifacts only — an app has no public link', () => {
  // The base is where every artifact URL is built from, and its failure is
  // otherwise silent. On Apps it would be describing a link that does not
  // exist and must not be made to exist.
  //
  // Asserted on the ELEMENT, not on the hostname: an artifact row prints its
  // own URL from the same host, so a text match passes whether or not the
  // note rendered — which it did, with the note shown on both pages.
  render(<ArtifactsView />);
  expect(host.querySelector('.hosted-base')).not.toBeNull();
  act(() => root.render(<AppsView />));
  expect(host.querySelector('.hosted-base')).toBeNull();
});

it('each kind keeps its own empty state and its own command', () => {
  state = { ...FULL, apps: [], artifacts: [] };
  render(<ArtifactsView />);
  expect(host.textContent).toContain('Nothing published.');
  expect(host.textContent).toContain('muxpad publish');
  act(() => root.render(<AppsView />));
  expect(host.textContent).toContain('No apps registered.');
  expect(host.textContent).toContain('muxpad app add');
});
