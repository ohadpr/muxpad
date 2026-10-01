// A CREATE THAT CANNOT SPAWN MUST SAY SO.
//
// The bug this pins: `bootstrapTab` asked ptyd for the pty inside a bare
// `.catch(() => {})`. One rejected `ensurePane` — ptyd disconnected, or a
// `posix_spawnp failed` from a full process table — and the chat was
// permanently dead, with nothing anywhere recording why. The web app then
// rendered its neutral "This chat has no agent yet", which is the RIGHT screen
// for a pane that never had one and a LIE for a pane created three seconds ago.
//
// Two halves, and the retry is the more important one: the failures that
// actually happen here are transient (ptyd mid-reconnect, a momentarily full
// process table), so a chat that retries provisions itself and the user never
// learns there was a problem. The recorded reason is what is left when the
// retries are genuinely out.
import type { PaneSpec } from '@muxpad/shared';
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from './events.js';
import {
  PROVISION_RETRY_DELAYS_MS,
  clearProvisionError,
  provisionError,
  provisionPane,
} from './pane-provision.js';
import { PtydCache } from './ptyd-cache.js';
import type { PtydClient } from './ptyd-client/PtydClient.js';
import { PaneStore } from './store/PaneStore.js';
import { TabStore } from './store/TabStore.js';
import { WorkspaceStore } from './store/WorkspaceStore.js';
import { openDb } from './store/db.js';

/** Total wall time the retry ladder needs, plus slack. */
const LADDER_MS = PROVISION_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0) + 1_000;

interface Harness {
  db: Database.Database;
  ptyd: PtydClient;
  cache: PtydCache;
  events: EventBus;
  /** One entry per ensurePane ptyd was asked for. */
  ensured: PaneSpec['id'][];
  pane: PaneSpec;
}

let open: Array<() => void> = [];
afterEach(() => {
  for (const c of open) c();
  open = [];
  vi.useRealTimers();
});

/**
 * `outcomes` is consumed one per attempt: an Error rejects that attempt, `'ok'`
 * resolves it and leaves the pane live, `'gone'` resolves it but leaves ptyd
 * holding no pane — a pty that spawned and died on the spot, which is
 * indistinguishable from a failed spawn as far as the chat is concerned.
 */
function harness(outcomes: Array<Error | 'ok' | 'gone'>): Harness {
  const db = openDb(':memory:');
  open.push(() => db.close());
  const wsId = new WorkspaceStore(db).create({ name: 'W' }).id;
  const tab = new TabStore(db).create({ name: 'T', layout: '', workspace_id: wsId });
  const pane = new PaneStore(db).create({
    tab_id: tab.id,
    shell: '/bin/zsh',
    cwd: '/tmp',
    startup_cmd: 'muxpad agent --mode chat',
    face: 'chat',
    mode: 'chat',
  });
  const ensured: string[] = [];
  const live = new Set<string>();
  const ptyd = {
    socketPath: '/tmp/muxpad-provision-test.sock',
    ensurePane: async (spec: PaneSpec) => {
      ensured.push(spec.id);
      const outcome = outcomes[ensured.length - 1] ?? 'ok';
      if (outcome instanceof Error) throw outcome;
      if (outcome === 'ok') live.add(spec.id);
      else live.delete(spec.id);
    },
    hasPane: async (id: string) => live.has(id),
    killPane: async () => {},
    getForegroundCommand: async () => null,
    on: () => {},
  } as unknown as PtydClient;
  return { db, ptyd, cache: new PtydCache(), events: new EventBus(), ensured, pane };
}

const spec = (h: Harness) => ({
  id: h.pane.id,
  shell: '/bin/zsh',
  startup_cmd: h.pane.startup_cmd,
  cwd: '/tmp',
  env: null,
  tab_id: h.pane.tab_id,
});

