import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentSessionStore } from '../store/AgentSessionStore.js';
import { GlobalsStore } from '../store/GlobalsStore.js';
import { PaneStore } from '../store/PaneStore.js';
import { TabStore } from '../store/TabStore.js';
import { WorkspaceStore } from '../store/WorkspaceStore.js';
import { openDb } from '../store/db.js';
import {
  HEADLINE_MIN_INTERVAL_MS,
  maybeWriteHeadline,
  sweepImplausibleHeadlines,
} from './headline.js';

/**
 * The write path, against a real database and a real transcript on disk.
 *
 * The properties under test are all about what does NOT happen — a bad
 * generation must not land, a good line must not be lost to one, and a failing
 * chat must not spin — and none of them are observable from the pure functions
 * alone. The model itself is a stub: nothing here reaches a network or spawns
 * a CLI, and a test that did would be measuring Haiku, not this code.
 */
describe('maybeWriteHeadline — what a bad generation must not cost you', () => {
  let dir: string;
  let prevDataDir: string | undefined;
  let db: Database.Database;
  let tabs: TabStore;
  let workspaceId: string;
  let tabId: string;
  let paneId: string;

  const GOOD = 'wiring the cron scheduler into boot';
  /** Verbatim from the user's own sidebar — see headline.test.ts. */
  const BUG =
    'I\'m not familiar with "muxpad" — is that an internal tool, a product name, or did you mea…';

  /** Enough turns to clear HEADLINE_MIN_TURNS. */
  const TRANSCRIPT = [
    { id: '1', ts: 1, kind: 'user', text: 'the cron never fires after a restart' },
    { id: '2', ts: 2, kind: 'assistant', text: 'next_due_at only lives in memory' },
    { id: '3', ts: 3, kind: 'user', text: 'persist it then' },
  ];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'muxpad-headline-write-'));
    prevDataDir = process.env.MUXPAD_DATA_DIR;
    process.env.MUXPAD_DATA_DIR = dir;
    db = openDb(join(dir, 'db.sqlite'));
    workspaceId = new WorkspaceStore(db).create({ name: 'W' }).id;
    tabs = new TabStore(db);
    tabId = tabs.create({ name: 'Main', workspace_id: workspaceId, layout: 'p' }).id;
    paneId = new PaneStore(db).create({ tab_id: tabId }).id;
    // A non-claude backend so the locator uses muxpad's own transcript dir,
    // which we can write.
    const sid = 'sid-headline-test';
    new AgentSessionStore(db).register({ pane_id: paneId, assistant: 'codex', session_id: sid });
    mkdirSync(join(dir, 'agent-transcripts'), { recursive: true });
    writeFileSync(
      join(dir, 'agent-transcripts', `${sid}.jsonl`),
      `${TRANSCRIPT.map((e) => JSON.stringify(e)).join('\n')}\n`,
    );
  });

  afterEach(() => {
    db.close();
    // biome-ignore lint/performance/noDelete: restoring an env var that wasn't set
    if (prevDataDir === undefined) delete process.env.MUXPAD_DATA_DIR;
    else process.env.MUXPAD_DATA_DIR = prevDataDir;
    rmSync(dir, { recursive: true, force: true });
  });

  const model = (reply: string) => async () => reply;

  it('writes a well-formed line', async () => {
    const out = await maybeWriteHeadline(
      db,
      tabId,
      paneId,
      model('cron scheduling after a restart'),
    );
    expect(out).toBe('cron scheduling after a restart');
    expect(tabs.getById(tabId)?.headline).toBe('cron scheduling after a restart');
  });

  it('a REJECTED generation leaves the previous headline exactly as it was', async () => {
    // The whole point. A row that already says something true keeps saying it
    // — a bad generation is never an improvement on a good line.
    tabs.setHeadline(tabId, GOOD, 1_000);
    const out = await maybeWriteHeadline(db, tabId, paneId, model(BUG), {
      now: 1_000 + HEADLINE_MIN_INTERVAL_MS,
    });
    expect(out).toBeNull();
    expect(tabs.getById(tabId)?.headline).toBe(GOOD);
  });

  it('a rejected FIRST generation leaves the row blank rather than wrong', async () => {
    const out = await maybeWriteHeadline(db, tabId, paneId, model(BUG));
    expect(out).toBeNull();
    expect(tabs.getById(tabId)?.headline).toBeUndefined();
  });

  it('still charges the attempt, so a persistently-failing chat cannot spin', async () => {
    // A row with no headline used to bypass the interval entirely, which meant
    // a chat whose every reply was rejected spawned a fresh model call on
    // every finished turn, forever. Charging the clock on rejection makes the
    // cost a function of ELAPSED TIME instead of turn count.
    //
    // That property is what is asserted, not a literal call count. This test
    // used to say `toBe(1)`, which held only because a 50-turn loop 10s apart
    // spanned 8 minutes and the floor was 20; retuning the floor to 6 (26839f5)
    // broke it with nothing actually wrong. Everything below is expressed in
    // intervals, so it is scale-invariant under the next retune.
    const SPAN = 3 * HEADLINE_MIN_INTERVAL_MS;

    /** Drive `turns` finished turns across SPAN, every one of them rejected. */
    const drive = async (tab: string, turns: number) => {
      let calls = 0;
      const counting = async () => {
        calls += 1;
        return BUG;
      };
      const step = SPAN / (turns - 1);
      for (let i = 0; i < turns; i++) {
        await maybeWriteHeadline(db, tab, paneId, counting, {
          now: 1_000 + Math.round(i * step),
        });
      }
      return calls;
    };

    const calls = await drive(tabId, 50);
    // One call per interval at most, plus the first — the greedy bound, the
    // same one headline.test.ts holds the pure gate to.
    expect(calls).toBeLessThanOrEqual(Math.floor(SPAN / HEADLINE_MIN_INTERVAL_MS) + 1);
    expect(tabs.getById(tabId)?.headline).toBeUndefined();

    // …and the bound tracks the CLOCK, not the loop: four times the turns over
    // the same wall-clock span costs exactly the same. A regression to per-turn
    // generation cannot sneak past this one — dropping the charge-on-rejection
    // makes it 200 calls against the other tab's 50.
    const busier = tabs.create({ name: 'Busier', workspace_id: workspaceId, layout: 'p' }).id;
    expect(await drive(busier, 200)).toBe(calls);
  });

  it('re-asks once the interval has passed, and takes a good line then', async () => {
    await maybeWriteHeadline(db, tabId, paneId, model(BUG), { now: 1_000 });
    const out = await maybeWriteHeadline(db, tabId, paneId, model('cron restart persistence'), {
      // "once the interval has passed", not "once 21 minutes have passed".
      now: 1_000 + HEADLINE_MIN_INTERVAL_MS,
    });
    expect(out).toBe('cron restart persistence');
  });

  it('a model failure leaves the line alone and charges the attempt', async () => {
    tabs.setHeadline(tabId, GOOD, 1_000);
    const out = await maybeWriteHeadline(
      db,
      tabId,
      paneId,
      async () => {
        throw new Error('no login');
      },
      { now: 1_000 + HEADLINE_MIN_INTERVAL_MS },
    );
    expect(out).toBeNull();
    expect(tabs.getById(tabId)?.headline).toBe(GOOD);
    expect(tabs.headlineAt(tabId)).toBe(1_000 + HEADLINE_MIN_INTERVAL_MS);
  });

  it('passes the glossary into the prompt it sends', async () => {
    let seen = '';
    await maybeWriteHeadline(
      db,
      tabId,
      paneId,
      async (prompt) => {
        seen = prompt;
        return 'cron restart persistence';
      },
      { glossary: ['muxpad', 'ptyd'] },
    );
    expect(seen).toContain('muxpad, ptyd');
    // …and the transcript it is labelling.
    expect(seen).toContain('the cron never fires after a restart');
  });
});

