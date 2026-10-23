import type { Tab, Workspace } from '@muxpad/shared';
import { Hono } from 'hono';

/**
 * `GET /api/boot?w=<workspace-slug>` — THE FIRST TWO RUNGS OF THE STAIRCASE,
 * in one answer, fetched before the bundle has finished parsing.
 *
 * ─── The measurement this exists for ──────────────────────────────────────
 *
 * A cold load with a 4× CPU throttle (a rough stand-in for a phone), on
 * loopback, with the JS already brotli'd down to 331 KB:
 *
 *    70–112  the bundle arrives
 *   227      the app's first request leaves          ← 115ms of parse + boot
 *   262      GET /api/workspaces?all=1
 *   327      GET /api/tabs?workspaceId=…             ← needs the id from above
 *   447      GET /api/tabs/:id                       ← needs the tab from above
 *
 * Three requests that cannot overlap, none of which can START until the
 * bundle has parsed and React has mounted. On loopback that staircase is
 * ~190ms; over a tailnet from a sofa it is three round trips, and the wait
 * before the first one is the whole of the bundle's parse.
 *
 * Neither half of that is about bytes, so neither was touched by the
 * compression work (json-cache.ts). This endpoint removes the first two rungs
 * for the one case that matters — somebody opening the cockpit — by being
 * ONE request that an inline script in the HTML can fire at about 10ms, while
 * the bundle is still downloading.
 *
 * ─── What it deliberately does NOT include ────────────────────────────────
 *
 * The third rung, `GET /api/tabs/:id`, which carries the active tab's panes.
 * That handler PRUNES dead panes and emits `tab.updated` when it does — a GET
 * that writes. Duplicating it here would mean two copies of a repair that
 * must not drift; composing it would mean a prefetch with a side effect, fired
 * by a `<script>` tag before the app exists. It stays where it is, and now
 * starts ~250ms earlier because the two rungs above it are already in hand.
 *
 * ─── Why slug and not id ──────────────────────────────────────────────────
 *
 * The inline script has only `location.pathname` (`/w/<slug>/t/<slug>`), and
 * resolving a slug costs the round trip this endpoint exists to remove. An
 * unknown or absent slug is not an error: the answer still carries the
 * workspace list (which the app always needs) with `workspaceId: null`, and
 * the client falls back to asking for the tabs itself.
 */
export interface BootPayload {
  /** Exactly what `GET /api/workspaces?all=1` answers. */
  workspaces: Workspace[];
  /** The id the slug resolved to, so the client can tell whether `tabs`
   *  belongs to the workspace it is about to render. Null when unresolved. */
  workspaceId: string | null;
  /** Exactly what `GET /api/tabs?workspaceId=<that>` answers. Empty when the
   *  slug did not resolve — NEVER a different workspace's list. */
  tabs: Tab[];
}

export function bootRoutes(deps: {
  /** The same list `GET /api/workspaces` returns, decorated identically. */
  listWorkspaces: (opts: { all: boolean }) => Workspace[];
  /** The same list `GET /api/tabs?workspaceId=` returns, in the same order. */
  listTabs: (workspaceId: string) => Tab[];
}): Hono {
  const app = new Hono();

  app.get('/', (c) => {
    // `all: true` — the client's own boot call is `?all=1`, and an answer that
    // omitted the hidden system workspaces would be a DIFFERENT list from the
    // one it is standing in for. A prefetch that is subtly not the real answer
    // is worse than no prefetch.
    const workspaces = deps.listWorkspaces({ all: true });
    const slug = c.req.query('w')?.trim();
    const match = slug ? workspaces.find((w) => w.slug === slug) : undefined;
    const payload: BootPayload = {
      workspaces,
      workspaceId: match?.id ?? null,
      tabs: match ? deps.listTabs(match.id) : [],
    };
    return c.json(payload);
  });

  return app;
}
