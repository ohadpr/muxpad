// Policy tests for the cron tick. Everything here runs against a real
// in-memory SQLite (the schema IS the design) with a FAKE injection primitive,
// a fake ptyd and a driven clock — no sleeping, no daemon, no ~/.muxpad.
//
// The bar these exist to hold: submitSend's answer must be recorded verbatim
// and never thrown away (docs/plans/2026-08-14-muxpad-cron.md §6 risk 1), and
// every "don't fire" decision must leave a record saying why.
import type Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '../events.js';
import { PtydCache } from '../ptyd-cache.js';
import type { PtydClient } from '../ptyd-client/PtydClient.js';
import { PaneStore } from '../store/PaneStore.js';
import { TabStore } from '../store/TabStore.js';
import { WorkspaceStore } from '../store/WorkspaceStore.js';
import { openDb } from '../store/db.js';
import {
  CRON_FAIL_LIMIT,
  CRON_MISSED_GRACE_MS,
  CRON_STARTUP_GRACE_MS,
  CronScheduler,
  type CronSchedulerDeps,
} from './CronScheduler.js';
import { CRON_RUNS_KEEP } from './CronStore.js';

const HOURLY = '0 * * * *';
const T0 = Date.parse('2026-08-30T10:00:00Z');

/** A ptyd that does nothing, successfully. The scheduler only ever asks it to
 *  spawn or kill a pane, and both are best-effort by contract. */
const fakePtyd = () =>
  ({
    ensurePane: async () => undefined,
    killPane: async () => undefined,
  }) as unknown as PtydClient;

