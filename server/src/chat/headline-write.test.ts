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
  ICON_MIN_STABLE_MS,
  backfillGeneratedIcons,
  chooseIcon,
  isIconFrozen,
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
    expect(out.headline).toBe('cron scheduling after a restart');
    expect(tabs.getById(tabId)?.headline).toBe('cron scheduling after a restart');
  });

  it('a REJECTED generation leaves the previous headline exactly as it was', async () => {
    // The whole point. A row that already says something true keeps saying it
    // — a bad generation is never an improvement on a good line.
    tabs.setHeadline(tabId, GOOD, 1_000);
    // Comfortably PAST the interval, not exactly on it: sitting on the `>=`
    // boundary would let a gate that blocked the call entirely produce this
    // test's whole result (null, headline untouched), so it would pass while
    // testing nothing.
    const now = 1_000 + 3 * HEADLINE_MIN_INTERVAL_MS;
    const out = await maybeWriteHeadline(db, tabId, paneId, model(BUG), { now });
    expect(out.headline).toBeNull();
    expect(tabs.getById(tabId)?.headline).toBe(GOOD);
    // The generation really did run and really was rejected — without this the
    // assertions above are also satisfied by never calling the model.
    expect(tabs.headlineAt(tabId)).toBe(now);
  });

  it('a rejected FIRST generation leaves the row blank rather than wrong', async () => {
    const out = await maybeWriteHeadline(db, tabId, paneId, model(BUG));
    expect(out.headline).toBeNull();
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

    const INTERVALS = SPAN / HEADLINE_MIN_INTERVAL_MS;
    const calls = await drive(tabId, 50);
    // Two-sided on purpose. The ceiling is the greedy bound — one call per
    // interval, plus the first — and is what "cannot spin" means. The FLOOR
    // matters just as much: a gate that never fires at all also satisfies a
    // "≤" and would let this test pass with the whole write path disabled,
    // which is the way the previous exact `toBe(1)` was actually stronger.
    expect(calls).toBeGreaterThanOrEqual(Math.floor(INTERVALS));
    expect(calls).toBeLessThanOrEqual(Math.floor(INTERVALS) + 1);
    expect(tabs.getById(tabId)?.headline).toBeUndefined();

    // …and the bound tracks the CLOCK, not the loop: four times the turns over
    // the same wall-clock span costs exactly the same. A regression to per-turn
    // generation cannot sneak past this one — dropping the charge-on-rejection
    // makes it 200 calls against the other tab's 50.
    const busier = tabs.create({ name: 'Busier', workspace_id: workspaceId, layout: 'p' }).id;
    expect(await drive(busier, 200)).toBe(calls);
    expect(tabs.getById(busier)?.headline).toBeUndefined();
  });

  it('re-asks once the interval has passed, and takes a good line then', async () => {
    await maybeWriteHeadline(db, tabId, paneId, model(BUG), { now: 1_000 });
    const out = await maybeWriteHeadline(db, tabId, paneId, model('cron restart persistence'), {
      // "once the interval has passed", not "once 21 minutes have passed".
      now: 1_000 + HEADLINE_MIN_INTERVAL_MS,
    });
    expect(out.headline).toBe('cron restart persistence');
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
    expect(out.headline).toBeNull();
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

/**
 * The icon, on the write path.
 *
 * The pure rules are pinned in headline.test.ts; what is tested here is that
 * the database ends up in the right state — because every failure mode that
 * matters is a persisted one. A sticky icon overwritten stays overwritten; an
 * icon that churns churns on the row the user is looking at.
 */
describe('maybeWriteHeadline — the icon, and what must never move it', () => {
  let dir: string;
  let prevDataDir: string | undefined;
  let db: Database.Database;
  let tabs: TabStore;
  let workspaceId: string;
  let tabId: string;
  let paneId: string;

  const TRANSCRIPT = [
    { id: '1', ts: 1, kind: 'user', text: 'the cron never fires after a restart' },
    { id: '2', ts: 2, kind: 'assistant', text: 'next_due_at only lives in memory' },
    { id: '3', ts: 3, kind: 'user', text: 'persist it then' },
  ];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'muxpad-icon-write-'));
    prevDataDir = process.env.MUXPAD_DATA_DIR;
    process.env.MUXPAD_DATA_DIR = dir;
    db = openDb(join(dir, 'db.sqlite'));
    workspaceId = new WorkspaceStore(db).create({ name: 'W' }).id;
    tabs = new TabStore(db);
    tabId = tabs.create({ name: 'Main', workspace_id: workspaceId, layout: 'p' }).id;
    paneId = new PaneStore(db).create({ tab_id: tabId }).id;
    const sid = 'sid-icon-test';
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

  /** A well-formed two-field reply. */
  const reply = (label: string, icon: string) => async () => `LABEL: ${label}\nICON: ${icon}`;
  /** A LABEL the shape check refuses — verbatim from the user's own sidebar. */
  const BUG_LINE =
    'I\'m not familiar with "muxpad" — is that an internal tool, a product name, or did you mea…';

  it('a new tab starts with NO icon, so it is eligible', () => {
    // The random default is gone. It was not merely meaningless — it was the
    // generator's own hands-off signal, so it disabled this feature for every
    // tab that has ever been created.
    expect(tabs.getById(tabId)?.icon).toBeUndefined();
  });

  it('writes both outputs from ONE model call', () => {
    // The cost contract, asserted where it lives. Two calls would double the
    // spend and let the two answers disagree about what the chat is about.
    let calls = 0;
    return maybeWriteHeadline(
      db,
      tabId,
      paneId,
      async () => {
        calls += 1;
        return 'LABEL: cron restart persistence\nICON: ⏰';
      },
      { now: 1_000 },
    ).then((out) => {
      expect(calls).toBe(1);
      expect(out).toEqual({ headline: 'cron restart persistence', icon: '⏰' });
      const tab = tabs.getById(tabId);
      expect(tab?.headline).toBe('cron restart persistence');
      expect(tab?.icon).toBe('⏰');
      expect(tabs.iconAt(tabId)).toBe(1_000);
    });
  });

  it('a REJECTED icon leaves the existing one exactly as it was', async () => {
    // The icon's version of the rule the headline already follows: a bad
    // generation is never an improvement on a good value.
    await maybeWriteHeadline(db, tabId, paneId, reply('cron restart persistence', '⏰'), {
      now: 1_000,
    });
    const stamped = tabs.iconAt(tabId);

    for (const bad of ['🚀🔥', 'rocket', ':-)', '🚀 deploy', '', 'x']) {
      const out = await maybeWriteHeadline(
        db,
        tabId,
        paneId,
        reply(`subject number ${bad.length}`, bad),
        // Well past the stability window, so the ONLY thing standing between
        // this reply and the row is the validator.
        { now: 1_000 + 10 * ICON_MIN_STABLE_MS },
      );
      expect(out.icon).toBeNull();
      expect(tabs.getById(tabId)?.icon).toBe('⏰');
      // …and the clock did not move either, or the window would restart on
      // every bad generation and a real change could never land.
      expect(tabs.iconAt(tabId)).toBe(stamped);
    }
  });

  it('a rejected FIRST icon leaves the row bare rather than wrong', async () => {
    const out = await maybeWriteHeadline(db, tabId, paneId, reply('cron restarts', '🚀🔥'), {
      now: 1_000,
    });
    expect(out.icon).toBeNull();
    expect(tabs.getById(tabId)?.icon).toBeUndefined();
    expect(tabs.iconAt(tabId)).toBeNull();
  });

  it('NEVER touches an icon the user chose — not once, not ever', async () => {
    // The sticky rule, end to end and over many attempts across a long span.
    // A single-attempt version of this test would pass against an
    // implementation that merely rate-limited the overwrite.
    tabs.setIcon(tabId, '⏰', 1_000);
    tabs.setIconSticky(tabId);
    for (let i = 1; i <= 20; i++) {
      const out = await maybeWriteHeadline(
        db,
        tabId,
        paneId,
        reply(`subject that keeps moving ${i}`, '🐛'),
        { now: 1_000 + i * 10 * ICON_MIN_STABLE_MS },
      );
      expect(out.icon).toBeNull();
    }
    expect(tabs.getById(tabId)?.icon).toBe('⏰');
    expect(tabs.iconAt(tabId)).toBe(1_000);
    // The headline meanwhile is NOT frozen — sticky is about the glyph only,
    // and a test that couldn't tell the two apart would also pass if the
    // whole write path had stopped working.
    expect(tabs.getById(tabId)?.headline).toBeTruthy();
  });

  it('a sticky icon on a row the model has never seen is still untouchable', async () => {
    // Sticky outranks "there is nothing there yet": a user who picked a glyph
    // and then cleared it has still expressed that this row is theirs.
    tabs.setIconSticky(tabId);
    const out = await maybeWriteHeadline(db, tabId, paneId, reply('cron restarts', '⏰'), {
      now: 1_000,
    });
    expect(out.icon).toBeNull();
    expect(tabs.getById(tabId)?.icon).toBeUndefined();
  });

  it('holds the glyph still for the whole stability window', async () => {
    await maybeWriteHeadline(db, tabId, paneId, reply('cron restart persistence', '⏰'), {
      now: 1_000,
    });
    // Twenty finished turns across the window, every one of them proposing a
    // different emoji and a different subject. This is the churn scenario.
    for (let i = 1; i <= 20; i++) {
      await maybeWriteHeadline(db, tabId, paneId, reply(`subject ${i}`, i % 2 ? '🐛' : '🔥'), {
        now: 1_000 + Math.floor((i * (ICON_MIN_STABLE_MS - 1)) / 20),
      });
    }
    expect(tabs.getById(tabId)?.icon).toBe('⏰');
    // The HEADLINE moved several times over the same span — proof the calls
    // really happened and that the icon's stillness is its own rule, not a
    // side effect of the row being idle.
    expect(tabs.getById(tabId)?.headline).not.toBe('cron restart persistence');
  });

  it('lets the glyph move once the window is up AND the line moved with it', async () => {
    await maybeWriteHeadline(db, tabId, paneId, reply('cron restart persistence', '⏰'), {
      now: 1_000,
    });
    const later = 1_000 + ICON_MIN_STABLE_MS;
    const out = await maybeWriteHeadline(db, tabId, paneId, reply('bambu printer slicing', '🖨️'), {
      now: later,
    });
    expect(out).toEqual({ headline: 'bambu printer slicing', icon: '🖨️' });
    expect(tabs.getById(tabId)?.icon).toBe('🖨️');
    expect(tabs.iconAt(tabId)).toBe(later);
  });

  it('refuses to move the glyph when the LINE stood still', async () => {
    // Anti-drift condition 5, end to end. Past the window, a valid new emoji,
    // and the model saying KEEP to the label — which means the subject did not
    // move, which means the picture of it has no business moving either.
    await maybeWriteHeadline(db, tabId, paneId, reply('cron restart persistence', '⏰'), {
      now: 1_000,
    });
    const out = await maybeWriteHeadline(db, tabId, paneId, reply('KEEP', '🐛'), {
      now: 1_000 + 10 * ICON_MIN_STABLE_MS,
    });
    expect(out.icon).toBeNull();
    expect(tabs.getById(tabId)?.icon).toBe('⏰');
  });

  it('gives a FIRST icon even when the line is kept', async () => {
    // The one case where the two outputs come apart: a settled chat that has
    // never had a glyph. Every tab that existed before this feature is in
    // exactly this state right after the backfill, so gating the first icon on
    // a headline change would have meant they never got one.
    tabs.setHeadline(tabId, 'cron restart persistence', 1_000);
    const out = await maybeWriteHeadline(db, tabId, paneId, reply('KEEP', '⏰'), {
      now: 1_000 + HEADLINE_MIN_INTERVAL_MS,
    });
    expect(out.headline).toBeNull();
    expect(out.icon).toBe('⏰');
    expect(tabs.getById(tabId)?.icon).toBe('⏰');
    // The line really was kept.
    expect(tabs.getById(tabId)?.headline).toBe('cron restart persistence');
  });

  it('KEEPS a glyph of unknown provenance until the label moves', async () => {
    // `✳` is what every tab the + button creates is born with, `⏱` what cron
    // tabs get — but `🧿` could equally be something the user picked by hand
    // before there was a flag to record it, and nothing in the row can tell
    // those apart. Displacing one for free would churn a deliberately-chosen
    // icon on the first turn after an upgrade, so all three are treated like
    // the one we would least like to lose.
    for (const placeholder of ['✳', '⏱', '🧿']) {
      const id = tabs.create({ name: 'P', workspace_id: workspaceId, layout: 'p' }).id;
      const pane = new PaneStore(db).create({ tab_id: id }).id;
      new AgentSessionStore(db).register({
        pane_id: pane,
        assistant: 'codex',
        session_id: 'sid-icon-test',
      });
      tabs.update(id, { icon: placeholder });
      tabs.setHeadline(id, 'cron restart persistence', 1_000);

      const kept = await maybeWriteHeadline(db, id, pane, reply('KEEP', '⏰'), {
        now: 1_000 + HEADLINE_MIN_INTERVAL_MS,
      });
      expect(kept.icon).toBeNull();
      expect(tabs.getById(id)?.icon).toBe(placeholder);

      // …and it is a delay, not a permanent block: the next reply that moves
      // the LABEL moves the glyph with it.
      const moved = await maybeWriteHeadline(db, id, pane, reply('bambu printer slicing', '⏰'), {
        now: 1_000 + 2 * HEADLINE_MIN_INTERVAL_MS,
      });
      expect(moved.icon).toBe('⏰');
      expect(tabs.getById(id)?.icon).toBe('⏰');
    }
  });

  it('a brand-new tab is still labelled on its FIRST successful generation', async () => {
    // What makes "prefer keeping" free rather than costly. A fresh tab wears
    // `✳` and has no headline, so its first accepted label IS a change and
    // carries the glyph along — no upgrade in behaviour was traded away for
    // the conservatism above.
    const id = tabs.create({ name: 'Fresh', workspace_id: workspaceId, layout: 'p' }).id;
    const pane = new PaneStore(db).create({ tab_id: id }).id;
    new AgentSessionStore(db).register({
      pane_id: pane,
      assistant: 'codex',
      session_id: 'sid-icon-test',
    });
    tabs.update(id, { icon: '✳' });
    const out = await maybeWriteHeadline(db, id, pane, reply('cron restart persistence', '⏰'), {
      now: 1_000,
    });
    expect(out).toEqual({ headline: 'cron restart persistence', icon: '⏰' });
    expect(tabs.getById(id)?.icon).toBe('⏰');
  });

  it('an icon can only land in a reply whose LABEL was also accepted', async () => {
    // A pleasant consequence of gating replacement on the headline: a
    // generation we distrusted enough to reject the line from never gets to
    // pick the picture either.
    tabs.update(tabId, { icon: '✳' });
    const out = await maybeWriteHeadline(db, tabId, paneId, reply(BUG_LINE, '⏰'), { now: 1_000 });
    expect(out).toEqual({ headline: null, icon: null });
    expect(tabs.getById(tabId)?.icon).toBe('✳');
  });

  it('a sticky icon set DURING the model call still wins', async () => {
    // The race the SQL guard exists for. A generation reads the sticky flag,
    // then awaits a CLI subprocess for up to 30s, then writes. Without the
    // predicate in the UPDATE itself, a user picking an icon in that window has
    // their choice destroyed — and because the PATCH set icon_sticky on its way
    // through, the row is afterwards frozen on the GENERATOR's glyph forever:
    // the sticky flag protecting the very value it was set to prevent.
    const out = await maybeWriteHeadline(
      db,
      tabId,
      paneId,
      async () => {
        // Exactly what a PATCH /tabs/:id {icon} does, mid-flight.
        tabs.update(tabId, { icon: '🦊' });
        tabs.setIconSticky(tabId);
        return 'LABEL: cron restarts\nICON: ⏰';
      },
      { now: 1_000 },
    );
    expect(out.icon).toBeNull();
    expect(tabs.getById(tabId)?.icon).toBe('🦊');
    expect(tabs.iconAt(tabId)).toBeNull();
    // The HEADLINE still lands — stickiness is about the glyph only.
    expect(out.headline).toBe('cron restarts');
  });

  it('stores the canonical form of a bare text-presentation glyph', async () => {
    // ⚙ / 🛠 / ⏱ are what a model actually types, and they render as
    // monochrome text without a variation selector.
    const out = await maybeWriteHeadline(db, tabId, paneId, reply('gear ratios', '⚙'), {
      now: 1_000,
    });
    expect(out.icon).toBe('⚙\uFE0F');
    expect(tabs.getById(tabId)?.icon).toBe('⚙\uFE0F');
  });

  it('degrades to headline-only against a model that ignores the format', async () => {
    const out = await maybeWriteHeadline(
      db,
      tabId,
      paneId,
      async () => 'cron restart persistence',
      { now: 1_000 },
    );
    expect(out).toEqual({ headline: 'cron restart persistence', icon: null });
    expect(tabs.getById(tabId)?.icon).toBeUndefined();
  });

  it('tells the model what glyph is on the row, and to keep it', async () => {
    tabs.setIcon(tabId, '⏰', 1_000);
    let seen = '';
    await maybeWriteHeadline(
      db,
      tabId,
      paneId,
      async (prompt) => {
        seen = prompt;
        return 'LABEL: KEEP\nICON: KEEP';
      },
      { now: 1_000 + ICON_MIN_STABLE_MS },
    );
    expect(seen).toContain('currently ⏰');
    expect(seen).toContain('ICON: KEEP');
  });

  it('tells the model the glyph is settled while it is frozen', async () => {
    tabs.setIcon(tabId, '⏰', 1_000);
    let seen = '';
    await maybeWriteHeadline(
      db,
      tabId,
      paneId,
      async (prompt) => {
        seen = prompt;
        return 'LABEL: KEEP\nICON: KEEP';
      },
      // Inside the window: the ask must not pretend the answer could matter.
      { now: 1_000 + HEADLINE_MIN_INTERVAL_MS },
    );
    expect(seen).toContain('not up for review');
  });
});

