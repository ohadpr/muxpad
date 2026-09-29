import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MuxpadEvent, Tab } from '@muxpad/shared';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventBus } from '../events.js';
import { PtydCache } from '../ptyd-cache.js';
import { AgentSessionStore } from '../store/AgentSessionStore.js';
import { PaneStore } from '../store/PaneStore.js';
import { SpawnRoundStore } from '../store/SpawnRoundStore.js';
import { TabStore } from '../store/TabStore.js';
import { WorkspaceStore } from '../store/WorkspaceStore.js';
import { openDb } from '../store/db.js';
import { ChatRetirer } from '../tab-retire.js';
import { SpawnReportWriter } from './SpawnReportWriter.js';

/**
 * The plumbing between a worker finishing and the card in its parent's log —
 * the part spawn-report.ts's own tests cannot see.
 *
 * Three things are decided here and nowhere else:
 *
 *   1. ONE in-flight generation per tab. A crash loop finishes turns faster than
 *      a model call returns.
 *   2. The emit, in both directions. A report landing has to reach the client NOW
 *      (the whole delivery path for the card is this one `tab.updated`), and
 *      nothing landing has to reach nobody.
 *   3. RETIREMENT DOES NOT WAIT. The row leaves the live list on the turn-end
 *      tick; the report arrives later.
 *
 * Driven through the real ChatRetirer rather than by calling the writer
 * directly, because "which finished workers actually reach this" is half of what
 * the feature is, and it is a wiring decision.
 */
