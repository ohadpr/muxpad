import type Database from 'better-sqlite3';
import { Hono } from 'hono';
import { NodeStore } from '../store/NodeStore.js';

/**
 * READ-ONLY, for now, and deliberately.
 *
 * A node can be added by the CLI (which holds the data dir and can write the
 * token), and the plan's Settings → Machines will drive this. What it must NOT
 * grow before the lifecycle routing exists is a POST: creating a node row is
 * what makes `panes.node_id` able to point somewhere remote, and an
 * adversarial review of the build plan was explicit that nothing may create a
 * remote pane row until EVERY lifecycle operation is node-aware — otherwise
 * the pane-recovery sweep sees a remote pane as a missing local one and
 * restarts the conversation on the wrong machine.
 *
 * So this exists to make the model VISIBLE while that work is done, and the
 * absence of a write route here is a safety property rather than an oversight.
 */
export function nodesRoutes(deps: { db: Database.Database }): Hono {
  const app = new Hono();

  app.get('/', (c) => {
    const nodes = new NodeStore(deps.db);
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

  return app;
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