describe('CronScheduler', () => {
  let db: Database.Database;
  let cache: PtydCache;
  let events: EventBus;
  let wsId: string;
  let paneId: string;
  let now: number;
  let sent: Array<{ paneId: string; text: string }>;
  let submitResult: { status: 'sent' | 'queued' | 'rejected'; reason?: string };

  const makeAgentPane = () => {
    const tabs = new TabStore(db);
    const panes = new PaneStore(db);
    const tab = tabs.create({ name: 'agent', layout: '', workspace_id: wsId });
    const pane = panes.create({
      tab_id: tab.id,
      shell: '/bin/zsh',
      cwd: '/tmp',
      startup_cmd: 'muxpad agent',
      face: 'chat',
    });
    tabs.update(tab.id, { layout: pane.id });
    return { tabId: tab.id, paneId: pane.id };
  };

  const scheduler = (over: Partial<CronSchedulerDeps> = {}) =>
    new CronScheduler({
      db,
      ptyd: fakePtyd(),
      cache,
      events,
      submitSend: (p, text) => {
        sent.push({ paneId: p, text });
        return submitResult;
      },
      now: () => now,
      ...over,
    });

  /** Create a cron directly in the store, with the anchor we want to test. */
  const makeCron = (
    s: CronScheduler,
    over: Partial<Parameters<CronScheduler['store']['create']>[0]> = {},
  ) =>
    s.store.create({
      name: 'job',
      schedule: HOURLY,
      tz: 'UTC',
      prompt: 'check the PRs',
      target_kind: 'pane',
      target_pane: paneId,
      next_due_at: T0,
      ...over,
    });

  /**
   * Move the clock to just after this cron is genuinely due — past BOTH the
   * boot grace and the cron's own deterministic jitter. Tests must not assume
   * a nominal slot is the fire time; the jitter is real and up to 30 minutes,
   * and pretending otherwise is exactly the drift these tests exist to catch.
   */
  const runAt = (cron: { next_due_at: number }, extra = 0) => {
    now = Math.max(cron.next_due_at, T0 + CRON_STARTUP_GRACE_MS) + 1000 + extra;
  };

  beforeEach(() => {
    db = openDb(':memory:');
    cache = new PtydCache();
    events = new EventBus();
    wsId = new WorkspaceStore(db).create({ name: 'W' }).id;
    paneId = makeAgentPane().paneId;
    now = T0;
    sent = [];
    submitResult = { status: 'sent' };
  });

  // ── The startup grace ─────────────────────────────────────────────────

  it('does not fire inside the startup grace (a restart must not blast every due cron)', async () => {
    const s = scheduler();
    const cron = makeCron(s);
    now = Math.max(cron.next_due_at, T0) + 1; // due, but still inside the grace
    now = Math.min(now, T0 + CRON_STARTUP_GRACE_MS - 1);
    await s.tick();
    expect(sent).toHaveLength(0);
    // …and the anchor is untouched, so nothing was lost — just deferred.
    expect(s.store.list()[0]?.next_due_at).toBe(T0 + s.store.list()[0]!.jitter_ms);
  });

  // ── Firing + the return value ─────────────────────────────────────────

  it('fires a due pane cron through submitSend and records the answer VERBATIM', async () => {
    const s = scheduler();
    const cron = makeCron(s);
    runAt(cron);
    await s.tick();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.paneId).toBe(paneId);
    // The prompt arrives wrapped in the fire marker so both the human and the
    // agent can see it was scheduled, not typed.
    expect(sent[0]?.text).toContain(`<muxpad-cron id="${cron.id}" name="job"`);
    expect(sent[0]?.text).toContain('check the PRs');

    const runs = s.store.runs(cron.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.outcome).toBe('sent');
    expect(runs[0]?.target_pane).toBe(paneId);
    expect(s.store.getById(cron.id)?.last_status).toBe('sent');
    expect(s.store.getById(cron.id)?.fail_streak).toBe(0);
  });

  it("records 'queued' as queued — not flattened into success prose", async () => {
    // A run log that can't tell "it ran" from "it's waiting behind a turn" is
    // most of the way back to the silent failure this replaces.
    submitResult = { status: 'queued' };
    const s = scheduler();
    const cron = makeCron(s);
    runAt(cron);
    await s.tick();
    expect(s.store.runs(cron.id)[0]?.outcome).toBe('queued');
    expect(s.store.getById(cron.id)?.fail_streak).toBe(0);
  });

  it('re-anchors to the next slot after firing (no re-fire on the next tick)', async () => {
    const s = scheduler();
    const cron = makeCron(s);
    runAt(cron);
    await s.tick();
    const after = s.store.getById(cron.id) as { next_due_at: number; jitter_ms: number };
    expect(after.next_due_at).toBeGreaterThan(now);
    await s.tick();
    expect(sent).toHaveLength(1);
  });

  it('applies the deterministic jitter to the persisted next_due_at', async () => {
    const s = scheduler();
    const cron = makeCron(s);
    // The stored time is nominal + jitter, and the nominal is recoverable
    // exactly — that identity is what the catch-up math depends on.
    expect(cron.next_due_at - cron.jitter_ms).toBe(T0);
    runAt(cron);
    await s.tick();
    const after = s.store.getById(cron.id) as { next_due_at: number; jitter_ms: number };
    expect((after.next_due_at - after.jitter_ms) % 3_600_000).toBe(0);
  });

  // ── Failure handling (§6 risk 1) ──────────────────────────────────────

  it('a rejection increments the streak and auto-disables at the limit, with a push', async () => {
    submitResult = { status: 'rejected', reason: 'pane has no agent runner' };
    const notify = vi.fn();
    const s = scheduler({ notify });
    const cron = makeCron(s);
    runAt(cron);
    for (let i = 0; i < CRON_FAIL_LIMIT; i++) {
      await s.tick();
      now += 3_600_000;
    }
    const row = s.store.getById(cron.id);
    expect(row?.fail_streak).toBe(CRON_FAIL_LIMIT);
    expect(row?.enabled).toBe(false);
    expect(row?.last_status).toContain('pane has no agent runner');
    expect(notify).toHaveBeenCalledTimes(1);
    expect(s.store.runs(cron.id).every((r) => r.outcome === 'rejected')).toBe(true);
  });

  it('a success resets the streak', async () => {
    submitResult = { status: 'rejected', reason: 'nope' };
    const s = scheduler();
    const cron = makeCron(s);
    runAt(cron);
    await s.tick();
    expect(s.store.getById(cron.id)?.fail_streak).toBe(1);
    submitResult = { status: 'sent' };
    now += 3_600_000;
    await s.tick();
    expect(s.store.getById(cron.id)?.fail_streak).toBe(0);
  });

  it('fails FAST on a dead pane rather than spinning', async () => {
    // `dead` means the runner's automatic restarts were exhausted. submitSend
    // would reject anyway; reading the five-state status first makes the run
    // history say why in one word.
    cache.setDead(paneId, true);
    const s = scheduler();
    const cron = makeCron(s);
    runAt(cron);
    await s.tick();
    expect(sent).toHaveLength(0);
    const run = s.store.runs(cron.id)[0];
    expect(run?.outcome).toBe('error');
    expect(run?.detail).toBe('dead');
    expect(s.store.getById(cron.id)?.fail_streak).toBe(1);
  });

  it('disables (once, with a push) when the target pane no longer exists', async () => {
    const notify = vi.fn();
    const s = scheduler({ notify });
    const cron = makeCron(s);
    new PaneStore(db).delete(paneId);
    runAt(cron);
    await s.tick();
    expect(s.store.getById(cron.id)?.enabled).toBe(false);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  // ── Catch-up ──────────────────────────────────────────────────────────

  it("catchup=once collapses a downtime's missed fires into ONE, marked", async () => {
    const s = scheduler();
    const cron = makeCron(s, { catchup: 'once' });
    now = cron.next_due_at + 5 * 3_600_000; // ~5 hours of downtime
    await s.tick();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toMatch(/missed="\d+"/);
    expect(sent[0]?.text).toContain('missed while muxpad was offline');
    expect(s.store.getById(cron.id)?.next_due_at).toBeGreaterThan(now);
  });

  it('a punctual fire carries NO missed marker (the grace keeps the count honest)', async () => {
    // A per-minute schedule so the current slot is genuinely fresh: the grace
    // exists so a slow pass can't make an on-time fire look like a recovered
    // outage, and a spurious "[3 missed]" would be a lie to the agent.
    const s = scheduler();
    const cron = makeCron(s, { schedule: '* * * * *' });
    runAt(cron);
    await s.tick();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).not.toContain('missed=');
  });

  it('catchup=skip drops the missed fires and records the outage instead', async () => {
    const s = scheduler();
    const cron = makeCron(s, { catchup: 'skip' });
    // Far enough past the LAST slot that every due fire is stale (older than
    // the missed grace), which is what 'skip' is about — not the live slot.
    now = cron.next_due_at + 5 * 3_600_000 + 30 * 60_000;
    await s.tick();
    expect(sent).toHaveLength(0);
    const run = s.store.runs(cron.id)[0];
    expect(run?.outcome).toBe('missed');
    expect(run?.detail).toContain('catchup=skip');
    expect(s.store.getById(cron.id)?.next_due_at).toBeGreaterThan(now);
  });

  it('catchup=all enqueues every missed fire', async () => {
    const s = scheduler();
    const cron = makeCron(s, { catchup: 'all' });
    now = cron.next_due_at + 3 * 3_600_000;
    await s.tick();
    // 10:00, 11:00, 12:00, 13:00 — every slot at or before now.
    expect(sent.length).toBe(4);
    expect(s.store.runs(cron.id).length).toBe(sent.length);
  });

  // ── Quiet hours ───────────────────────────────────────────────────────

  it('quiet_mins DEFERS rather than dropping — and keeps the anchor', async () => {
    // A cron must not be lost because you happened to be chatting when it
    // came due; it retries on the next tick.
    const s = scheduler({ lastHumanSendAt: () => now - 60_000 });
    const cron = makeCron(s, { quiet_mins: 10 });
    const anchor = s.store.getById(cron.id)?.next_due_at;
    runAt(cron);
    await s.tick();
    expect(sent).toHaveLength(0);
    expect(s.store.getById(cron.id)?.next_due_at).toBe(anchor);
    expect(s.store.getById(cron.id)?.last_status).toBe('deferred:quiet');
    // A deferral is NOT a run — one row per 30s tick while the user chats
    // would be the fastest way to fill the run log with noise.
    expect(s.store.runs(cron.id)).toHaveLength(0);
  });

  it('fires once the quiet window has passed', async () => {
    let lastSend = 0;
    const s = scheduler({ lastHumanSendAt: () => lastSend });
    runAt(makeCron(s, { quiet_mins: 10 }));
    lastSend = now - 60_000; // the user typed a minute ago
    await s.tick();
    expect(sent).toHaveLength(0);
    lastSend = now - 11 * 60_000; // …and now they haven't for eleven
    await s.tick();
    expect(sent).toHaveLength(1);
  });

  // ── Overlap ───────────────────────────────────────────────────────────

  it('overlap=skip does not stack a second fire while OUR turn is still running', async () => {
    const s = scheduler({ turnActive: () => true });
    const cron = makeCron(s, { overlap: 'skip' });
    runAt(cron);
    await s.tick(); // fires, marks in-flight
    now += 3_600_000;
    await s.tick(); // our turn is still running → skip
    expect(sent).toHaveLength(1);
    const last = s.store.runs(cron.id)[0];
    expect(last?.outcome).toBe('skipped');
    expect(last?.detail).toBe('overlap');
  });

  it('overlap=skip sees a fire still sitting in the DURABLE queue (survives a restart)', async () => {
    submitResult = { status: 'queued' };
    const s = scheduler();
    const cron = makeCron(s, { overlap: 'skip' });
    runAt(cron);
    await s.tick();
    // Simulate what submitSend would have persisted, then a fresh scheduler
    // (i.e. a server restart, with the in-memory in-flight map empty).
    db.prepare(
      'INSERT INTO agent_queue (id, pane_id, seq, text, created_at) VALUES (?, ?, 1, ?, ?)',
    ).run('q1', paneId, sent[0]?.text, now);
    const s2 = scheduler();
    now += 3_600_000;
    await s2.tick();
    expect(sent).toHaveLength(1);
    expect(s2.store.runs(cron.id)[0]?.detail).toBe('overlap');
  });

  it('overlap=queue stacks (that is the point of the setting)', async () => {
    const s = scheduler({ turnActive: () => true });
    runAt(makeCron(s, { overlap: 'queue' }));
    await s.tick();
    now += 3_600_000;
    await s.tick();
    expect(sent).toHaveLength(2);
  });

  // ── Context policies ──────────────────────────────────────────────────

  it('on_context=skip refuses to fire into a nearly-full window, and says so', async () => {
    const s = scheduler({ contextPct: () => 92 });
    const cron = makeCron(s, { on_context: 'skip' });
    runAt(cron);
    await s.tick();
    expect(sent).toHaveLength(0);
    expect(s.store.runs(cron.id)[0]?.detail).toContain('context 92%');
  });

  it('on_context=compact-first sends a compact ahead of the prompt', async () => {
    const slash = vi.fn(() => true);
    const s = scheduler({ contextPct: () => 92, slash });
    runAt(makeCron(s, { on_context: 'compact-first' }));
    await s.tick();
    expect(slash).toHaveBeenCalledWith(paneId, 'compact');
    expect(sent).toHaveLength(1); // and the prompt still went
  });

  it('on_context=fire ignores a full window', async () => {
    const slash = vi.fn(() => true);
    const s = scheduler({ contextPct: () => 99, slash });
    runAt(makeCron(s, { on_context: 'fire' }));
    await s.tick();
    expect(slash).not.toHaveBeenCalled();
    expect(sent).toHaveLength(1);
  });

  it('an UNKNOWN context fill is treated as "just fire" (codex/cursor have no window)', async () => {
    const s = scheduler({ contextPct: () => null });
    runAt(makeCron(s, { on_context: 'skip' }));
    await s.tick();
    expect(sent).toHaveLength(1);
  });

  // ── Rotation must carry context ───────────────────────────────────────

  it('on_context=rotate carries a handoff briefing into the fresh tab', async () => {
    // A rotation that spawned a clean-context agent knowing nothing about the
    // conversation it just left would produce confidently amnesiac output —
    // indistinguishable from a good answer. The briefing is not optional.
    const s = scheduler({
      contextPct: () => 95,
      carryover: async () => 'The user is tracking three open PRs; #12 is blocked on review.',
    });
    const cron = makeCron(s, { on_context: 'rotate', workspace_id: wsId });
    runAt(cron);
    await s.tick();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.paneId).not.toBe(paneId); // a NEW pane, in a new tab
    expect(sent[0]?.text).toContain('<muxpad-carryover>');
    expect(sent[0]?.text).toContain('#12 is blocked on review');
    // …and the cron prompt still follows the briefing.
    expect(sent[0]?.text).toContain('check the PRs');
    expect(s.store.runs(cron.id)[0]?.detail).toContain('rotated at 95% context with carryover');
  });

  it('refuses to rotate when no briefing can be produced', async () => {
    // Losing a fire is recoverable — the next slot comes around and the run log
    // says why. Silently amnesiac output is not.
    const s = scheduler({ contextPct: () => 95, carryover: async () => null });
    const cron = makeCron(s, { on_context: 'rotate', workspace_id: wsId });
    runAt(cron);
    await s.tick();
    expect(sent).toHaveLength(0);
    expect(s.store.runs(cron.id)[0]?.outcome).toBe('skipped');
    expect(s.store.runs(cron.id)[0]?.detail).toContain('carryover-failed');
  });

  it('treats a THROWING carryover source as "no briefing", not as a crash', async () => {
    const s = scheduler({
      contextPct: () => 95,
      carryover: async () => {
        throw new Error('summarizer exploded');
      },
    });
    const cron = makeCron(s, { on_context: 'rotate', workspace_id: wsId });
    runAt(cron);
    await s.tick();
    expect(s.store.runs(cron.id)[0]?.detail).toContain('carryover-failed');
  });

  // ── new-tab mode ──────────────────────────────────────────────────────

  it('new-tab mode creates an agent tab in Do mode and sends into it', async () => {
    const s = scheduler();
    const cron = makeCron(s, {
      target_kind: 'new-tab',
      target_pane: null,
      workspace_id: wsId,
      mode: 'do',
      cwd: '/tmp',
    });
    runAt(cron);
    await s.tick();

    const run = s.store.runs(cron.id)[0];
    expect(run?.target_tab).toBeTruthy();
    const tab = new TabStore(db).getById(run?.target_tab as string);
    expect(tab?.name).toBe('job');
    const pane = new PaneStore(db).listByTab(tab?.id as string)[0];
    // A scheduled job's report wants terse + result-first — the ⚡ Do contract.
    expect(pane?.startup_cmd).toBe('muxpad agent --mode do');
    expect(sent[0]?.paneId).toBe(pane?.id);
  });

  it('max_open stops a nightly cron leaving a month of tabs behind', async () => {
    const s = scheduler();
    const cron = makeCron(s, {
      target_kind: 'new-tab',
      target_pane: null,
      workspace_id: wsId,
      max_open: 1,
    });
    runAt(cron);
    await s.tick();
    now += 3_600_000;
    await s.tick();
    expect(sent).toHaveLength(1);
    expect(s.store.runs(cron.id)[0]?.detail).toContain('max_open 1 reached');
  });

  it('close_when_done closes the tab on a clean turn-done', async () => {
    const s = scheduler();
    s.start();
    const cron = makeCron(s, {
      target_kind: 'new-tab',
      target_pane: null,
      workspace_id: wsId,
      close_when_done: true,
    });
    runAt(cron);
    await s.tick();
    const tabId = s.store.runs(cron.id)[0]?.target_tab as string;
    const firedPane = sent[0]?.paneId as string;
    expect(new TabStore(db).getById(tabId)).not.toBeNull();

    events.emit({ type: 'agent_turn', pane_id: firedPane, phase: 'done', sid: null, backend: 'x' });
    await new Promise((r) => setImmediate(r));
    // Nothing is lost: every session is archived + FTS-searchable.
    expect(new TabStore(db).getById(tabId)).toBeNull();
    expect(s.store.openTabs(cron.id)).toEqual([]);
    s.stop();
  });

  it('close_when_done KEEPS the tab when the agent left a question pending', async () => {
    const s = scheduler({ blocked: () => true });
    s.start();
    const cron = makeCron(s, {
      target_kind: 'new-tab',
      target_pane: null,
      workspace_id: wsId,
      close_when_done: true,
    });
    runAt(cron);
    await s.tick();
    const tabId = s.store.runs(cron.id)[0]?.target_tab as string;
    events.emit({
      type: 'agent_turn',
      pane_id: sent[0]?.paneId as string,
      phase: 'done',
      sid: null,
      backend: 'x',
    });
    await new Promise((r) => setImmediate(r));
    expect(new TabStore(db).getById(tabId)).not.toBeNull();
    expect(s.store.runs(cron.id).some((r) => r.outcome === 'kept')).toBe(true);
    s.stop();
  });

  it('close_when_done KEEPS the tab when the turn ended fatally', async () => {
    const s = scheduler();
    s.start();
    const cron = makeCron(s, {
      target_kind: 'new-tab',
      target_pane: null,
      workspace_id: wsId,
      close_when_done: true,
    });
    runAt(cron);
    await s.tick();
    const tabId = s.store.runs(cron.id)[0]?.target_tab as string;
    events.emit({
      type: 'agent_turn',
      pane_id: sent[0]?.paneId as string,
      phase: 'fatal',
      sid: null,
      backend: 'x',
    });
    await new Promise((r) => setImmediate(r));
    expect(new TabStore(db).getById(tabId)).not.toBeNull();
    s.stop();
  });

  // ── Manual run ────────────────────────────────────────────────────────

  it('runNow fires immediately without touching the schedule', async () => {
    const s = scheduler();
    const cron = makeCron(s);
    const anchor = s.store.getById(cron.id)?.next_due_at;
    now = T0 - 3_600_000; // not due at all
    await s.runNow(cron.id);
    expect(sent).toHaveLength(1);
    expect(s.store.getById(cron.id)?.next_due_at).toBe(anchor);
  });

  it('a failed MANUAL run does not push a working cron toward auto-disable', async () => {
    // The user is standing right there watching it fail; one bad hand-test
    // must not silently retire a nightly job.
    submitResult = { status: 'rejected', reason: 'nope' };
    const s = scheduler();
    const cron = makeCron(s);
    for (let i = 0; i < CRON_FAIL_LIMIT + 2; i++) await s.runNow(cron.id);
    expect(s.store.getById(cron.id)?.enabled).toBe(true);
  });

  // ── Bounds ────────────────────────────────────────────────────────────

  it('trims the run log so a frequent cron cannot grow it without bound', () => {
    const s = scheduler();
    const cron = makeCron(s);
    for (let i = 0; i < CRON_RUNS_KEEP + 20; i++) {
      s.store.addRun({ cron_id: cron.id, due_at: T0 + i, fired_at: T0 + i, outcome: 'sent' });
    }
    expect(s.store.runs(cron.id, 1000)).toHaveLength(CRON_RUNS_KEEP);
    // …and the newest survive, not the oldest.
    expect(s.store.runs(cron.id)[0]?.fired_at).toBe(T0 + CRON_RUNS_KEEP + 19);
  });

  it('a single slow pass cannot be re-entered (no duplicate fires)', async () => {
    let release: (() => void) | null = null;
    const s = scheduler({
      submitSend: (p, text) => {
        sent.push({ paneId: p, text });
        return { status: 'sent' as const };
      },
      carryover: () =>
        new Promise<string | null>((res) => {
          release = () => res('brief');
        }),
      contextPct: () => 95,
    });
    runAt(makeCron(s, { on_context: 'rotate', workspace_id: wsId }));
    const first = s.tick();
    await s.tick(); // must be a no-op while the first pass is mid-await
    (release as unknown as () => void)?.();
    await first;
    expect(sent).toHaveLength(1);
  });

  it('re-reads each row mid-pass, so a row disabled by an earlier fire is not fired again', async () => {
    const s = scheduler();
    const a = makeCron(s, { name: 'a' });
    const b = makeCron(s, { name: 'b' });
    runAt(a);
    now = Math.max(now, b.next_due_at + 1000);
    // Disable b out from under the pass by deleting it after listDue snapshots.
    s.store.delete(b.id);
    await s.tick();
    expect(sent).toHaveLength(1);
    expect(s.store.runs(a.id)).toHaveLength(1);
  });
});
