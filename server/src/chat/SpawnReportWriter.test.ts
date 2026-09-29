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
    retirer.onTurnEnded({ pane_id: kid.paneId, phase: 'done' });
    await writer.idle();
    expect(new TabStore(db).getById(kid.tabId)?.spawn_report).toBe(GOOD);
    // The one event the card's whole delivery path rests on.
    expect(reports()).toContain(GOOD);
  });

  it('RETIRES FIRST AND REPORTS AFTER — the row never waits on a model', async () => {
    // A model call is up to 30 seconds. The sidebar has to move on the same tick
    // it does today, so this is a promise the row cannot be allowed to hold.
    let release: (() => void) | null = null;
    const { retirer, writer } = wire(
      () =>
        new Promise<string>((resolve) => {
          release = () => resolve(GOOD);
        }),
    );
    const kid = worker(parentChat());
    expect(retirer.onTurnEnded({ pane_id: kid.paneId, phase: 'done' })).toBe(true);
    // Retired, synchronously, with the report still in flight.
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
    retirer.onTurnEnded({ pane_id: kid.paneId, phase: 'fatal' });
    retirer.onTurnEnded({ pane_id: kid.paneId, phase: 'fatal' });
    retirer.onTurnEnded({ pane_id: kid.paneId, phase: 'fatal' });
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
    retirer.onTurnEnded({ pane_id: a.paneId, phase: 'done' });
    retirer.onTurnEnded({ pane_id: b.paneId, phase: 'done' });
    await writer.idle();
    const tabs = new TabStore(db);
    expect(tabs.getById(a.tabId)?.spawn_report).toMatch(/alpha/);
    expect(tabs.getById(b.tabId)?.spawn_report).toBe(GOOD);
  });

  it('emits NOTHING when nothing was written', async () => {
    // A rejected reply leaves the row exactly as it was, and an event per no-op
    // is a repaint per no-op on every connected client.
    const { retirer, writer } = wire(async () => "Sure! I'd be happy to help with that.");
    const kid = worker(parentChat());
    retirer.onTurnEnded({ pane_id: kid.paneId, phase: 'done' });
    const before = seen.length;
    await writer.idle();
    expect(seen.length).toBe(before);
  });

  it('SURVIVES A MODEL THAT THROWS — a failed report cannot fail a turn', async () => {
    const { retirer, writer } = wire(async () => {
      throw new Error('no login');
    });
    const kid = worker(parentChat());
    expect(retirer.onTurnEnded({ pane_id: kid.paneId, phase: 'done' })).toBe(true);
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

  it('reports a CRASHED worker, which is the case retirement cannot see', async () => {
    const { retirer, writer } = wire(async () => 'Got through 38 of the files before dying.');
    const kid = worker(parentChat());
    expect(retirer.onTurnEnded({ pane_id: kid.paneId, phase: 'fatal' })).toBe(false);
    await writer.idle();
    const tab = new TabStore(db).getById(kid.tabId);
    expect(tab?.spawn_report).toBe('Got through 38 of the files before dying.');
    expect(tab?.spawn_report_state).toBe('crashed');
  });
});
