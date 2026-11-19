import type Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../store/db.js';
import { CronStore } from './CronStore.js';
import { DELIVERY_ATTEMPTS, ResultDelivery, renderResult } from './result-delivery.js';

/**
 * A SCHEDULED JOB'S RESULT, AND WHETHER IT ARRIVED.
 *
 * The failure these are written against: `opening-review` fired every morning
 * from 21 to 29 October, logged `sent` nine times, and talked to nobody. "The
 * submit succeeded" and "a person read it" were one fact, and only the first
 * one was ever recorded.
 *
 * So the dangerous directions here are the opposite of the obvious one:
 *
 *   SILENCE MUST SURVIVE   a watcher that finds nothing must still say
 *                          nothing. Delivering a fire's ordinary prose would
 *                          turn every "no change" check into a daily message.
 *   DOUBLE DELIVERY        a result sent twice is a duplicate digest. Hence
 *                          the stamp, and hence `queued` counting as arrived.
 *   A SILENT FAILURE       the original bug. A result that cannot land must
 *                          make the run FAIL, not look healthy.
 */
describe('cron result delivery', () => {
  let db: Database.Database;
  let store: CronStore;
  let sent: Array<{ paneId: string; text: string }>;
  let status: 'sent' | 'queued' | 'rejected';
  let clock: number;

  const NOW = 1_800_000_000_000;

  const make = () =>
    new ResultDelivery({
      db,
      store,
      submitSend: (paneId, text) => {
        sent.push({ paneId, text });
        return { status };
      },
      now: () => clock,
    });

  /** A chat with an agent pane in it — somewhere a result can actually land. */
  const chat = (id: string, opts: { agent?: boolean } = {}) => {
    db.prepare(
      'INSERT INTO workspaces (id, slug, name, created_at, updated_at) VALUES (?,?,?,0,0)',
    ).run(`ws-${id}`, `ws-${id}`, 'W');
    db.prepare(
      `INSERT INTO tabs (id, slug, name, layout, workspace_id, created_at, updated_at)
       VALUES (?,?,?,?,?,0,0)`,
    ).run(id, id.toLowerCase(), id, JSON.stringify(`p-${id}`), `ws-${id}`);
    db.prepare(
      'INSERT INTO panes (id, tab_id, kind, shell, cwd, created_at) VALUES (?,?,?,?,?,0)',
    ).run(`p-${id}`, id, opts.agent === false ? 'shell' : 'agent', '/bin/zsh', '/tmp');
    return id;
  };

  const cron = (opts: { resultTab?: string | null } = {}) =>
    store.create({
      name: 'opening-review',
      schedule: '0 7 * * 1-5',
      tz: 'UTC',
      prompt: 'read the market',
      target_kind: 'new-tab',
      workspace_id: 'ws-DEST',
      next_due_at: NOW,
      ...(opts.resultTab !== undefined ? { result_tab: opts.resultTab } : {}),
    });

  /** A fire that spoke, ready to be handed over. */
  const firedWithResult = (cronId: string, result: string) => {
    const run = store.addRun({
      cron_id: cronId,
      due_at: NOW,
      fired_at: NOW,
      outcome: 'sent',
    });
    store.setRunResult(run.id, result);
    return run.id;
  };

  const runOf = (id: string) => store.runById(id);

  beforeEach(() => {
    db = openDb(':memory:');
    store = new CronStore(db);
    sent = [];
    status = 'sent';
    clock = NOW + 60_000;
    chat('DEST');
  });

  describe('silence, which must survive all of this', () => {
    it('delivers nothing for a fire that said nothing', () => {
      // The common case, every weekday, for every watcher. `result` is null
      // and there is no row in the outbox at all.
      const c = cron({ resultTab: 'DEST' });
      store.addRun({ cron_id: c.id, due_at: NOW, fired_at: NOW, outcome: 'sent' });
      expect(make().sweep()).toEqual({ delivered: 0, held: 0, failed: 0 });
      expect(sent).toEqual([]);
    });

    it('delivers nothing for a schedule with no destination, even if it spoke', () => {
      // Declaring a destination is opt-in. Without one the spoken text stays
      // in the run's own chat, which is exactly today's behaviour.
      const c = cron({ resultTab: null });
      firedWithResult(c.id, 'SPX +0.4%');
      expect(make().sweep().delivered).toBe(0);
      expect(sent).toEqual([]);
    });

    it('stops delivering when the destination is cleared', () => {
      // The row keeps its text and stays undelivered — the honest record —
      // rather than being sent somewhere nobody asked for.
      const c = cron({ resultTab: 'DEST' });
      const run = firedWithResult(c.id, 'SPX +0.4%');
      store.setResultTab(c.id, null);
      expect(make().sweep().delivered).toBe(0);
      expect(runOf(run)?.delivered_at).toBeNull();
      expect(runOf(run)?.result).toBe('SPX +0.4%');
    });
  });

  describe('handing one over', () => {
    it('sends it to the destination chat and stamps the receipt', () => {
      const c = cron({ resultTab: 'DEST' });
      const run = firedWithResult(c.id, 'SPX +0.4% · VIX 13.1');
      expect(make().sweep()).toEqual({ delivered: 1, held: 0, failed: 0 });
      expect(sent).toEqual([
        { paneId: 'p-DEST', text: renderResult('opening-review', 'SPX +0.4% · VIX 13.1') },
      ]);
      expect(runOf(run)?.delivered_at).toBe(clock);
    });

    it('names the schedule, so a paragraph arriving has provenance', () => {
      const c = cron({ resultTab: 'DEST' });
      firedWithResult(c.id, 'SPX +0.4%');
      make().sweep();
      expect(sent[0]?.text).toContain('opening-review');
      expect(sent[0]?.text).toContain('SPX +0.4%');
    });

    it('resolves the destination PANE at send time, not from a frozen id', () => {
      // The other half of the fix. Two watchers currently forward results by
      // embedding `muxpad agent send <paneId>` in their prompt text, which is
      // correct until that pane is replaced by a respawn or a backend switch.
      const c = cron({ resultTab: 'DEST' });
      firedWithResult(c.id, 'first');
      make().sweep();
      expect(sent[0]?.paneId).toBe('p-DEST');

      db.prepare('DELETE FROM panes WHERE id = ?').run('p-DEST');
      db.prepare(
        'INSERT INTO panes (id, tab_id, kind, shell, cwd, created_at) VALUES (?,?,?,?,?,1)',
      ).run('p-DEST-2', 'DEST', 'agent', '/bin/zsh', '/tmp');
      firedWithResult(c.id, 'second');
      make().sweep();
      expect(sent[1]?.paneId).toBe('p-DEST-2');
    });

    it('does not send the same result twice', () => {
      // A duplicate digest is the cost of stamping late. Two sweeps, one send.
      const c = cron({ resultTab: 'DEST' });
      firedWithResult(c.id, 'SPX +0.4%');
      const d = make();
      d.sweep();
      clock += 60_000;
      d.sweep();
      expect(sent).toHaveLength(1);
    });

    it('counts a QUEUED send as arrived', () => {
      // The queue is durable and drains on the runner's hello — the same path
      // a message from a phone takes. Holding the stamp back would re-send on
      // the next sweep and deliver twice.
      status = 'queued';
      const c = cron({ resultTab: 'DEST' });
      const run = firedWithResult(c.id, 'SPX +0.4%');
      expect(make().sweep().delivered).toBe(1);
      expect(runOf(run)?.delivered_at).toBe(clock);
    });

    it('drains a backlog oldest first', () => {
      // Two mornings read at once want yesterday above today.
      const c = cron({ resultTab: 'DEST' });
      const first = store.addRun({
        cron_id: c.id,
        due_at: NOW,
        fired_at: NOW,
        outcome: 'sent',
      });
      store.setRunResult(first.id, 'monday');
      const second = store.addRun({
        cron_id: c.id,
        due_at: NOW + 86_400_000,
        fired_at: NOW + 86_400_000,
        outcome: 'sent',
      });
      store.setRunResult(second.id, 'tuesday');
      make().sweep();
      expect(sent.map((x) => x.text.includes('monday'))).toEqual([true, false]);
    });
  });

  describe('a result that cannot land', () => {
    it('is retried, and only then fails the run', () => {
      // NOT on the first rejection: a runner mid-restart refuses, and failing
      // a schedule for that would cry wolf on every respawn.
      status = 'rejected';
      const c = cron({ resultTab: 'DEST' });
      const run = firedWithResult(c.id, 'SPX +0.4%');
      const d = make();
      for (let i = 1; i < DELIVERY_ATTEMPTS; i++) {
        expect(d.sweep()).toEqual({ delivered: 0, held: 1, failed: 0 });
        expect(runOf(run)?.outcome).toBe('sent');
      }
      expect(d.sweep()).toEqual({ delivered: 0, held: 0, failed: 1 });
      expect(runOf(run)?.outcome).toBe('failed');
      expect(runOf(run)?.detail).toContain('undelivered');
    });

    it('fails the run even though the turn already settled it as done', () => {
      // THE TRAP I WALKED INTO WRITING THIS. `finishRun` only moves a row
      // still reading `sent`/`queued`, and by the time a delivery has been
      // given up on, the turn-end has already written `done`. Routing this
      // through `finishRun` would have done nothing at all, and the schedule
      // would go on looking healthy while nobody heard from it — which is the
      // bug, reintroduced by its own fix.
      status = 'rejected';
      const c = cron({ resultTab: 'DEST' });
      const run = firedWithResult(c.id, 'SPX +0.4%');
      store.finishRun(run, 'done');
      expect(runOf(run)?.outcome).toBe('done');
      const d = make();
      for (let i = 0; i < DELIVERY_ATTEMPTS; i++) d.sweep();
      expect(runOf(run)?.outcome).toBe('failed');
    });

    it('counts toward the schedule’s failure streak, so it reaches the auto-disable', () => {
      // A destination that is permanently wrong must not fail politely for
      // ever. Same reasoning as the never-started sweep.
      status = 'rejected';
      const c = cron({ resultTab: 'DEST' });
      firedWithResult(c.id, 'SPX +0.4%');
      const d = make();
      for (let i = 0; i < DELIVERY_ATTEMPTS; i++) d.sweep();
      expect(store.getById(c.id)?.fail_streak).toBe(1);
    });

    it('holds when the destination has no agent in it', () => {
      // A terminal or a web view cannot be told anything. Treated as an
      // attempt rather than an instant failure, because a chat whose runner
      // is still coming up looks exactly like this for a few seconds.
      chat('TERM', { agent: false });
      const c = cron({ resultTab: 'TERM' });
      const run = firedWithResult(c.id, 'SPX +0.4%');
      expect(make().sweep()).toEqual({ delivered: 0, held: 1, failed: 0 });
      expect(sent).toEqual([]);
      expect(runOf(run)?.delivered_at).toBeNull();
    });

    it('never marks a DELIVERED result failed, however late the sweep', () => {
      const c = cron({ resultTab: 'DEST' });
      const run = firedWithResult(c.id, 'SPX +0.4%');
      make().sweep();
      expect(runOf(run)?.delivered_at).toBe(clock);
      store.failDelivery(run, 'too late');
      expect(runOf(run)?.outcome).toBe('sent');
    });

    it('says so loudly when the destination chat has been deleted', () => {
      // I expected the row to be dropped here, and wrote the test that way.
      // It is not: `result_tab` still names the deleted id, and the outbox
      // joins runs to SCHEDULES rather than to tabs. Which is the better
      // behaviour, so the expectation moved rather than the code — a
      // destination that will never come back should reach the fail streak
      // and the auto-disable, not be quietly swallowed. Quietly swallowing it
      // is the original bug wearing a different hat.
      const c = cron({ resultTab: 'DEST' });
      const run = firedWithResult(c.id, 'SPX +0.4%');
      db.prepare('DELETE FROM tabs WHERE id = ?').run('DEST');
      const d = make();
      expect(d.sweep()).toEqual({ delivered: 0, held: 1, failed: 0 });
      for (let i = 1; i < DELIVERY_ATTEMPTS; i++) d.sweep();
      expect(runOf(run)?.outcome).toBe('failed');
      // The text is never thrown away. It is still the record of what the
      // fire produced, and `muxpad search` can still find the run's chat.
      expect(runOf(run)?.result).toBe('SPX +0.4%');
    });
  });

  describe('restarting between capture and delivery', () => {
    it('picks up a result captured by a previous process', () => {
      // The whole reason the outbox is a column. In-memory pending state
      // loses a result to every server bounce, and this install bounces.
      const c = cron({ resultTab: 'DEST' });
      const run = firedWithResult(c.id, 'SPX +0.4%');
      // A fresh instance, as a restart would build.
      expect(make().sweep().delivered).toBe(1);
      expect(runOf(run)?.delivered_at).toBe(clock);
    });

    it('forgets its retry count, giving a result three more tries', () => {
      // Deliberate: a restart may well have fixed the destination, and the
      // alternative is a column that makes every transient rejection durable.
      status = 'rejected';
      const c = cron({ resultTab: 'DEST' });
      const run = firedWithResult(c.id, 'SPX +0.4%');
      const first = make();
      for (let i = 0; i < DELIVERY_ATTEMPTS - 1; i++) first.sweep();
      // …restart…
      status = 'sent';
      expect(make().sweep().delivered).toBe(1);
      expect(runOf(run)?.outcome).toBe('sent');
    });
  });
});