describe('sweepImplausibleHeadlines — the one-time repair', () => {
  let dir: string;
  let db: Database.Database;
  let tabs: TabStore;
  let workspaceId: string;

  const BUG =
    'I\'m not familiar with "muxpad" — is that an internal tool, a product name, or did you mea…';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'muxpad-headline-sweep-'));
    db = openDb(join(dir, 'db.sqlite'));
    workspaceId = new WorkspaceStore(db).create({ name: 'W' }).id;
    tabs = new TabStore(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const mk = (name: string, headline?: string) => {
    const id = tabs.create({ name, workspace_id: workspaceId, layout: 'p' }).id;
    if (headline) tabs.setHeadline(id, headline, 5_000);
    return id;
  };

  it('clears the malformed row and leaves the good ones alone', () => {
    // The three live rows from the report, as they actually were.
    const muxpad = mk('muxpad', 'agent-files migration deployment and verification');
    const kipa = mk('3D printed כיפה', 'Bambu Lab printer slicing and settings for test plate');
    const main = mk('Main', BUG);

    const { cleared } = sweepImplausibleHeadlines(db);

    expect(cleared).toEqual([main]);
    expect(tabs.getById(main)?.headline).toBeUndefined();
    expect(tabs.getById(muxpad)?.headline).toBe(
      'agent-files migration deployment and verification',
    );
    expect(tabs.getById(kipa)?.headline).toBe(
      'Bambu Lab printer slicing and settings for test plate',
    );
  });

  it('clears the clock too, so the row regenerates on the next turn', () => {
    const main = mk('Main', BUG);
    sweepImplausibleHeadlines(db);
    expect(tabs.headlineAt(main)).toBeNull();
  });

  it("does not touch the tab NAME — that is the user's", () => {
    const main = mk('Main', BUG);
    tabs.setNameSticky(main);
    sweepImplausibleHeadlines(db);
    expect(tabs.getById(main)?.name).toBe('Main');
    expect(tabs.isNameSticky(main)).toBe(true);
  });

  it('runs once — a line written after the sweep is never re-swept', () => {
    const main = mk('Main', BUG);
    expect(sweepImplausibleHeadlines(db).cleared).toEqual([main]);

    // Simulate a later generation the check would dislike (or a user's own
    // odd-looking line): the sweep must not come back for it on every boot.
    tabs.setHeadline(main, BUG, 9_000);
    expect(sweepImplausibleHeadlines(db).cleared).toEqual([]);
    expect(tabs.getById(main)?.headline).toBe(BUG);
  });

  it('sets its marker even when there is nothing to clear', () => {
    mk('muxpad', 'agent-files migration deployment and verification');
    expect(sweepImplausibleHeadlines(db).cleared).toEqual([]);
    expect(new GlobalsStore(db).get('headline_shape_swept_v1')).toBe('1');
  });

  it('is a no-op on a fresh install with no headlines at all', () => {
    mk('empty');
    expect(() => sweepImplausibleHeadlines(db)).not.toThrow();
    expect(sweepImplausibleHeadlines(db).cleared).toEqual([]);
  });
});
