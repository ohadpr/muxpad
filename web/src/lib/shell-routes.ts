/**
 * WHICH ROUTES ARE STILL "INSIDE" MUXPAD.
 *
 * AppLayout used to ask one question — is there a workspace in the URL? — and
 * answer it with the whole shell or nothing at all:
 *
 *   {wsSlug ? <app body, with the sidebar> : <Outlet />}
 *
 * That was right while the only workspace-less route was the picker at `/`,
 * which exists to redirect. Then Artifacts and Apps became destinations of
 * their own, and they inherited "nothing at all": a page with the top bar and
 * no rail, which reads as having left the application. Reported exactly that
 * way — "they feel like they are almost outside of the muxpad app".
 *
 * They are not outside it. They are two lists that belong to no workspace,
 * which is a different claim, and the rail is how you get back.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ───────────────────────────────────────────
 *   `/`              the picker, and a redirect. A rail that flashes up for
 *                    one frame on the way somewhere else is worse than none.
 *   `/hosted/a/:slug` an app's own web view, which is full-screen on purpose:
 *                    it is somebody else's page, and the chrome around it is
 *                    the thing you came to get away from.
 *   `/doc`, `/popout` their own windows, outside the layout entirely.
 */
const SHELL_PATHS = ['/artifacts', '/apps', '/activity'] as const;

/** Does this path want the sidebar even though it names no workspace? */
export function keepsShell(pathname: string): boolean {
  // Exact, or the path with a trailing slash. NOT a prefix test: `/apps`
  // must not claim `/hosted/a/…`, and a future `/apps/settings` should have
  // to opt in here rather than inherit silently.
  const clean = pathname.endsWith('/') && pathname.length > 1 ? pathname.slice(0, -1) : pathname;
  return (SHELL_PATHS as readonly string[]).includes(clean);
}
