import { describe, expect, it } from 'vitest';
import { STALE_FIRE_MS, fireDiedUnstarted } from './stale-fire.js';

const base = {
  outcome: 'queued',
  firedAt: 0,
  now: STALE_FIRE_MS + 1,
  paneId: 'p1',
  paneExists: true,
  paneDead: false,
};

/**
 * THE FAILURE THIS EXISTS FOR, measured: `trayo-dev-server-daily` fired at
 * 07:01 on eight consecutive mornings, recorded zero failures, and did no
 * work — its pane was created on another machine and exited at once. Every
 * surface reported it healthy, because nothing ever corrected a row that no
 * turn had touched.
 */
describe('a fire whose worker never started', () => {
  it('is a failure when its chat is gone', () => {
    const v = fireDiedUnstarted({ ...base, paneExists: false });
    expect(v.dead).toBe(true);
    expect(v.why).toContain('gone');
  });

  it('is a failure when the runner gave up', () => {
    expect(fireDiedUnstarted({ ...base, paneDead: true }).dead).toBe(true);
  });

  it('LEAVES A LONG TURN ALONE, however long it takes', () => {
    // "Still queued after N minutes" is not failure: a real turn can run for
    // half an hour and its row stays queued for all of it. Marking that failed
    // would retire schedules that work.
    expect(fireDiedUnstarted({ ...base, now: STALE_FIRE_MS * 10 }).dead).toBe(false);
  });

  it('waits before judging anything', () => {
    // A cold pane spawns a shell, a runner and a model session. Being early
    // costs a working schedule; being late costs an hour.
    expect(fireDiedUnstarted({ ...base, paneExists: false, now: 1_000 }).dead).toBe(false);
  });

  it('never re-judges a run that already said what happened', () => {
    for (const outcome of ['done', 'failed', 'kept', 'closed', 'skipped', 'missed'])
      expect(fireDiedUnstarted({ ...base, outcome, paneExists: false }).dead, outcome).toBe(false);
  });

  it('says nothing about a fire that created no chat', () => {
    expect(fireDiedUnstarted({ ...base, paneId: null, paneExists: false }).dead).toBe(false);
  });
});
