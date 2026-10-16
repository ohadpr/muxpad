import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSpawnDelivery } from '@muxpad/shared';
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
import { ReportDelivery } from './report-delivery.js';

/**
 * A FINISHED WORKER REACHES ITS PARENT IN SECONDS — the whole chain, wired as
 * index.ts wires it: ChatRetirer → SpawnReportWriter → ReportDelivery.
 *
 * Written for a live failure: four workers whose results reached the
 * orchestrator 5h42m–7h51m after they finished, which stalled a release that
 * was waiting on two of them. Every one had the same shape —
 *
 *   1. a job handed over by `muxpad agent send`, with follow-ups QUEUED while
 *      the worker was mid-turn (they ride the open round);
 *   2. the job settled: round closed, summary written, delivered;
 *   3. a turn then started WITHOUT a message — a background command finishing
 *      — which reopened the round and threw that summary away;
 *   4. the real end closed it again inside the 30-minute report floor, the gate
 *      read it as a retry, and the round closed with NOTHING on it — out of the
 *      delivery queue until a restart's recovery sweep.
 *
 * …while siblings from earlier dispatches and the worker's own reviewer
 * (a grandchild) were still running, and the parent was mid-turn.
 */
describe('sub-chat delivery — a finished worker reaches its parent', () => {
  let dir: string;
  let prevDataDir: string | undefined;
  let db: Database.Database;
  let events: EventBus;
  let cache: PtydCache;
  let workspaceId: string;
  let sent: Array<{ paneId: string; text: string }>;

  const REPORT_ONE = 'Counted the TODO comments: 41 across 6 files, listed in /tmp/todos.md.';
  // These cite nothing — see SpawnReportWriter.test.ts SECOND for why.
  const REPORT_TWO = 'Then renamed the stale ones and pushed the branch.';
  const REPORT_THREE = 'Finally swept the duplicates and left a note for review.';

  function tab(name: string, spawnedBy?: string): string {
    return new TabStore(db).create({
      name,
      workspace_id: workspaceId,
      layout: '',
      ...(spawnedBy ? { spawned_by: spawnedBy } : {}),
    }).id;
  }

  function agentPane(tabId: string): string {
    return new PaneStore(db).create({
      tab_id: tabId,
      shell: '/bin/zsh',
      cwd: '/tmp',
      startup_cmd: 'muxpad agent run',
    }).id;
  }

  /** A worker with a pane, a session and a transcript the generator can read. */
  function worker(parent: string, name: string): { tabId: string; paneId: string } {
    const tabId = tab(name, parent);
    const paneId = agentPane(tabId);
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

  const tick = () => new Promise((r) => setTimeout(r, 5));

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'muxpad-subchat-delivery-'));
    prevDataDir = process.env.MUXPAD_DATA_DIR;
    process.env.MUXPAD_DATA_DIR = dir;
    mkdirSync(join(dir, 'agent-transcripts'), { recursive: true });
    db = openDb(join(dir, 'db.sqlite'));
    events = new EventBus();
    cache = new PtydCache();
    workspaceId = new WorkspaceStore(db).create({ name: 'W' }).id;
    sent = [];
  });

  afterEach(() => {
    db.close();
    // biome-ignore lint/performance/noDelete: restoring an env var that wasn't set
    if (prevDataDir === undefined) delete process.env.MUXPAD_DATA_DIR;
    else process.env.MUXPAD_DATA_DIR = prevDataDir;
    rmSync(dir, { recursive: true, force: true });
  });

  it('delivers a re-tasked worker’s result within seconds, every time it finishes', async () => {
    const answers = [REPORT_ONE, REPORT_TWO, REPORT_THREE];
    let calls = 0;
    const delivery = new ReportDelivery({
      db,
      // THE PARENT IS MID-TURN: the message queues behind its current turn.
      submitSend: (paneId, text) => {
        sent.push({ paneId, text });
        return { status: 'queued' };
      },
    });
    const writer = new SpawnReportWriter({
      db,
      events,
      cache,
      model: async () => answers[calls++] ?? REPORT_THREE,
      onReport: delivery.onReport,
    });
    const retirer = new ChatRetirer({ db, cache, events, onFinished: writer.onFinished });
    const rounds = new SpawnRoundStore(db);

    const parent = tab('orchestrator');
    const parentPane = agentPane(parent);
    // A SIBLING from an earlier dispatch, still running hours later.
    const sibling = worker(parent, 'web perf');
    rounds.open(sibling.tabId, Date.now() - 3 * 60 * 60_000);
    const kid = worker(parent, 'slack any channel');
    // The worker's own reviewer — a GRANDCHILD, still running.
    const grandchild = worker(kid.tabId, 'astra review');
    rounds.open(grandchild.tabId, Date.now());

    // ── 1. The job, with a follow-up queued mid-turn ─────────────────────────
    expect(rounds.open(kid.tabId)).not.toBeNull(); // agent send → noteUserMessage
    retirer.onTurnStart(kid.paneId);
    expect(rounds.open(kid.tabId)).toBeNull(); // queued send: same round
    retirer.onTurnEnded({ pane_id: kid.paneId, phase: 'done' });
    retirer.onTurnStart(kid.paneId); // the queued message drains into a turn
    retirer.onTurnEnded({ pane_id: kid.paneId, phase: 'done' });
    expect(retirer.settleNow(kid.paneId)).toBe(true);
    await writer.idle();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.paneId).toBe(parentPane);
    expect(parseSpawnDelivery(sent[0]?.text ?? '')?.marker.from).toEqual([kid.tabId]);
    expect(sent[0]?.text).toContain(REPORT_ONE);

    // ── 2. Background commands finish: turns with no message ───────────────
    // TWICE, because the first is masked: the writer's one forced retry per
    // worker per process pushes it past the gate. The second is where every
    // live case was — the retry spent, the round closed empty, and the parent
    // told nothing until the next restart.
    for (const [i, report] of [REPORT_TWO, REPORT_THREE].entries()) {
      await tick();
      retirer.onTurnStart(kid.paneId);
      retirer.onTurnEnded({ pane_id: kid.paneId, phase: 'done' });
      expect(retirer.settleNow(kid.paneId)).toBe(true);
      await writer.idle();

      // The real end of the job reaches the parent NOW, not at the next restart.
      expect(sent).toHaveLength(i + 2);
      const delivered = parseSpawnDelivery(sent[i + 1]?.text ?? '');
      expect(delivered?.marker).toEqual({ count: 1, from: [kid.tabId] });
      expect(delivered?.body).toContain(report);
    }
    expect(rounds.listByTab(kid.tabId).map((r) => r.delivered_at !== null)).toEqual([true]);
    retirer.stop();
  });
});
