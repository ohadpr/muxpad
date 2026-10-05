import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSpawnDelivery } from '@muxpad/shared';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SpawnRoundStore } from '../store/SpawnRoundStore.js';
import { openDb } from '../store/db.js';
import { BATCH_MAX_HOLD_MS, ReportDelivery, type SubmitSendResult } from './report-delivery.js';

/**
 * THE JOIN. A finished sub-chat's result has never reached its parent's AGENT —
 * only a bold row in the sidebar — so an orchestrator had to hold a background
 * `muxpad agent wait` per child or learn nothing.
 *
 * The tests below are written against the two things that make this feature
 * dangerous rather than merely useful:
 *
 *   DOUBLE DELIVERY   an orchestrator handed the same batch twice does the work
 *                     twice. Hence stamp-before-send.
 *   A HELD BATCH      a barrier that waits on a sibling whose runner died holds
 *                     its siblings' reports forever, which is strictly worse
 *                     than the silence this replaces. Hence the bounded hold.
 */
describe('report delivery — the join', () => {
  let dir: string;
  let db: Database.Database;
  let sent: Array<{ paneId: string; text: string }>;
  let result: SubmitSendResult;
  let clock: number;

  const NOW = 1_800_000_000_000;
  const rounds = () => new SpawnRoundStore(db);

  function make(): ReportDelivery {
    return new ReportDelivery({
      db,
      submitSend: (paneId, text) => {
        sent.push({ paneId, text });
        return result;
      },
      now: () => clock,
    });
  }

  /** A parent chat with a runner-owned agent pane — a real orchestrator. */
  function parent(id: string, opts: { agent?: boolean } = {}): string {
    db.prepare(
      'INSERT INTO tabs (id, slug, name, layout, workspace_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
    ).run(id, id, `tab-${id}`, JSON.stringify(`p-${id}`), 'w1', NOW, NOW);
    db.prepare(
      'INSERT INTO panes (id, tab_id, shell, startup_cmd, created_at) VALUES (?,?,?,?,?)',
    ).run(`p-${id}`, id, '/bin/zsh', opts.agent === false ? null : 'muxpad agent', NOW);
    return id;
  }

  /** A child of `parentId`, with one round in whatever state the test needs. */
  function child(
    id: string,
    parentId: string,
    round: { ended?: number | null; report?: string | null; state?: string | null } = {},
  ): string {
    db.prepare(
      `INSERT INTO tabs (id, slug, name, layout, workspace_id, created_at, updated_at, spawned_by, spawn_task)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run(id, id, `tab-${id}`, JSON.stringify(`p-${id}`), 'w1', NOW, NOW, parentId, `task ${id}`);
    db.prepare(
      'INSERT INTO panes (id, tab_id, shell, startup_cmd, created_at) VALUES (?,?,?,?,?)',
    ).run(`p-${id}`, id, '/bin/zsh', 'muxpad agent', NOW);
    const ended = round.ended === undefined ? NOW + 1000 : round.ended;
    db.prepare(
      `INSERT INTO spawn_rounds (id, tab_id, started_at, ended_at, report, report_state)
       VALUES (?,?,?,?,?,?)`,
    ).run(
      `r-${id}`,
      id,
      NOW,
      ended,
      round.report === undefined ? `report from ${id}` : round.report,
      round.state === undefined ? 'ok' : round.state,
    );
    return id;
  }

  const delivered = (id: string) =>
    (
      db.prepare('SELECT delivered_at FROM spawn_rounds WHERE id = ?').get(`r-${id}`) as {
        delivered_at: number | null;
      }
    ).delivered_at;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'join-'));
    db = openDb(join(dir, 'db.sqlite'));
    db.prepare(
      'INSERT INTO workspaces (id, slug, name, created_at, updated_at) VALUES (?,?,?,?,?)',
    ).run('w1', 'w1', 'W', NOW, NOW);
    sent = [];
    result = { status: 'sent' };
    clock = NOW + 2000;
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("delivers a lone child's report into the parent's agent pane", () => {
    const p = parent('P');
    child('c1', p);
    const r = make().sweep();

    expect(r.delivered).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.paneId).toBe('p-P');
    const parsed = parseSpawnDelivery(sent[0]?.text ?? '');
    expect(parsed?.marker).toEqual({ count: 1, from: ['c1'] });
    expect(parsed?.body).toContain('report from c1');
    // Named by its task label — the same words the parent's own card uses.
    expect(parsed?.body).toContain('task c1');
    expect(delivered('c1')).toBe(clock);
  });

  it('delivers a whole fan-out as ONE message, not one per child', () => {
    // The reason the barrier exists: 23 children landing as 23 sends is 23
    // turns, and the orchestrator asked for a join.
    const p = parent('P');
    for (const n of ['a', 'b', 'c']) child(n, p);
    const r = make().sweep();

    expect(r.delivered).toBe(3);
    expect(sent).toHaveLength(1);
    expect(parseSpawnDelivery(sent[0]?.text ?? '')?.marker.count).toBe(3);
  });

  it('HOLDS a finished child while a sibling is still mid-round', () => {
    const p = parent('P');
    child('done', p);
    child('working', p, { ended: null, report: null, state: null });

    const r = make().sweep();
    expect(r).toEqual({ delivered: 0, abandoned: 0, held: 1 });
    expect(sent).toHaveLength(0);
    expect(delivered('done')).toBeNull();
  });

  it('…and delivers the batch once that sibling lands', () => {
    const p = parent('P');
    child('done', p);
    child('working', p, { ended: null, report: null, state: null });
    const d = make();
    d.sweep();
    expect(sent).toHaveLength(0);

    // The straggler finishes: round closes, report lands.
    db.prepare(
      "UPDATE spawn_rounds SET ended_at = ?, report = 'late', report_state = 'ok' WHERE id = 'r-working'",
    ).run(NOW + 5000);
    d.onReport('working');

    expect(sent).toHaveLength(1);
    expect(parseSpawnDelivery(sent[0]?.text ?? '')?.marker.count).toBe(2);
  });

  it('BREAKS THE HOLD past the ceiling — a wedged sibling must not eat the batch', () => {
    // The failure mode that would make this feature worse than silence: a
    // worker whose runner died leaves its round open forever, and a barrier
    // with no ceiling waits on it forever.
    const p = parent('P');
    child('done', p);
    child('wedged', p, { ended: null, report: null, state: null });
    const d = make();
    expect(d.sweep().held).toBe(1);

    clock = NOW + 1000 + BATCH_MAX_HOLD_MS + 1;
    const r = d.sweep();

    expect(r.delivered).toBe(1);
    expect(sent).toHaveLength(1);
    // The straggler is NOT in it, and is still owed a delivery of its own.
    expect(parseSpawnDelivery(sent[0]?.text ?? '')?.marker.from).toEqual(['done']);
    expect(delivered('wedged')).toBeNull();
  });

  it('NEVER delivers the same round twice', () => {
    const p = parent('P');
    child('c1', p);
    const d = make();
    d.sweep();
    d.sweep();
    d.onReport('c1');

    expect(sent).toHaveLength(1);
  });

  it('reverts the stamp when the send is refused, and retries later', () => {
    // Stamp-first is what makes double delivery impossible; this is the other
    // half of that trade — a refusal must not silently eat the report.
    const p = parent('P');
    child('c1', p);
    result = { status: 'rejected', reason: 'too many queued messages' };
    const d = make();

    expect(d.sweep()).toEqual({ delivered: 0, abandoned: 0, held: 1 });
    expect(delivered('c1')).toBeNull();

    result = { status: 'sent' };
    expect(d.sweep().delivered).toBe(1);
    expect(sent).toHaveLength(2); // one refused, one accepted
  });

  it('counts a QUEUED send as delivered — it arrives when the turn ends', () => {
    const p = parent('P');
    child('c1', p);
    result = { status: 'queued' };
    expect(make().sweep().delivered).toBe(1);
    expect(delivered('c1')).toBe(clock);
  });

  it('settles a round whose parent has no agent pane, rather than retrying forever', () => {
    // A tab whose chat face is a plain terminal is a legitimate parent and has
    // nowhere to put a message. Left NULL it would be re-examined every sweep
    // until the database is deleted.
    const p = parent('P', { agent: false });
    child('c1', p);

    expect(make().sweep()).toEqual({ delivered: 0, abandoned: 1, held: 0 });
    expect(sent).toHaveLength(0);
    expect(delivered('c1')).toBe(clock);
  });

  it('DELIVERS to a nested orchestrator that already retired — it gets revived', () => {
    // The hole this closes. A worker that spawns its own workers ends its turn
    // as soon as it has nothing left to do but wait, and `stillWorking` does not
    // know about child CHATS — so it retires `delivered` while its children run.
    // Reading "has left the live list" here would abandon every one of their
    // reports, and the nested case would look like the feature never happened.
    // A message into a retired chat revives it, which is exactly what
    // `muxpad agent send` does to re-task a finished worker.
    const p = parent('P');
    child('c1', p);
    db.prepare("UPDATE tabs SET retired_at = ?, retired_reason = 'delivered' WHERE id = ?").run(
      NOW,
      p,
    );

    expect(make().sweep().delivered).toBe(1);
    expect(sent).toHaveLength(1);
  });

  it('…but NOT to one the user archived by hand', () => {
    // `archived` is the one reason that is a person's decision rather than a
    // lifecycle event. Waking a chat because they tidied it is the app arguing.
    const p = parent('P');
    child('c1', p);
    db.prepare("UPDATE tabs SET retired_at = ?, retired_reason = 'archived' WHERE id = ?").run(
      NOW,
      p,
    );

    expect(make().sweep().abandoned).toBe(1);
    expect(sent).toHaveLength(0);
  });

  it('ignores a closed round that has no result yet', () => {
    // The report is a model call up to 30s behind the round closing. Delivering
    // here would hand the parent an empty section.
    const p = parent('P');
    child('c1', p, { report: null, state: null });

    expect(make().sweep()).toEqual(EMPTY_FLUSH);
    expect(sent).toHaveLength(0);
    expect(delivered('c1')).toBeNull();
  });

  it('DOES deliver a crashed worker that produced no report', () => {
    // The case `muxpad agent wait` cannot cover and the whole reason the server
    // is the author: a worker that crashed never reaches a reporting step, and
    // that is exactly when the parent most needs telling.
    const p = parent('P');
    child('c1', p, { report: null, state: 'crashed' });

    expect(make().sweep().delivered).toBe(1);
    expect(sent[0]?.text).toContain('CRASHED');
  });

  it('does not deliver a child to an unrelated chat', () => {
    const a = parent('A');
    const b = parent('B');
    child('ca', a);
    child('cb', b);
    make().sweep();

    const byPane = new Map(sent.map((s) => [s.paneId, s.text]));
    expect(byPane.get('p-A')).toContain('ca');
    expect(byPane.get('p-A')).not.toContain('report from cb');
    expect(byPane.get('p-B')).toContain('cb');
  });

  it("a top-level chat with no parent is nobody's child", () => {
    parent('P');
    db.prepare(
      `INSERT INTO spawn_rounds (id, tab_id, started_at, ended_at, report, report_state)
       VALUES ('r-top','P',?,?,'x','ok')`,
    ).run(NOW, NOW + 1);

    expect(make().sweep()).toEqual(EMPTY_FLUSH);
    expect(sent).toHaveLength(0);
  });

  it('a refusal cannot resurrect a round delivered EARLIER', () => {
    // `undeliver` is scoped to the stamp it is undoing. A blanket clear by id
    // would un-deliver an older round caught in the same batch read and re-send
    // a result the parent already acted on.
    const p = parent('P');
    child('old', p);
    const d = make();
    d.sweep(); // 'old' goes out for real
    expect(delivered('old')).toBe(clock);

    // A new sibling finishes, and THIS send is refused.
    clock += 1000;
    child('new', p);
    result = { status: 'rejected', reason: 'queue full' };
    d.sweep();

    // The refused one is owed again; the earlier one keeps its stamp.
    expect(delivered('new')).toBeNull();
    expect(delivered('old')).toBe(clock - 1000);
  });

  it('refuses to deliver a tab its OWN report — a self-parent is a loop', () => {
    // Delivering here opens a round on the same tab, which reports, which is
    // handed back: not a cosmetic oddity but an infinite loop. `spawned_by` is
    // not a foreign key, so nothing else rules this out.
    const p = parent('P');
    db.prepare('UPDATE tabs SET spawned_by = ? WHERE id = ?').run(p, p);
    db.prepare(
      `INSERT INTO spawn_rounds (id, tab_id, started_at, ended_at, report, report_state)
       VALUES ('r-self',?,?,?,'mine','ok')`,
    ).run(p, NOW, NOW + 1);

    expect(make().sweep()).toEqual(EMPTY_FLUSH);
    expect(sent).toHaveLength(0);
  });

  it('survives a send that throws, leaving the round owed', () => {
    const p = parent('P');
    child('c1', p);
    const d = new ReportDelivery({
      db,
      submitSend: () => {
        throw new Error('relay exploded');
      },
      now: () => clock,
    });

    expect(() => d.sweep()).not.toThrow();
    expect(delivered('c1')).toBeNull();
  });

  it('onReport on an unknown tab is a no-op, not a throw', () => {
    expect(() => make().onReport('nope')).not.toThrow();
  });

  it('a reopened round is owed a FRESH delivery', () => {
    // `reopen` means the job was not over after all; it discards the premature
    // report, and the real one lands at the real end.
    const p = parent('P');
    child('c1', p);
    make().sweep();
    expect(delivered('c1')).toBe(clock);

    rounds().reopen('c1');
    expect(delivered('c1')).toBeNull();
  });
});

const EMPTY_FLUSH = { delivered: 0, abandoned: 0, held: 0 };