describe('provisionPane retries a spawn that failed', () => {
  it('a transient failure is invisible: the second attempt wins, no error recorded', async () => {
    const h = harness([new Error('posix_spawnp failed'), 'ok']);
    await provisionPane(h, spec(h)).settled;
    expect(h.ensured).toHaveLength(2);
    expect(provisionError(h.pane.id)).toBeNull();
  });

  it(
    'records the REASON when the ladder runs out, in ptyd’s own words',
    async () => {
      const h = harness([
        new Error('posix_spawnp failed'),
        new Error('posix_spawnp failed'),
        new Error('posix_spawnp failed'),
        new Error('posix_spawnp failed'),
      ]);
      await provisionPane(h, spec(h)).settled;
      // Every rung used, then the truth written down.
      expect(h.ensured).toHaveLength(PROVISION_RETRY_DELAYS_MS.length + 1);
      expect(provisionError(h.pane.id)).toContain('posix_spawnp failed');
    },
    LADDER_MS,
  );

  it('a pty that spawned and instantly died counts as a failure', async () => {
    // ptyd answers `ok: true` for ensurePane whether or not the runtime it just
    // made is still alive — the handler replies after `getOrCreate`, and a
    // shell that exits immediately is gone by the next tick. Only hasPane can
    // tell the difference, and "the row is right, the pty is gone" is the exact
    // shape the live cockpit reported.
    const h = harness(['gone', 'ok']);
    await provisionPane(h, spec(h)).settled;
    expect(h.ensured).toHaveLength(2);
    expect(provisionError(h.pane.id)).toBeNull();
  });

  it('a recovered provision CLEARS an error it recorded earlier', async () => {
    const h = harness([new Error('ptyd disconnected'), new Error('ptyd disconnected')]);
    await provisionPane(h, { ...spec(h), attempts: 1 }).settled;
    expect(provisionError(h.pane.id)).toContain('ptyd disconnected');
    clearProvisionError(h.pane.id);
    expect(provisionError(h.pane.id)).toBeNull();
  });

  it('a single-attempt check REPLACES a stale reason rather than clearing it blind', async () => {
    // The respawn route behind "Start agent" runs exactly this: attempts 1, off
    // the response path. It used to clear the recorded reason the moment ptyd
    // ACKNOWLEDGED the respawn — which rebuilt the original bug inside the retry
    // button, because an ack is not a live pty. A respawn that acks and then
    // dies would drop the reason and drop the chat back onto the neutral
    // "no agent yet", which is the screen this whole change exists to stop
    // standing in for a failure.
    const h = harness([new Error('posix_spawnp failed'), 'gone']);
    await provisionPane(h, { ...spec(h), attempts: 1 }).settled;
    expect(provisionError(h.pane.id)).toContain('posix_spawnp failed');
    // Now the user taps Try again. ptyd accepts it and the pty dies anyway.
    await provisionPane(h, { ...spec(h), attempts: 1 }).settled;
    expect(provisionError(h.pane.id)).toContain('exited immediately');
  });

  it('…and clears it when the retry genuinely holds', async () => {
    const h = harness([new Error('posix_spawnp failed'), 'ok']);
    await provisionPane(h, { ...spec(h), attempts: 1 }).settled;
    expect(provisionError(h.pane.id)).toBeTruthy();
    await provisionPane(h, { ...spec(h), attempts: 1 }).settled;
    expect(provisionError(h.pane.id)).toBeNull();
  });

  it('announces the failure as pane.updated so an open chat learns without polling', async () => {
    const h = harness([new Error('ptyd disconnected')]);
    const seen: Array<{ id: string; err: unknown }> = [];
    h.events.subscribe((e) => {
      if (e.type === 'pane.updated')
        seen.push({
          id: e.pane.id,
          err: (e.pane as { provision_error?: unknown }).provision_error,
        });
    });
    await provisionPane(h, { ...spec(h), attempts: 1 }).settled;
    const mine = seen.filter((s) => s.id === h.pane.id);
    expect(mine).toHaveLength(1);
    expect(String(mine[0]?.err)).toContain('ptyd disconnected');
  });

  it('stops retrying a pane whose row was DELETED mid-ladder', async () => {
    // The delete race agent-tab.ts's inFlightSpawns exists for, seen from the
    // other side: retrying against a deleted row would hand ptyd a pty with
    // nothing behind it — invisible to every UI and unreachable by anything but
    // a ptyd restart, which kills every pane on the machine.
    const h = harness([new Error('posix_spawnp failed'), 'ok', 'ok', 'ok']);
    new TabStore(h.db).delete(h.pane.tab_id);
    await provisionPane(h, spec(h)).settled;
    expect(h.ensured).toHaveLength(1);
    // …and nothing is reported about a pane the user deliberately removed.
    expect(provisionError(h.pane.id)).toBeNull();
  });

  it(
    'the caller can wait for the FIRST attempt without waiting for the ladder',
    async () => {
      // What keeps `POST /api/tabs` fast: bootstrapTab races the first attempt
      // against its 250ms cap, and the retries run long after the response.
      const h = harness([new Error('posix_spawnp failed'), new Error('posix_spawnp failed'), 'ok']);
      const started = Date.now();
      const p = provisionPane(h, spec(h));
      await p.first;
      expect(Date.now() - started).toBeLessThan(PROVISION_RETRY_DELAYS_MS[0] ?? 250);
      await p.settled;
      expect(provisionError(h.pane.id)).toBeNull();
    },
    LADDER_MS,
  );
});
