import { expect, it, vi } from 'vitest';
import { router } from './router';

/**
 * "HOSTED" BECAME TWO DESTINATIONS, and the old URL has to keep answering.
 *
 * /hosted is in transcripts, in published reports and in muscle memory, so it
 * redirects rather than 404s. The app's own deep link to an app's full-screen
 * view (/hosted/a/:slug) is NOT part of that rename and must keep matching —
 * a redirect written as a prefix would have swallowed it.
 */
vi.mock('./components/AppLayout', () => ({ AppLayout: () => null }));
vi.mock('./components/WorkspaceLayout', () => ({ WorkspaceLayout: () => null }));
vi.mock('./pages/DocView', () => ({ DocView: () => null }));
vi.mock('./pages/HostedView', () => ({
  ArtifactsView: () => null,
  AppsView: () => null,
  HostedAppView: () => null,
}));
vi.mock('./pages/PopoutView', () => ({ PopoutView: () => null }));
vi.mock('./pages/RootRedirect', () => ({ RootRedirect: () => null }));

const leaf = (path: string) => router.matchRoutes(path, {}).at(-1);

it('routes /artifacts and /apps to their own views', () => {
  expect(leaf('/artifacts')?.routeId).toBe('/_app/artifacts');
  expect(leaf('/apps')?.routeId).toBe('/_app/apps');
});

it('sends /hosted to Artifacts rather than 404ing on it', () => {
  expect(leaf('/hosted')?.routeId).toBe('/_app/hosted');
  // Matching is not redirecting. The route's whole body is the throw, so it
  // is called directly: a /hosted that resolved to a blank page would satisfy
  // the match assertion above and nothing else.
  const route = router.routesById['/_app/hosted' as keyof typeof router.routesById];
  const beforeLoad = (route as { options?: { beforeLoad?: () => void } }).options?.beforeLoad;
  expect(beforeLoad, 'no beforeLoad on /hosted').toBeTypeOf('function');
  let thrown: unknown;
  try {
    beforeLoad?.();
  } catch (err) {
    thrown = err;
  }
  // ARTIFACTS, not Apps: "link to the thing I made" is the question that
  // brings somebody to this URL. TanStack throws a 307 Response carrying the
  // redirect options, so the destination is read off the thrown object rather
  // than matched as a plain literal.
  expect(thrown).toBeInstanceOf(Response);
  expect((thrown as { options?: { to?: string; replace?: boolean } }).options).toMatchObject({
    to: '/artifacts',
    replace: true,
  });
});

it("keeps an app's own full-screen route, which the rename does not touch", () => {
  // The redirect is on the exact path. Written as a prefix it would have
  // eaten this, and the one screen that can restart a dead app with it.
  const m = leaf('/hosted/a/notes');
  expect(m?.routeId).toBe('/_app/hosted/a/$slug');
  expect(m?.params).toMatchObject({ slug: 'notes' });
});
