import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MuxpadEvent } from '@muxpad/shared';

type TabUpdated = Extract<MuxpadEvent, { type: 'tab.updated' }>;
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventBus } from '../events.js';
import { PtydCache } from '../ptyd-cache.js';
import { AgentSessionStore } from '../store/AgentSessionStore.js';
import { PaneStore } from '../store/PaneStore.js';
import { TabStore } from '../store/TabStore.js';
import { WorkspaceStore } from '../store/WorkspaceStore.js';
import { openDb } from '../store/db.js';
import { HeadlineWriter } from './HeadlineWriter.js';
import { HEADLINE_MIN_INTERVAL_MS } from './headline.js';

/**
 * The plumbing between a finished turn and the rail — the part headline.ts's
 * own tests cannot see.
 *
 * `maybeWriteHeadline` is well covered as a decision function. This class is
 * covered here for the three things it decides on its own, none of which are
 * visible from the generator:
 *
 *   1. ONE in-flight generation per TAB. The bus is synchronous and a busy
 *      agent finishes turns faster than a model call returns, so without the
 *      guard a chat stacks up calls that all summarise nearly the same thing
 *      and then race to write. Per TAB, not global: two agents working in
 *      parallel must both be summarised, or the busier install is the one that
 *      gets the worse rail.
 *   2. The emit condition, `if (!headline && !icon) return`, in both
 *      directions. Something landing has to reach the client NOW (that is the
 *      entire reason the event exists — see web/src/tabs.ts, which had to grow
 *      a subscriber before the emit bought anything at all), and nothing
 *      landing has to reach nobody: a KEEP on both is the COMMON case, and an
 *      event per no-op turn is a repaint per no-op turn on every connected
 *      client.
 *   3. Fire-and-forget. A failed summary must not affect the turn, its archive
 *      or its push — the rail's second line is the least important thing on
 *      the screen and has to behave like it.
 *
 * The model is a stub throughout: nothing here reaches a network or spawns a
 * CLI, and a test that did would be measuring Haiku rather than this file.
 */
