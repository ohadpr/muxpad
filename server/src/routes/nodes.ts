import type Database from 'better-sqlite3';
import { Hono } from 'hono';
import { z } from 'zod';
import { removeNodeToken, writeNodeToken } from '../node-link/node-tokens.js';
import { LOCAL_NODE_ID, NodeStore } from '../store/NodeStore.js';

/**
 * THE MACHINES muxpad KNOWS ABOUT, and pairing them.
 *
 * ── THE WRITE ROUTES WERE HELD BACK, AND WHY THEY ARE HERE NOW ───────────
 * This was read-only on purpose: creating a node row is what makes
 * `panes.node_id` able to point somewhere remote, and an adversarial review
 * of the build plan was explicit that nothing may create a remote pane row
 * until EVERY lifecycle operation is node-aware — otherwise the pane-recovery
 * sweep sees a remote pane as a missing local one and restarts the
 * conversation on the wrong machine.
 *
 * That work is done and proven on a real second machine: spawn, attach, kill,
 * the kill queue, resume repair, the transcript chokepoint, the host API, the
 * archive. So the gate is lifted — and the absence of these routes had become
 * the last thing standing between "one machine I wired by hand" and
 * multi-machine muxpad.
 *
 * ── THIS MACHINE ISSUES THE CREDENTIAL; THE OTHER IS INSTALLED WITH IT ───
 * `POST` mints the token and writes it here, then hands back the ONE line to
 * run over there. The opposite order — install the agent, then pair it —
 * leaves an unauthenticated listener on a shared tailnet for however long that
 * takes, and the tailnet this was built for has other people's dev VMs on it.
 *
 * ── NO RESTART ───────────────────────────────────────────────────────────
 * `onChanged` re-syncs the live links, so a machine added here is dialled
 * seconds later. A pairing flow that ended in "now restart muxpad" would be
 * worse than the manual one, because a restart drops every runner's socket.
 */

/** A node id is a filesystem name (its token lives at `node-tokens/<id>`) and
 *  goes into a WS url. Strict, and `local` is reserved. */