describe('backfillGeneratedIcons — clears the provenance stamp, never the glyph', () => {
  let dir: string;
  let db: Database.Database;
  let tabs: TabStore;
  let workspaceId: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'muxpad-icon-backfill-'));
    db = openDb(join(dir, 'db.sqlite'));
    workspaceId = new WorkspaceStore(db).create({ name: 'W' }).id;
    tabs = new TabStore(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** A tab wearing `icon`, as though created before this feature existed. */
  const mk = (name: string, icon?: string) => {
    const id = tabs.create({ name, workspace_id: workspaceId, layout: 'p' }).id;
    if (icon) db.prepare('UPDATE tabs SET icon = ? WHERE id = ?').run(icon, id);
    return id;
  };

  it('NEVER blanks a row — the rail keeps rendering what it renders today', () => {
    // The regression this function was rewritten to avoid. Nulling the icon
    // and falling back to DEFAULT_TAB_ICON would leave a twenty-row rail as a
    // column of identical folders for as long as those chats stayed quiet —
    // and FOREVER for tabs with no agent session, which produce no turns at
    // all. Random glyphs are meaningless but DISTINCT, and telling rows apart
    // by shape is the whole job of the column.
    const a = mk('muxpad', '👍');
    const b = mk('kipa', '👍');
    const c = mk('terminal', '🗝\uFE0F');

    backfillGeneratedIcons(db);

    expect(tabs.getById(a)?.icon).toBe('👍');
    expect(tabs.getById(b)?.icon).toBe('👍');
    expect(tabs.getById(c)?.icon).toBe('🗝\uFE0F');
  });

  it('leaves those rows eligible, which is the point of not stamping them', () => {
    // Eligibility is not something this function grants — `chooseIcon` grants
    // it, by treating any glyph it did not write as replaceable once the
    // headline moves. What the backfill guarantees is that `icon_at` is not
    // lying about which glyphs those are.
    const id = mk('muxpad', '👍');
    backfillGeneratedIcons(db);
    expect(tabs.iconAt(id)).toBeNull();
    expect(isIconFrozen({ sticky: false, iconAt: tabs.iconAt(id), now: Date.now() })).toBe(false);
    expect(
      chooseIcon({ frozen: false, current: '👍', proposed: '⏰', headlineChanged: true }),
    ).toBe('⏰');
  });

  it('clears a stale stamp on a non-sticky row', () => {
    const id = mk('muxpad', '👍');
    db.prepare('UPDATE tabs SET icon_at = ? WHERE id = ?').run(5_000, id);
    expect(backfillGeneratedIcons(db).cleared).toEqual([id]);
    expect(tabs.iconAt(id)).toBeNull();
    // The glyph is untouched. Only our claim to have written it is dropped.
    expect(tabs.getById(id)?.icon).toBe('👍');
  });

  it('GENERATES NOTHING', () => {
    // Mass generation at boot would be one model call per tab, all at once, on
    // a machine that has just started. The model seam is not reachable from
    // here; what this pins is that no icon VALUE moves.
    const id = mk('muxpad', '👍');
    backfillGeneratedIcons(db);
    expect(tabs.getById(id)?.icon).toBe('👍');
  });

  it('never touches a sticky icon, or its stamp', () => {
    const chosen = mk('mine', '👍');
    tabs.setIcon(chosen, '⏰', 5_000);
    tabs.setIconSticky(chosen);
    expect(backfillGeneratedIcons(db).cleared).not.toContain(chosen);
    expect(tabs.getById(chosen)?.icon).toBe('⏰');
    expect(tabs.iconAt(chosen)).toBe(5_000);
    expect(tabs.isIconSticky(chosen)).toBe(true);
  });

  it('is a no-op on an install upgraded through migration 25, and says so', () => {
    // Honest about its own size: migration 25 introduces `icon_at` as NULL and
    // nothing else writes it, so on a real upgrade there is nothing to clear.
    // It is kept as the marker-guarded hook the eligibility rule hangs off.
    mk('muxpad', '👍');
    mk('kipa', '🗝\uFE0F');
    mk('bare');
    expect(backfillGeneratedIcons(db).cleared).toEqual([]);
  });

  it('runs once — a stamp written after the backfill is never cleared', () => {
    const id = mk('muxpad', '👍');
    db.prepare('UPDATE tabs SET icon_at = ? WHERE id = ?').run(5_000, id);
    expect(backfillGeneratedIcons(db).cleared).toEqual([id]);

    // A later generation. The backfill must not come back for it on every
    // boot, or the stability window would reset whenever the server bounced.
    tabs.setIcon(id, '⏰', 9_000);
    expect(backfillGeneratedIcons(db)).toEqual({ cleared: [] });
    expect(tabs.iconAt(id)).toBe(9_000);
  });

  it('sets its marker even when there is nothing to do', () => {
    expect(backfillGeneratedIcons(db)).toEqual({ cleared: [] });
    expect(new GlobalsStore(db).get('tab_icon_backfill_v1')).toBe('1');
  });

  it('does not touch names, headlines or their stickiness', () => {
    const id = mk('Main', '👍');
    tabs.setHeadline(id, 'cron restart persistence', 5_000);
    tabs.setNameSticky(id);
    backfillGeneratedIcons(db);
    const tab = tabs.getById(id);
    expect(tab?.name).toBe('Main');
    expect(tab?.headline).toBe('cron restart persistence');
    expect(tabs.isNameSticky(id)).toBe(true);
    expect(tabs.headlineAt(id)).toBe(5_000);
  });
});
