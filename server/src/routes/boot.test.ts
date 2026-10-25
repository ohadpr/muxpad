import type { Tab, Workspace } from '@muxpad/shared';
import { describe, expect, it, vi } from 'vitest';
import { bootRoutes } from './boot.js';

/**
 * The contract is ONE sentence: this must answer exactly what the two
 * endpoints it stands in for would answer. A prefetch that is subtly a
 * different list makes the sidebar render once and then rearrange itself,
 * which is worse than the round trip it saved.
 */

const ws = (id: string, slug: string, over: Partial<Workspace> = {}): Workspace =>
  ({ id, slug, name: slug, ...over }) as Workspace;
/** A Tab row carries no workspace id of its own — the LIST is what scopes it,
 *  which is exactly why the payload has to state the workspace separately. */
const tab = (id: string): Tab => ({ id }) as unknown as Tab;

const WORKSPACES = [ws('w1', 'personal'), ws('w2', 'work'), ws('w3', 'hidden', { hidden: true })];

function app(over: Partial<Parameters<typeof bootRoutes>[0]> = {}) {
  return bootRoutes({
    listWorkspaces: () => WORKSPACES,
    listTabs: (id) => [tab(`${id}-a`), tab(`${id}-b`)],
    ...over,
  });
}

const get = async (path: string) => {
  // `app.fetch` can answer synchronously for a handler that does no awaiting,
  // so it is not always a promise — await the call, don't chain it.
  const res = await app().fetch(new Request(`http://local${path}`));
  return res.json();
};

describe('GET /api/boot', () => {
  it('answers the workspace list and the named workspace’s tabs in one', async () => {
    const body = (await get('/?w=personal')) as {
      workspaces: Workspace[];
      workspaceId: string;
      tabs: Tab[];
    };
    expect(body.workspaces.map((w) => w.slug)).toEqual(['personal', 'work', 'hidden']);
    expect(body.workspaceId).toBe('w1');
    expect(body.tabs.map((t) => t.id)).toEqual(['w1-a', 'w1-b']);
  });

  it('includes HIDDEN workspaces, because the call it replaces asks for ?all=1', async () => {
    // A prefetch that quietly omitted them would be a different list from the
    // one the app is standing in for, and a direct URL into a hidden
    // workspace would stop resolving.
    const seen: Array<{ all: boolean }> = [];
    const res = await app({
      listWorkspaces: (opts) => {
        seen.push(opts);
        return WORKSPACES;
      },
    }).fetch(new Request('http://local/?w=personal'));
    expect(res.status).toBe(200);
    expect(seen).toEqual([{ all: true }]);
  });

  it('still answers the workspace list when the path names no workspace', async () => {
    const body = (await get('/')) as { workspaces: Workspace[]; workspaceId: null; tabs: Tab[] };
    expect(body.workspaces).toHaveLength(3);
    expect(body.workspaceId).toBeNull();
    expect(body.tabs).toEqual([]);
  });

  it('NEVER answers another workspace’s tabs for an unknown slug', async () => {
    const body = (await get('/?w=nope')) as { workspaceId: null; tabs: Tab[] };
    expect(body.workspaceId).toBeNull();
    expect(body.tabs).toEqual([]);
  });

  it('does not read the tab list at all when the slug does not resolve', async () => {
    const listTabs = vi.fn(() => []);
    await app({ listTabs }).fetch(new Request('http://local/?w=nope'));
    expect(listTabs).not.toHaveBeenCalled();
  });

  it('names the workspace its tabs belong to, so the client can check', async () => {
    // A Tab row does not say which workspace it is in, so without this field
    // the client could not tell a prefetched list for workspace A from one for
    // workspace B — and would happily render the wrong sidebar.
    const body = (await get('/?w=work')) as { workspaceId: string; tabs: Tab[] };
    expect(body.workspaceId).toBe('w2');
    expect(body.tabs.map((t) => t.id)).toEqual(['w2-a', 'w2-b']);
  });
});