describe('HeadlineWriter — the wiring between a finished turn and the rail', () => {
  let dir: string;
  let prevDataDir: string | undefined;
  let db: Database.Database;
  let events: EventBus;
  let cache: PtydCache;
  let workspaceId: string;
  let seen: MuxpadEvent[];
  let writer: HeadlineWriter | null;

  /** Enough turns to clear HEADLINE_MIN_TURNS. */
  const TRANSCRIPT = [
    { id: '1', ts: 1, kind: 'user', text: 'the cron never fires after a restart' },
    { id: '2', ts: 2, kind: 'assistant', text: 'next_due_at only lives in memory' },
    { id: '3', ts: 3, kind: 'user', text: 'persist it then' },
  ];

  /** A tab with one pane, an agent session, and a transcript on disk. */
  function makeChat(name: string): { tabId: string; paneId: string } {
    const tabId = new TabStore(db).create({ name, workspace_id: workspaceId, layout: 'p' }).id;
    const paneId = new PaneStore(db).create({ tab_id: tabId }).id;
    const sid = `sid-${paneId}`;
    // A non-claude backend so the locator uses muxpad's own transcript dir,
    // which the test can write.
    new AgentSessionStore(db).register({ pane_id: paneId, assistant: 'codex', session_id: sid });
    writeFileSync(
      join(dir, 'agent-transcripts', `${sid}.jsonl`),
      `${TRANSCRIPT.map((e) => JSON.stringify(e)).join('\n')}\n`,
    );
    return { tabId, paneId };
  }

  const turnDone = (paneId: string): MuxpadEvent => ({
    type: 'agent_turn',
    pane_id: paneId,
    phase: 'done',
    sid: null,
    backend: 'codex',
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'muxpad-headline-writer-'));
    prevDataDir = process.env.MUXPAD_DATA_DIR;
    process.env.MUXPAD_DATA_DIR = dir;
    mkdirSync(join(dir, 'agent-transcripts'), { recursive: true });
    db = openDb(join(dir, 'db.sqlite'));
    events = new EventBus();
    cache = new PtydCache();
    workspaceId = new WorkspaceStore(db).create({ name: 'W' }).id;
    seen = [];
    events.subscribe((e) => seen.push(e));
    writer = null;
  });

  afterEach(() => {
    writer?.stop();
    db.close();
    // biome-ignore lint/performance/noDelete: restoring an env var that wasn't set
    if (prevDataDir === undefined) delete process.env.MUXPAD_DATA_DIR;
    else process.env.MUXPAD_DATA_DIR = prevDataDir;
    rmSync(dir, { recursive: true, force: true });
  });

  /** Build and start a writer over `model`. */
  function run(model: (prompt: string, signal: AbortSignal) => Promise<string>): HeadlineWriter {
    const w = new HeadlineWriter({ db, events, cache, model });
    w.start();
    writer = w;
    return w;
  }

  /**
   * The `tab.updated` events emitted so far, NARROWED.
   *
   * Typed rather than left as `MuxpadEvent`, because the alternative idiom —
   * `expect(ev?.type === 'tab.updated' && ev.tab.x).toBeDefined()` — is a
   * tautology the moment the guard is false: `expect(false).toBeDefined()`
   * passes. A predicate here means every assertion below reads the field it
   * says it reads.
   */
  const tabUpdates = (): TabUpdated[] =>
    seen.filter((e): e is TabUpdated => e.type === 'tab.updated');

  describe('the per-tab in-flight guard', () => {
    it('collapses a burst of turns in ONE tab to a single generation', async () => {
      const { paneId } = makeChat('Busy');
      let calls = 0;
      let release: (() => void) | null = null;
      // Blocks until the test lets go, so all three turns are emitted while
      // the first generation is genuinely still running. A model that resolved
      // immediately would let the guard clear between turns and this test
      // would pass with the guard deleted.
      const w = run(async () => {
        calls += 1;
        await new Promise<void>((r) => {
          release = r;
        });
        return 'LABEL: cron restart persistence\nICON: ⏱';
      });

      events.emit(turnDone(paneId));
      events.emit(turnDone(paneId));
      events.emit(turnDone(paneId));
      expect(calls).toBe(1);
      (release as unknown as () => void)();
      await w.idle();
      expect(calls).toBe(1);
    });

    it('does NOT serialise DIFFERENT tabs', async () => {
      // The guard is a Set keyed by tab. A global flag would look identical in
      // the test above and would mean one slow agent starves every other
      // chat's rail — worse on exactly the install that needs the rail most.
      const chats = ['A', 'B', 'C'].map(makeChat);
      // A real counter, not a set of stringified sizes: the point is the PEAK,
      // and it has to stay honest for more than two overlapping calls and for
      // releases that arrive out of order.
      let live = 0;
      let maxConcurrent = 0;
      const releases: Array<() => void> = [];
      const w = run(async () => {
        live += 1;
        maxConcurrent = Math.max(maxConcurrent, live);
        await new Promise<void>((r) => releases.push(r));
        live -= 1;
        return 'LABEL: cron restart persistence\nICON: ⏱';
      });

      for (const c of chats) events.emit(turnDone(c.paneId));
      expect(maxConcurrent).toBe(chats.length);
      for (const r of releases) r();
      await w.idle();
      expect(live).toBe(0);
    });

    it('releases the guard so the NEXT turn is generated too', async () => {
      // A guard that leaked would silence a tab permanently, and it would do
      // it quietly — the failure mode is a rail that just stops updating.
      const { tabId, paneId } = makeChat('Steady');
      let calls = 0;
      const w = run(async () => {
        calls += 1;
        return `LABEL: subject number ${calls}\nICON: KEEP`;
      });

      events.emit(turnDone(paneId));
      await w.idle();
      expect(calls).toBe(1);
      // Past the generator's own interval, so the second turn is not declined
      // by the rate limit before the guard is even consulted.
      new TabStore(db).setHeadline(
        tabId,
        'subject number 1',
        Date.now() - HEADLINE_MIN_INTERVAL_MS * 2,
      );
      events.emit(turnDone(paneId));
      await w.idle();
      expect(calls).toBe(2);
    });
  });

  describe('the emit condition', () => {
    it('emits when a headline lands', async () => {
      const { tabId, paneId } = makeChat('Fresh');
      const w = run(async () => 'LABEL: cron restart persistence\nICON: KEEP');
      events.emit(turnDone(paneId));
      await w.idle();

      expect(tabUpdates()).toHaveLength(1);
      const ev = tabUpdates()[0] as TabUpdated;
      expect(ev.tab.id).toBe(tabId);
      expect(ev.tab.headline).toBe('cron restart persistence');
      // Decorated, not the raw store row: clients coalesce the event onto their
      // cached tab, so a missing rollup field BLANKS the status rail.
      expect(ev.tab.status).toBeDefined();
    });

    it('carries the ICON on the same event as the headline', async () => {
      // The two fields are separately visible on the row, so one event has to
      // carry both or the rail repaints half of what changed.
      //
      // An icon-WITHOUT-headline event is unreachable by construction — the
      // generator will not choose a glyph from a reply whose label it did not
      // accept — which is exactly why `if (!headline && !icon)` is worth
      // stating rather than shortening to `!headline`: the coupling belongs to
      // the generator, and this file should not silently depend on it.
      const { paneId } = makeChat('Iconless');
      const w = run(async () => 'LABEL: cron restart persistence\nICON: ⏱');
      events.emit(turnDone(paneId));
      await w.idle();

      expect(tabUpdates()).toHaveLength(1);
      const ev = tabUpdates()[0] as TabUpdated;
      expect(ev.tab.icon).toBe('⏱️');
      expect(ev.tab.headline).toBe('cron restart persistence');
    });

    it('says NOTHING when the reply keeps both', async () => {
      // The common case by a wide margin, and the reason the condition is not
      // just "we ran". An event per no-op turn is a repaint per no-op turn on
      // every connected client, forever.
      const { tabId, paneId } = makeChat('Settled');
      new TabStore(db).setHeadline(tabId, 'cron restart persistence', 1);
      const w = run(async () => 'LABEL: KEEP\nICON: KEEP');
      events.emit(turnDone(paneId));
      await w.idle();
      expect(tabUpdates()).toHaveLength(0);
    });

    it('says nothing when the generation is REJECTED', async () => {
      // Verbatim from the user's own sidebar: the model answering the
      // conversation instead of labelling it. Nothing is written, so there is
      // nothing to tell anyone about — and in particular the ICON from the
      // same reply is not written either (chat/headline.ts, condition 4).
      const { tabId, paneId } = makeChat('Confused');
      const w = run(
        async () =>
          'LABEL: I\'m not familiar with "muxpad" — is that an internal tool, a product name, or did you mea…\nICON: ⏱',
      );
      events.emit(turnDone(paneId));
      await w.idle();
      expect(tabUpdates()).toHaveLength(0);
      const tab = new TabStore(db).getById(tabId);
      expect(tab?.headline).toBeUndefined();
      expect(tab?.icon).toBeUndefined();
    });
  });

  describe('fire-and-forget', () => {
    it('a throwing model neither throws at the emitter nor emits', async () => {
      // The bus is SYNCHRONOUS: this handler runs inside the ws layer's own
      // `agent_turn` emit, so an exception escaping here would land in the
      // middle of turn completion, next to the archive write and the push.
      const { paneId } = makeChat('Doomed');
      const w = run(async () => {
        throw new Error('no claude login');
      });
      expect(() => events.emit(turnDone(paneId))).not.toThrow();
      await expect(w.idle()).resolves.toBeUndefined();
      expect(tabUpdates()).toHaveLength(0);
    });

    it('ignores every phase but done, and every non-turn event', async () => {
      // `fatal` is deliberately excluded where the archiver takes it: a
      // crashed runner has usually just written the most interesting part of
      // the transcript, but summarising a half-finished turn produces a line
      // about work that did not happen.
      const { paneId } = makeChat('Partial');
      let calls = 0;
      const w = run(async () => {
        calls += 1;
        return 'LABEL: cron restart persistence\nICON: KEEP';
      });
      events.emit({ ...turnDone(paneId), phase: 'start' } as MuxpadEvent);
      events.emit({ ...turnDone(paneId), phase: 'fatal' } as MuxpadEvent);
      // …and the other half of the same guard. The bus carries pane, tab and
      // workspace traffic too, and this class must not read `pane_id` off an
      // event that has none.
      events.emit({ type: 'pane.removed', pane_id: paneId, tab_id: 'whatever' } as MuxpadEvent);
      await w.idle();
      expect(calls).toBe(0);
    });

    it('stop() unsubscribes', async () => {
      const { paneId } = makeChat('Stopped');
      let calls = 0;
      const w = run(async () => {
        calls += 1;
        return 'LABEL: cron restart persistence\nICON: KEEP';
      });
      w.stop();
      events.emit(turnDone(paneId));
      await w.idle();
      expect(calls).toBe(0);
    });

    it('shrugs at a turn from a pane that no longer exists', async () => {
      const { paneId } = makeChat('Gone');
      new PaneStore(db).delete(paneId);
      const w = run(async () => 'LABEL: cron restart persistence\nICON: KEEP');
      expect(() => events.emit(turnDone(paneId))).not.toThrow();
      await w.idle();
      expect(tabUpdates()).toHaveLength(0);
    });
  });
});
