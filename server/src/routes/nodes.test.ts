import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PaneStore } from '../store/PaneStore.js';
import { TabStore } from '../store/TabStore.js';
import { WorkspaceStore } from '../store/WorkspaceStore.js';
import { openDb } from '../store/db.js';
import { nodesRoutes } from './nodes.js';

/**
 * PAIRING A MACHINE.
 *
 * The write routes were held back on purpose while the lifecycle was made
 * node-aware (see the file's own note). What they must get right now:
 *
 *   · the credential is minted HERE and lands at 0600 — the other machine is
 *     installed with it, never the other way round;
 *   · a machine that still holds panes cannot be forgotten by accident,
 *     because dropping the row under a live pane is how a chat silently moves
 *     to the wrong computer;
 *   · `local` is neither configurable nor removable;
 *   · every write re-syncs the live links, so pairing never ends in "restart
 *     muxpad" — which would drop every runner's socket.
 */

let dir: string;
let db: Database.Database;
let app: Hono;
let changed: number;

const post = (body: unknown) =>
  app.request('/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const patch = (id: string, body: unknown) =>
  app.request(`/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'muxpad-nodes-'));
  db = openDb(join(dir, 'db.sqlite'));
  changed = 0;
  app = nodesRoutes({
    db,
    dataDir: dir,
    onChanged: () => {
      changed += 1;
    },
  });
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const tokenPath = (id: string) => join(dir, 'node-tokens', id);

describe('pairing', () => {
  it('mints a credential, writes it 0600, and says what to run over there', async () => {
    const res = await post({ id: 'trayo', name: 'Trayo dev VM', endpoint: 'ws://vm:7797' });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { token: string; install: string; node: { name: string } };
    expect(body.token).toMatch(/^[0-9a-f]{64}$/);
    expect(body.install).toContain(body.token);
    expect(body.node.name).toBe('Trayo dev VM');
    // The file IS the authentication for a whole machine.
    expect(readFileSync(tokenPath('trayo'), 'utf8').trim()).toBe(body.token);
    expect(statSync(tokenPath('trayo')).mode & 0o777).toBe(0o600);
    // And the links re-dial without a restart.
    expect(changed).toBe(1);
  });

  it('names a machine by its id when no name is given', async () => {
    const body = (await (await post({ id: 'vm2', endpoint: 'ws://x:7797' })).json()) as {
      node: { name: string };
    };
    expect(body.node.name).toBe('vm2');
  });

  it('normalises the address and drops a pasted path', async () => {
    // `/control` and `/link` are appended by the two link classes, so a pasted
    // path would produce `/control/control`.
    const body = (await (
      await post({ id: 'vm3', endpoint: 'https://host.ts.net:7797/control?x=1' })
    ).json()) as { node: { endpoint: string } };
    expect(body.node.endpoint).toBe('wss://host.ts.net:7797');
  });

  it('refuses an id that is not a filesystem name — it becomes a filename', async () => {
    for (const id of ['../etc', 'Trayo', 'a b', '', 'x'.repeat(40), 'трayo']) {
      const res = await post({ id, endpoint: 'ws://x:7797' });
      expect(res.status, id).toBe(400);
    }
    expect(existsSync(join(dir, 'node-tokens'))).toBe(false);
  });

  it('refuses to pair a second machine called `local`', async () => {
    expect((await post({ id: 'local', endpoint: 'ws://x:7797' })).status).toBe(400);
  });

  it('refuses an address that is not a websocket one', async () => {
    for (const endpoint of ['host:7797', 'ftp://x', 'ws://user:pw@x', 'not a url', '']) {
      expect((await post({ id: 'vm', endpoint })).status, endpoint).toBe(400);
    }
  });

  it('refuses a duplicate rather than re-minting over a live credential', async () => {
    await post({ id: 'trayo', endpoint: 'ws://vm:7797' });
    const first = readFileSync(tokenPath('trayo'), 'utf8');
    expect((await post({ id: 'trayo', endpoint: 'ws://vm:7797' })).status).toBe(409);
    expect(readFileSync(tokenPath('trayo'), 'utf8')).toBe(first);
  });
});

describe('re-pointing and renaming', () => {
  beforeEach(async () => {
    await post({ id: 'trayo', name: 'VM', endpoint: 'ws://old:7797' });
    db.prepare(
      "UPDATE nodes SET state = 'up', capabilities = '{\"shell\":\"/bin/bash\"}' WHERE id = 'trayo'",
    ).run();
    changed = 0;
  });

  it('re-points and forgets what the OLD address told us', async () => {
    const res = await patch('trayo', { endpoint: 'ws://new:7797' });
    expect(res.status).toBe(200);
    const row = db.prepare('SELECT * FROM nodes WHERE id = ?').get('trayo') as {
      endpoint: string;
      state: string;
      capabilities: string | null;
    };
    expect(row.endpoint).toBe('ws://new:7797');
    // Both described whatever answered at the old address. Carrying them over
    // would show a reachable Linux box at an endpoint nothing has dialled.
    expect(row.state).toBe('unknown');
    expect(row.capabilities).toBe(null);
    expect(changed).toBe(1);
  });

  it('renames without touching reachability', async () => {
    await patch('trayo', { name: 'Trayo dev VM' });
    const row = db.prepare('SELECT * FROM nodes WHERE id = ?').get('trayo') as {
      name: string;
      state: string;
    };
    expect(row.name).toBe('Trayo dev VM');
    expect(row.state).toBe('up');
  });

  it('will not configure this machine', async () => {
    expect((await patch('local', { name: 'nope' })).status).toBe(400);
  });

  it('404s a machine that is not there', async () => {
    expect((await patch('ghost', { name: 'x' })).status).toBe(404);
  });
});

describe('forgetting a machine', () => {
  const paneOn = (nodeId: string) => {
    const ws = new WorkspaceStore(db).create({ name: 'W' }).id;
    const tab = new TabStore(db).create({ name: 'T', layout: '', workspace_id: ws }).id;
    const pane = new PaneStore(db).create({ tab_id: tab, shell: '/bin/bash' }).id;
    db.prepare('UPDATE panes SET node_id = ? WHERE id = ?').run(nodeId, pane);
    return pane;
  };

  beforeEach(async () => {
    await post({ id: 'trayo', endpoint: 'ws://vm:7797' });
    changed = 0;
  });

  it('removes the row AND the credential', async () => {
    const res = await app.request('/trayo', { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect(db.prepare('SELECT 1 FROM nodes WHERE id = ?').get('trayo')).toBeUndefined();
    expect(existsSync(tokenPath('trayo'))).toBe(false);
    // Revocation is not closure — `onChanged` is what drops the open socket.
    expect(changed).toBe(1);
  });

  it('REFUSES while chats still live there, and says how many', async () => {
    // Dropping the row under a live pane makes `nodeForPane` answer `local`
    // for it, and the next recovery sweep restarts that conversation on THIS
    // machine. A chat silently moved to the wrong computer is worse than a
    // refusal you can read.
    paneOn('trayo');
    const res = await app.request('/trayo', { method: 'DELETE' });
    expect(res.status).toBe(409);
    expect(JSON.stringify(await res.json())).toContain('1 chat');
    expect(existsSync(tokenPath('trayo'))).toBe(true);
    expect(changed).toBe(0);
  });

  it('takes the panes with it when forced', async () => {
    const pane = paneOn('trayo');
    const res = await app.request('/trayo?force=1', { method: 'DELETE' });
    expect(res.status).toBe(204);
    // Nothing is left pointing at a node that does not exist.
    expect(db.prepare('SELECT 1 FROM panes WHERE id = ?').get(pane)).toBeUndefined();
  });

  it('never removes this machine', async () => {
    expect((await app.request('/local', { method: 'DELETE' })).status).toBe(400);
    expect(db.prepare('SELECT 1 FROM nodes WHERE id = ?').get('local')).toBeTruthy();
  });

  it('404s a machine that is not there', async () => {
    expect((await app.request('/ghost', { method: 'DELETE' })).status).toBe(404);
  });
});

describe('the list', () => {
  it('still answers with panes and the multi-machine flag', async () => {
    const before = (await (await app.request('/')).json()) as { multiNode: boolean };
    expect(before.multiNode).toBe(false);
    await post({ id: 'trayo', endpoint: 'ws://vm:7797' });
    const after = (await (await app.request('/')).json()) as {
      nodes: Array<{ id: string; panes: number }>;
      multiNode: boolean;
    };
    expect(after.multiNode).toBe(true);
    expect(after.nodes.map((n) => n.id).sort()).toEqual(['local', 'trayo']);
  });

  it('never serves the token again', async () => {
    const { token } = (await (await post({ id: 'trayo', endpoint: 'ws://vm:7797' })).json()) as {
      token: string;
    };
    const listed = await (await app.request('/')).text();
    expect(listed).not.toContain(token);
  });
});

describe('without a change hook', () => {
  it('still writes the rows — a read-only test app must not crash', async () => {
    const bare = nodesRoutes({ db, dataDir: dir });
    const res = await bare.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'solo', endpoint: 'ws://x:7797' }),
    });
    expect(res.status).toBe(201);
  });
});

describe('a pairing that cannot write its token', () => {
  it('fails before creating the row, not after', async () => {
    // A node row with no credential is `unauthorized` forever and reads as a
    // setup step somebody skipped. So the token is written FIRST and the row
    // only exists if that worked. Poisoned by putting a FILE where the
    // token directory has to be.
    const poisoned = mkdtempSync(join(tmpdir(), 'muxpad-nodes-ro-'));
    writeFileSync(join(poisoned, 'node-tokens'), 'in the way');
    const bad = nodesRoutes({ db, dataDir: poisoned });
    const res = await bad.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'nowrite', endpoint: 'ws://x:7797' }),
    });
    expect(res.status).toBe(500);
    expect(db.prepare('SELECT 1 FROM nodes WHERE id = ?').get('nowrite')).toBeUndefined();
    rmSync(poisoned, { recursive: true, force: true });
  });
});
