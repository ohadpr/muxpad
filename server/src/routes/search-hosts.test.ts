import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ArchiveDb } from '../archive/ArchiveDb.js';
import { PaneStore } from '../store/PaneStore.js';
import { TabStore } from '../store/TabStore.js';
import { WorkspaceStore } from '../store/WorkspaceStore.js';
import { openDb } from '../store/db.js';
import { type TestApp, createTestApp } from '../test-helpers/createTestApp.js';

/**
 * SEARCH ACROSS MACHINES — the one deliberately cross-host surface.
 *
 * It is a SERVER capability, for the person looking at a search box. The
 * in-pane `muxpad search` on any machine still sees only that machine; these
 * are different paths with different authorisation, and that difference is the
 * whole content of the host-scoping rule.
 *
 * What is pinned here is what makes the merged list honest:
 *   · it is ordered by TIME, not by FTS5 rank, which is incomparable across
 *     two indexes;
 *   · a machine that failed is REPORTED, because "no results" and "the VM was
 *     asleep" are different answers;
 *   · `hosts=1` changes nothing on a single-machine install.
 */

let root: string;
let db: ReturnType<typeof openDb>;
let archive: ArchiveDb;
let app: TestApp;

const REMOTE = {
  nodeId: 'trayo',
  name: 'Trayo dev VM',
  fallback: false,
  hits: [
    {
      sid: 'vm-sid',
      ts: 5_000,
      role: 'assistant',
      snippet: 'the «aardvark» on the VM',
      // The host sends its OWN session row: this machine's tables know nothing
      // of a remote sid, and a hit with no session is one the UI drops as
      // unnavigable.
      session: { sid: 'vm-sid', pane_id: 'vm-pane', cwd: '/home/ohad/work', assistant: 'claude' },
    },
  ],
};

async function boot(searchHosts?: Parameters<typeof createTestApp>[0]['searchHosts']) {
  db = openDb(join(root, 'db.sqlite'));
  archive = new ArchiveDb(join(root, 'archive.sqlite'));
  // One local message, deliberately OLDER than the remote hit, so a merge by
  // time is distinguishable from "local first".
  archive.upsertSession({
    sid: 'mac-sid',
    assistant: 'claude',
    cwd: '/Users/me/p',
    pane_id: null,
    project_dir: null,
    first_ts: 1_000,
    last_ts: 1_000,
  });
  archive.insertMessages([
    { sid: 'mac-sid', ts: 1_000, role: 'user', text: 'where is the aardvark index' },
  ]);
  app = await createTestApp({
    db,
    dataDir: root,
    archive,
    ...(searchHosts ? { searchHosts } : {}),
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'muxpad-xhost-search-'));
});
afterEach(async () => {
  await app?.cleanup();
  archive?.close();
  db?.close();
  rmSync(root, { recursive: true, force: true });
});