const NODE_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export function nodesRoutes(deps: {
  db: Database.Database;
  dataDir?: string;
  /** Re-dial after the table changed. Absent in tests that only read. */
  onChanged?: () => void;
  /** The port a paired agent should listen on, for the printed command. */
  agentPort?: number;
}): Hono {
  const app = new Hono();
  const store = () => new NodeStore(deps.db);

  app.get('/', (c) => {
    const nodes = store();
    const counts = nodes.paneCounts();
    return c.json({
      nodes: nodes.list().map((n) => ({
        ...n,
        capabilities: n.capabilities ? safeParse(n.capabilities) : null,
        panes: counts.get(n.id) ?? 0,
      })),
      // So a client can render the single-machine case as "nothing to see"
      // without counting rows and guessing what `local` means.
      multiNode: nodes.isMultiNode(),
    });
  });

  /**
   * Pair a machine: mint its credential and say what to run there.
   *
   * The token comes back in THIS RESPONSE and nowhere else in the API — it has
   * to be typed on the other machine, and that is the only moment anyone needs
   * to see it. (It is also on this machine's disk at 0600, which is where
   * every dial reads it from; the point is that no later GET serves it.)
   */
  app.post('/', async (c) => {
    const parsed = z
      .object({
        id: z.string(),
        name: z.string().optional(),
        /** `ws://host:7797` or `wss://…`. The agent's own base; `/control` and
         *  `/link` are appended by the two link classes. */
        endpoint: z.string(),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success)
      return c.json({ error: { code: 'invalid_request', message: 'id and endpoint' } }, 400);
    const { id, endpoint } = parsed.data;
    if (!NODE_ID.test(id) || id === LOCAL_NODE_ID)
      return c.json(
        {
          error: {
            code: 'invalid_request',
            message: `id must match ${NODE_ID.source} and not be "${LOCAL_NODE_ID}"`,
          },
        },
        400,
      );
    const url = parseEndpoint(endpoint);
    if (!url)
      return c.json(
        { error: { code: 'invalid_request', message: 'endpoint must be ws:// or wss://' } },
        400,
      );
    const nodes = store();
    if (nodes.get(id))
      return c.json({ error: { code: 'conflict', message: `${id} already exists` } }, 409);

    const token = writeNodeToken(id, deps.dataDir);
    const node = nodes.add({ id, name: parsed.data.name?.trim() || id, endpoint: url });
    deps.onChanged?.();
    return c.json(
      {
        node,
        token,
        // The other machine needs the repo and a build — muxpad-node is part
        // of the server package — so this is the step AFTER that, not an
        // installer. Named `init` because that is the CLI verb it is.
        install: `muxpad node init --token=${token}`,
      },
      201,
    );
  });

  /** Rename, or re-point at a new address. */
  app.patch('/:id', async (c) => {
    const id = c.req.param('id');
    const nodes = store();
    if (id === LOCAL_NODE_ID)
      return c.json(
        { error: { code: 'invalid_request', message: 'this machine is not configurable' } },
        400,
      );
    if (!nodes.get(id))
      return c.json({ error: { code: 'not_found', message: 'no such machine' } }, 404);
    const parsed = z
      .object({ name: z.string().optional(), endpoint: z.string().optional() })
      .strict()
      .safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success)
      return c.json({ error: { code: 'invalid_request', message: 'name or endpoint' } }, 400);
    let endpoint: string | undefined;
    if (parsed.data.endpoint !== undefined) {
      const url = parseEndpoint(parsed.data.endpoint);
      if (!url)
        return c.json(
          { error: { code: 'invalid_request', message: 'endpoint must be ws:// or wss://' } },
          400,
        );
      endpoint = url;
    }
    nodes.update(id, {
      ...(parsed.data.name !== undefined ? { name: parsed.data.name.trim() || id } : {}),
      ...(endpoint !== undefined ? { endpoint } : {}),
    });
    deps.onChanged?.();
    return c.json({ node: nodes.get(id) });
  });

  /**
   * Forget a machine.
   *
   * REFUSED WHILE IT STILL HOLDS CHATS, unless `?force=1`. Dropping the row
   * under a live pane is the specific thing the whole node model exists to
   * prevent: `nodeForPane` would answer `local` for it, and the next recovery
   * sweep would restart that conversation ON THIS MACHINE — a chat silently
   * moved to the wrong computer, which is worse than a refusal you can read.
   *
   * `force` is for the real case where it is right: the machine is gone for
   * good and its chats are going with it. It deletes the panes' rows first,
   * so nothing is left pointing at a node that does not exist.
   */
  app.delete('/:id', (c) => {
    const id = c.req.param('id');
    if (id === LOCAL_NODE_ID)
      return c.json(
        { error: { code: 'invalid_request', message: 'this machine cannot be removed' } },
        400,
      );
    const nodes = store();
    if (!nodes.get(id))
      return c.json({ error: { code: 'not_found', message: 'no such machine' } }, 404);
    const panes = nodes.paneCounts().get(id) ?? 0;
    const force = c.req.query('force') === '1';
    if (panes > 0 && !force)
      return c.json(
        {
          error: {
            code: 'conflict',
            message: `${panes} ${panes === 1 ? 'chat' : 'chats'} still live on that machine — move or delete them, or pass force=1 to delete them with it`,
          },
        },
        409,
      );
    if (panes > 0) deps.db.prepare('DELETE FROM panes WHERE node_id = ?').run(id);
    nodes.remove(id);
    // Revocation is not closure: removing the token stops the next dial, and
    // `onChanged` is what actually drops the socket that is open now.
    removeNodeToken(id, deps.dataDir);
    deps.onChanged?.();
    return c.body(null, 204);
  });

  return app;
}

/**
 * Normalise an endpoint, or null.
 *
 * Accepts `ws://`/`wss://` and tolerates `http(s)://`, because that is what
 * anybody copying a browser url will paste — the two link classes build their
 * own `ws` url from it anyway. Anything else (a bare host, a path, a
 * credential in the url) is refused rather than guessed at: a node endpoint
 * that is almost right fails as "machine unreachable", which is the least
 * debuggable outcome available.
 */
function parseEndpoint(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  const scheme = u.protocol === 'http:' ? 'ws:' : u.protocol === 'https:' ? 'wss:' : u.protocol;
  if (scheme !== 'ws:' && scheme !== 'wss:') return null;
  if (!u.hostname || u.username || u.password) return null;
  // Path and query are dropped: `/control` and `/link` are appended by the
  // clients, so a pasted path would produce `/control/control`.
  return `${scheme}//${u.host}`;
}

/** Capabilities are whatever an agent reported; unparseable is null, never a
 *  throw — this is a UI row, and a machine that described itself oddly must
 *  not take out the list it appears in. */
function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