describe('SpawnReportWriter — a finished worker becomes a card', () => {
  let dir: string;
  let prevDataDir: string | undefined;
  let db: Database.Database;
  let events: EventBus;
  let cache: PtydCache;
  let workspaceId: string;
  let seen: MuxpadEvent[];

  const GOOD = 'Counted the TODO comments: 41 across 6 files, listed in /tmp/todos.md.';

  /** A worker chat under `parent`, with a pane, a session and a transcript. */
  function worker(parent: string): { tabId: string; paneId: string } {
    const tabId = new TabStore(db).create({
      name: 'Work review',
      workspace_id: workspaceId,
      layout: '',
      spawned_by: parent,
    }).id;
    const paneId = new PaneStore(db).create({ tab_id: tabId, shell: '/bin/zsh', cwd: '/tmp' }).id;
    const sid = `sid-${paneId}`;
    new AgentSessionStore(db).register({ pane_id: paneId, assistant: 'codex', session_id: sid });
    writeFileSync(
      join(dir, 'agent-transcripts', `${sid}.jsonl`),
      `${[
        { id: '1', ts: 1, kind: 'user', text: 'count every TODO comment in the repo' },
        { id: '2', ts: 2, kind: 'assistant', text: 'found 41 in 6 files; wrote /tmp/todos.md' },
      ]
        .map((e) => JSON.stringify(e))
        .join('\n')}\n`,
    );
    return { tabId, paneId };
  }

  function parentChat(): string {
    return new TabStore(db).create({ name: 'muxpad', workspace_id: workspaceId, layout: '' }).id;
  }

  /** A retirer wired to a writer over `model`, as index.ts wires them. */
  function wire(model: (p: string, s: AbortSignal) => Promise<string>): {
    retirer: ChatRetirer;
    writer: SpawnReportWriter;
  } {
    const writer = new SpawnReportWriter({ db, events, cache, model });
    const retirer = new ChatRetirer({ db, cache, events, onFinished: writer.onFinished });
    return { retirer, writer };
  }

  /**
   * A worker's JOB ends — its last turn ends and it then stays quiet.
   *
   * A turn ending no longer reports anything on its own: it arms a settle, and
   * the report is generated when that fires, over a transcript that is
   * complete (see tab-retire.ts, `turn-end is not job-end`). These tests are
   * about the WRITER, so they say "the job finished" once, here, rather than
   * restating the mechanism at every call.
   */
  function finishJob(
    retirer: ChatRetirer,
    paneId: string,
    phase: 'done' | 'fatal' = 'done',
  ): boolean {
    retirer.onTurnEnded({ pane_id: paneId, phase });
    return retirer.settleNow(paneId);
  }

  const reports = (): Array<string | null | undefined> =>
    seen
      .filter((e): e is Extract<MuxpadEvent, { type: 'tab.updated' }> => e.type === 'tab.updated')
      .map((e) => (e.tab as Tab).spawn_report);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'muxpad-spawn-writer-'));
    prevDataDir = process.env.MUXPAD_DATA_DIR;
    process.env.MUXPAD_DATA_DIR = dir;
    mkdirSync(join(dir, 'agent-transcripts'), { recursive: true });
    db = openDb(join(dir, 'db.sqlite'));
    events = new EventBus();
    cache = new PtydCache();
    workspaceId = new WorkspaceStore(db).create({ name: 'W' }).id;
    seen = [];
    events.subscribe((e) => seen.push(e));
  });

  afterEach(() => {
    db.close();
    // biome-ignore lint/performance/noDelete: restoring an env var that wasn't set
    if (prevDataDir === undefined) delete process.env.MUXPAD_DATA_DIR;
    else process.env.MUXPAD_DATA_DIR = prevDataDir;
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes the report and publishes it on the row', async () => {
    const { retirer, writer } = wire(async () => GOOD);
    const kid = worker(parentChat());
    finishJob(retirer, kid.paneId);
    await writer.idle();
    expect(new TabStore(db).getById(kid.tabId)?.spawn_report).toBe(GOOD);
    // The one event the card's whole delivery path rests on.
    expect(reports()).toContain(GOOD);
  });

  it('RETIRES FIRST AND REPORTS AFTER — the row never waits on a model', async () => {
    // A model call is up to 30 seconds. The sidebar has to move on the same tick
    // the DECISION is taken, so this is a promise the row cannot be allowed to
    // hold. That tick is now the settle rather than the turn-end — what the
    // report must not delay is the retirement, whenever it happens, and the
    // ordering between the two is exactly as load-bearing as it always was.
    let release: (() => void) | null = null;
    const { retirer, writer } = wire(
      () =>
        new Promise<string>((resolve) => {
          release = () => resolve(GOOD);
        }),
    );
    const kid = worker(parentChat());
    expect(finishJob(retirer, kid.paneId)).toBe(true);
    // Retired, synchronously with the settle, and the report still in flight.
    expect(new TabStore(db).getById(kid.tabId)?.spawn_report).toBeUndefined();
    expect(
      seen.some((e) => e.type === 'tab.updated' && (e.tab as Tab).done_reason === 'delivered'),
    ).toBe(true);
    (release as unknown as () => void)();
    await writer.idle();
    expect(new TabStore(db).getById(kid.tabId)?.spawn_report).toBe(GOOD);
  });

  it('runs ONE generation per tab at a time', async () => {
    // A crashed worker finishes turns in a loop, and each one is a finish.
    let calls = 0;
    let release: (() => void) | null = null;
    const { retirer, writer } = wire(() => {
      calls++;
      return new Promise<string>((resolve) => {
        release = () => resolve(GOOD);
      });
    });
    const kid = worker(parentChat());
    finishJob(retirer, kid.paneId, 'fatal');
    finishJob(retirer, kid.paneId, 'fatal');
    finishJob(retirer, kid.paneId, 'fatal');
    expect(calls).toBe(1);
    (release as unknown as () => void)();
    await writer.idle();
  });

  it('is per TAB, not global — two workers finishing together both get one', async () => {
    // The busier install must not be the one that gets the worse cards.
    const { retirer, writer } = wire(async (prompt) =>
      prompt.includes('alpha')
        ? 'Reviewed the alpha branch and found two failing tests, both in /tmp/a.md.'
        : GOOD,
    );
    const parent = parentChat();
    const a = worker(parent);
    writeFileSync(
      join(dir, 'agent-transcripts', `sid-${a.paneId}.jsonl`),
      `${JSON.stringify({ id: '1', ts: 1, kind: 'user', text: 'review alpha' })}\n${JSON.stringify({
        id: '2',
        ts: 2,
        kind: 'assistant',
        text: 'two failures, wrote /tmp/a.md',
      })}\n`,
    );
    const b = worker(parent);
    finishJob(retirer, a.paneId);
    finishJob(retirer, b.paneId);
    await writer.idle();
    const tabs = new TabStore(db);
    expect(tabs.getById(a.tabId)?.spawn_report).toMatch(/alpha/);
    expect(tabs.getById(b.tabId)?.spawn_report).toBe(GOOD);
  });

  it('emits NOTHING when nothing was written', async () => {
    // An event per no-op is a repaint per no-op on every connected client. The
    // real no-op is a worker with NO TRANSCRIPT — nothing was attempted, so
    // there is nothing to say about it. (A rejected reply used to be filed here
    // too; it is now a `failed` state and it does reach the client. See below.)
    const { retirer, writer } = wire(async () => GOOD);
    const tabId = new TabStore(db).create({
      name: 'Silent',
      workspace_id: workspaceId,
      layout: '',
      spawned_by: parentChat(),
    }).id;
    const paneId = new PaneStore(db).create({ tab_id: tabId, shell: '/bin/zsh', cwd: '/tmp' }).id;
    finishJob(retirer, paneId);
    const before = seen.length;
    await writer.idle();
    expect(seen.length).toBe(before);
  });

  it('TELLS THE USER when a good summary was refused, instead of only the log', async () => {
    // The rejection used to live in server.log and nowhere else: the row kept a
    // NULL state, which the card could not tell apart from "not attempted yet",
    // so it drew "No summary was generated for this one" over work that HAD been
    // summarised and then thrown away by a length rule. Three real workers lost
    // their reports this way.
    const { retirer, writer } = wire(async () => 'x'.repeat(900));
    const kid = worker(parentChat());
    finishJob(retirer, kid.paneId);
    await writer.idle();
    const tab = new TabStore(db).getById(kid.tabId);
    expect(tab?.spawn_report_state).toBe('failed');
    expect(tab?.spawn_report).toBeNull();
    // …and it REACHES the client, which is the whole point of the state.
    expect(
      seen.some((e) => e.type === 'tab.updated' && (e.tab as Tab).spawn_report_state === 'failed'),
    ).toBe(true);
  });

  it('a `failed` state still counts as nothing for the retry', async () => {
    // `failed` is a write, so it is truthy, and reading it as success would have
    // silently undone the one retry a retired worker gets.
    let calls = 0;
    const { retirer, writer } = wire(async () => {
      calls++;
      if (calls === 1) throw new Error('transient');
      return GOOD;
    });
    const kid = worker(parentChat());
    finishJob(retirer, kid.paneId);
    await writer.idle();
    expect(calls).toBe(2);
    const tab = new TabStore(db).getById(kid.tabId);
    expect(tab?.spawn_report).toBe(GOOD);
    // The transient `failed` must not be left behind on the row.
    expect(tab?.spawn_report_state).toBe('ok');
  });

  it('RETRIES ONCE when the generation failed — a retired worker gets no second turn', async () => {
    // Three of six children in one afternoon had the attempt stamped and no
    // state at all, and re-running the real generator over one of those
    // transcripts produced a good report in 12.5 seconds. The failures were
    // transient; what made them permanent is that a RETIRED worker never
    // finishes another turn, so nothing ever called this again.
    let calls = 0;
    const { retirer, writer } = wire(async () => {
      calls++;
      if (calls === 1) throw new Error('transient');
      return GOOD;
    });
    const kid = worker(parentChat());
    finishJob(retirer, kid.paneId);
    await writer.idle();
    expect(calls).toBe(2);
    expect(new TabStore(db).getById(kid.tabId)?.spawn_report).toBe(GOOD);
  });

  it('retries ONCE, not forever — a broken install must not spin', async () => {
    let calls = 0;
    const { retirer, writer } = wire(async () => {
      calls++;
      throw new Error('no login');
    });
    const kid = worker(parentChat());
    finishJob(retirer, kid.paneId);
    await writer.idle();
    // …and a SECOND finished turn does not re-arm it either.
    finishJob(retirer, kid.paneId);
    await writer.idle();
    expect(calls).toBe(2);
  });

  it('does not retry a worker that simply had nothing to report', async () => {
    // `none` is an ANSWER, not a failure. Retrying it would spend a second call
    // to be told the same thing.
    let calls = 0;
    const { retirer, writer } = wire(async () => {
      calls++;
      return 'NOTHING';
    });
    const kid = worker(parentChat());
    finishJob(retirer, kid.paneId);
    await writer.idle();
    expect(calls).toBe(1);
  });

  it('SURVIVES A MODEL THAT THROWS — a failed report cannot fail a turn', async () => {
    const { retirer, writer } = wire(async () => {
      throw new Error('no login');
    });
    const kid = worker(parentChat());
    expect(finishJob(retirer, kid.paneId)).toBe(true);
    await expect(writer.idle()).resolves.toBeUndefined();
  });

  it('LABELS A WORKER FROM ITS FIRST TURN, off the bus', () => {
    // The card's label has to land at the START of the work. A card that is
    // unreadable until the job is over is the card this replaces — `status-line`
    // beside a dot and a spinner.
    const writer = new SpawnReportWriter({
      db,
      events,
      cache,
      model: async () => 'unused',
      taskModel: async () => 'Move the status line out of the composer',
    });
    writer.start();
    const kid = worker(parentChat());
    events.emit({
      type: 'agent_turn',
      pane_id: kid.paneId,
      phase: 'start',
      sid: null,
      backend: 'codex',
    });
    return writer.idle().then(() => {
      writer.stop();
      expect(new TabStore(db).getById(kid.tabId)?.spawn_task).toBe(
        'Move the status line out of the composer',
      );
    });
  });

  it('asks ONCE per worker, however many turns it runs', async () => {
    let calls = 0;
    const writer = new SpawnReportWriter({
      db,
      events,
      cache,
      model: async () => 'unused',
      taskModel: async () => {
        calls++;
        return 'Move the status line';
      },
    });
    writer.start();
    const kid = worker(parentChat());
    for (const phase of ['start', 'done', 'start'] as const) {
      events.emit({ type: 'agent_turn', pane_id: kid.paneId, phase, sid: null, backend: 'codex' });
    }
    await writer.idle();
    writer.stop();
    expect(calls).toBe(1);
  });

  it('leaves a TOP-LEVEL chat unlabelled — it is a conversation, not a task', async () => {
    let calls = 0;
    const writer = new SpawnReportWriter({
      db,
      events,
      cache,
      model: async () => 'unused',
      taskModel: async () => {
        calls++;
        return 'nope';
      },
    });
    writer.start();
    // With a REAL transcript, so the sub-chat guard is what stops this and not
    // an empty read — the mutation that deletes the guard has to go red.
    const top = new TabStore(db).create({ name: 'Main', workspace_id: workspaceId, layout: '' }).id;
    const pane = new PaneStore(db).create({ tab_id: top, shell: '/bin/zsh', cwd: '/tmp' }).id;
    new AgentSessionStore(db).register({
      pane_id: pane,
      assistant: 'codex',
      session_id: `sid-${pane}`,
    });
    writeFileSync(
      join(dir, 'agent-transcripts', `sid-${pane}.jsonl`),
      `${JSON.stringify({ id: '1', ts: 1, kind: 'user', text: 'what is the cash position' })}\n`,
    );
    events.emit({ type: 'agent_turn', pane_id: pane, phase: 'start', sid: null, backend: 'codex' });
    await writer.idle();
    writer.stop();
    expect(calls).toBe(0);
  });

  it('CLOSES THE ROUND at turn-end, and attaches the result when it lands', async () => {
    // Two moments, deliberately apart. The round closes SYNCHRONOUSLY — a
    // retirement must never sit behind a model call — and the sentences arrive
    // up to thirty seconds later and are attached to the round that ended.
    const { retirer, writer } = wire(async () => GOOD);
    const kid = worker(parentChat());
    const rounds = new SpawnRoundStore(db);
    rounds.open(kid.tabId, 100);

    finishJob(retirer, kid.paneId);
    // Closed already, before the model has answered.
    expect(rounds.openRound(kid.tabId)).toBeNull();
    expect(rounds.listByTab(kid.tabId)[0]?.report).toBeNull();

    await writer.idle();
    expect(rounds.listByTab(kid.tabId)[0]?.report).toBe(GOOD);
    expect(rounds.listByTab(kid.tabId)[0]?.report_state).toBe('ok');
  });

  it('does not invent a round for a worker that predates the table', async () => {
    // Every child that existed before rounds finishes turns with nothing open.
    // A round with no beginning would be worse than no round.
    const { retirer, writer } = wire(async () => GOOD);
    const kid = worker(parentChat());
    finishJob(retirer, kid.paneId);
    await writer.idle();
    expect(new SpawnRoundStore(db).listByTab(kid.tabId)).toEqual([]);
    // …and the tab row still carries the report, so nothing is lost while both
    // homes exist.
    expect(new TabStore(db).getById(kid.tabId)?.spawn_report).toBe(GOOD);
  });

  /**
   * THE GAP THE IN-PROCESS RETRY CANNOT REACH.
   *
   * That retry hangs off `onFinished`, and `onFinished` comes from a turn
   * ending. A worker that retired in a PREVIOUS process with its attempt stamped
   * and no summary is unreachable by it forever — none of its turns will ever
   * end again. Measured on the live database: four children sat permanently
   * empty this way. Their transcripts are still on disk, which is the only
   * reason this can work at all.
   */
  describe('recoverStuck — the boot sweep', () => {
    /** A child that retired with the attempt stamped and nothing to show. */
    function stuck(parent: string, state: 'failed' | null): { tabId: string; paneId: string } {
      const kid = worker(parent);
      const tabs = new TabStore(db);
      tabs.retire(kid.tabId, 'delivered');
      tabs.touchSpawnReportAt(kid.tabId, 1000);
      if (state)
        db.prepare('UPDATE tabs SET spawn_report_state = ? WHERE id = ?').run(state, kid.tabId);
      return kid;
    }

    it('RETRIES a worker that retired in an earlier process with no summary', async () => {
      const writer = new SpawnReportWriter({ db, events, cache, model: async () => GOOD });
      const kid = stuck(parentChat(), null);
      writer.recoverStuck();
      await writer.idle();
      const tab = new TabStore(db).getById(kid.tabId);
      expect(tab?.spawn_report).toBe(GOOD);
      expect(tab?.spawn_report_state).toBe('ok');
      // It has to REACH the client too — nobody is going to reload for it.
      expect(reports()).toContain(GOOD);
    });

    it('retries one whose summary was REFUSED, not only one that threw', async () => {
      const writer = new SpawnReportWriter({ db, events, cache, model: async () => GOOD });
      const kid = stuck(parentChat(), 'failed');
      writer.recoverStuck();
      await writer.idle();
      expect(new TabStore(db).getById(kid.tabId)?.spawn_report).toBe(GOOD);
    });

    it('leaves a worker that was never ATTEMPTED alone', async () => {
      // No `spawn_report_at` means nobody has got to it — every child that
      // retired before the feature existed looks like this, and re-summarising
      // the archive at every boot is exactly what the stamp guards against.
      let calls = 0;
      const writer = new SpawnReportWriter({
        db,
        events,
        cache,
        model: async () => {
          calls++;
          return GOOD;
        },
      });
      const kid = worker(parentChat());
      new TabStore(db).retire(kid.tabId, 'delivered');
      writer.recoverStuck();
      await writer.idle();
      expect(calls).toBe(0);
    });

    it('leaves a LIVE worker alone — it still has turns to end', async () => {
      let calls = 0;
      const writer = new SpawnReportWriter({
        db,
        events,
        cache,
        model: async () => {
          calls++;
          return GOOD;
        },
      });
      const kid = worker(parentChat());
      new TabStore(db).touchSpawnReportAt(kid.tabId, 1000);
      writer.recoverStuck();
      await writer.idle();
      expect(calls).toBe(0);
    });

    it('does not re-ask a worker that answered `none`, or one that crashed', async () => {
      // Both are ANSWERS. Re-asking spends a call to be told the same thing.
      let calls = 0;
      const writer = new SpawnReportWriter({
        db,
        events,
        cache,
        model: async () => {
          calls++;
          return GOOD;
        },
      });
      for (const state of ['none', 'crashed', 'awaiting'] as const) {
        const kid = stuck(parentChat(), null);
        db.prepare('UPDATE tabs SET spawn_report_state = ? WHERE id = ?').run(state, kid.tabId);
      }
      writer.recoverStuck();
      await writer.idle();
      expect(calls).toBe(0);
    });

    it('is BOUNDED — a boot must not become a model-call storm', async () => {
      let calls = 0;
      const writer = new SpawnReportWriter({
        db,
        events,
        cache,
        model: async () => {
          calls++;
          return GOOD;
        },
      });
      const parent = parentChat();
      for (let i = 0; i < 6; i++) stuck(parent, null);
      writer.recoverStuck(2);
      await writer.idle();
      expect(calls).toBe(2);
    });

    it('asks ONCE per worker even if the sweep runs again', async () => {
      let calls = 0;
      const writer = new SpawnReportWriter({
        db,
        events,
        cache,
        model: async () => {
          calls++;
          throw new Error('still broken');
        },
      });
      stuck(parentChat(), null);
      writer.recoverStuck();
      await writer.idle();
      writer.recoverStuck();
      await writer.idle();
      expect(calls).toBe(1);
    });
  });

  it('reports a CRASHED worker, which is the case retirement cannot see', async () => {
    const { retirer, writer } = wire(async () => 'Got through 38 of the files before dying.');
    const kid = worker(parentChat());
    expect(finishJob(retirer, kid.paneId, 'fatal')).toBe(false);
    await writer.idle();
    const tab = new TabStore(db).getById(kid.tabId);
    expect(tab?.spawn_report).toBe('Got through 38 of the files before dying.');
    expect(tab?.spawn_report_state).toBe('crashed');
  });
});