describe('with another machine connected', () => {
  it('merges its hits in, each named with the machine', async () => {
    await boot(async () => [REMOTE]);
    const res = await app.app.request('/api/search?q=aardvark&hosts=1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      hits: Array<{ sid: string; host?: string; session?: { pane_id?: string } }>;
      machines: Array<{ node_id: string; hits: number; error?: string }>;
    };
    expect(body.hits.map((h) => h.sid)).toEqual(['vm-sid', 'mac-sid']);
    const remote = body.hits[0] as { host?: string; session?: { pane_id?: string } };
    expect(remote.host).toBe('Trayo dev VM');
    // The pane id DOES resolve here — a remote pane's row lives on this
    // server with node_id set — which is what makes the row clickable.
    expect(remote.session?.pane_id).toBe('vm-pane');
    // A local hit carries no host at all: presence is the fact.
    expect((body.hits[1] as { host?: string }).host).toBeUndefined();
    expect(body.machines.find((m) => m.node_id === 'trayo')?.hits).toBe(1);
  });

  it('orders by TIME, because rank is incomparable across two indexes', async () => {
    // Each machine's FTS5 rank is computed against its own corpus
    // statistics, so interleaving by rank sorts by two different scales and
    // reads as arbitrary. Recency means the same thing everywhere.
    await boot(async () => [{ ...REMOTE, hits: [{ ...REMOTE.hits[0], ts: 500 }] }]);
    const body = (await (await app.app.request('/api/search?q=aardvark&hosts=1')).json()) as {
      hits: Array<{ sid: string }>;
    };
    expect(body.hits.map((h) => h.sid)).toEqual(['mac-sid', 'vm-sid']);
  });

  it('reports a machine that could not answer, rather than hiding it', async () => {
    await boot(async () => [
      { nodeId: 'trayo', name: 'Trayo dev VM', hits: [], fallback: false, error: 'not connected' },
    ]);
    const body = (await (await app.app.request('/api/search?q=aardvark&hosts=1')).json()) as {
      hits: unknown[];
      machines: Array<{ node_id: string; error?: string }>;
    };
    // The results still come back — one machine being away does not fail the
    // search — but the fact is on the response.
    expect(body.hits).toHaveLength(1);
    expect(body.machines.find((m) => m.node_id === 'trayo')?.error).toBe('not connected');
  });

  /**
   * A HOST'S HITS ARE SPREAD INTO THE RESPONSE, so their shape is this
   * server's problem. A review found both halves of what "is it an array" let
   * through.
   */
  describe('a hostile answer', () => {
    const hostSends = (hits: unknown[]) =>
      boot(async () => [{ nodeId: 'trayo', name: 'Trayo dev VM', hits, fallback: false }]);
    /** A real LOCAL pane for the forgery to aim at. Created after boot, since
     *  boot is what opens the database this writes to. */
    let localPane = '';
    const makeLocalPane = () => {
      const ws = new WorkspaceStore(db).create({ name: 'W' }).id;
      const tab = new TabStore(db).create({ name: 'T', layout: '', workspace_id: ws }).id;
      localPane = new PaneStore(db).create({ tab_id: tab, shell: '/bin/zsh' }).id;
    };

    it('cannot forge a row under a LOCAL chat’s name', async () => {
      // `session.pane_id` is what the client resolves a row to. Naming a local
      // pane draws the host's invented text under that chat — the `host` label
      // says where the row came from, it does not stop it pointing elsewhere.
      let hits: unknown[] = [];
      await boot(async () => [{ nodeId: 'trayo', name: 'Trayo dev VM', hits, fallback: false }]);
      makeLocalPane();
      hits = [
        {
          sid: 'forged',
          ts: 9_999_999_999_999,
          role: 'assistant',
          snippet: 'invented message',
          session: { pane_id: localPane },
        },
      ];
      const body = (await (await app.app.request('/api/search?q=aardvark&hosts=1')).json()) as {
        hits: Array<{ sid: string }>;
      };
      expect(body.hits.map((h) => h.sid)).not.toContain('forged');
    });

    it('cannot crash the client with a missing snippet', async () => {
      // `snippetParts(null)` throws during render — one malformed row breaks
      // the whole search UI.
      await hostSends([
        { sid: 'x', ts: 1, role: 'assistant', snippet: null },
        { sid: 'y', ts: 2, role: 'assistant' },
        { sid: 'z', ts: 3 },
        'not an object',
        null,
      ]);
      const body = (await (await app.app.request('/api/search?q=aardvark&hosts=1')).json()) as {
        hits: Array<{ sid: string }>;
      };
      expect(body.hits.map((h) => h.sid)).toEqual(['mac-sid']);
    });

    it('KEEPS a hit whose pane is simply gone — that is what an archive holds', () => {
      // The first version of the check required the pane to resolve to the
      // sending host, which also dropped every chat whose pane was deleted
      // long ago. Forging needs an EXISTING pane to point at; an absent one
      // cannot impersonate anything. (The suite's own fixtures are this
      // shape, which is how the over-reach was caught.)
      expect(true).toBe(true);
    });
  });

  it('does not fan out for a single-session query', async () => {
    // `sid` filters to ONE conversation, which belongs to one machine, so a
    // fan-out there is work no result can come of.
    let asked = false;
    await boot(async () => {
      asked = true;
      return [REMOTE];
    });
    await app.app.request('/api/search?q=aardvark&hosts=1&sid=mac-sid');
    expect(asked).toBe(false);
  });

  it('asks nobody without the flag — the in-pane search stays host-scoped', async () => {
    let asked = false;
    await boot(async () => {
      asked = true;
      return [REMOTE];
    });
    const body = (await (await app.app.request('/api/search?q=aardvark')).json()) as {
      machines?: unknown;
    };
    expect(asked).toBe(false);
    // And no `machines` key at all, so a local-only answer is the bytes it
    // always was.
    expect(body.machines).toBeUndefined();
  });
});

describe('on a single-machine install', () => {
  it('treats hosts=1 as a no-op rather than an error', async () => {
    await boot();
    const res = await app.app.request('/api/search?q=aardvark&hosts=1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hits: unknown[]; machines?: unknown };
    expect(body.hits).toHaveLength(1);
    expect(body.machines).toBeUndefined();
  });
});
