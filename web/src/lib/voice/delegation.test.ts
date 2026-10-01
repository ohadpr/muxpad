import { describe, expect, it } from 'vitest';
import { DelegationRegistry } from './delegation';

const at = (now: number, offsetMs = now) => ({ now, offsetMs });

describe('claiming — delivery is not exactly-once', () => {
  it('the first claim wins and every later one gets nothing', () => {
    const r = new DelegationRegistry();
    const first = r.claim('d1', at(100));
    expect(first).not.toBeNull();
    expect(r.claim('d1', at(101))).toBeNull();
    expect(r.claim('d1', at(5000))).toBeNull();
  });

  it('still refuses a duplicate that arrives AFTER the work finished', () => {
    const r = new DelegationRegistry();
    const ctx = r.claim('d1', at(0));
    r.finish(ctx!.id);
    // The redelivery a minute later must not start the same agent turn again.
    expect(r.claim('d1', at(60_000))).toBeNull();
    expect(r.hasSeen('d1')).toBe(true);
  });

  it('refuses an empty id rather than claiming a nameless delegation', () => {
    const r = new DelegationRegistry();
    expect(r.claim('', at(0))).toBeNull();
  });

  it('different ids are independent', () => {
    const r = new DelegationRegistry();
    expect(r.claim('a', at(0))).not.toBeNull();
    expect(r.claim('b', at(1))).not.toBeNull();
  });

  it('bounds what it remembers', () => {
    const r = new DelegationRegistry();
    for (let i = 0; i < 600; i++) r.claim(`d${i}`, at(i));
    // Recent ids are definitely still refused.
    expect(r.claim('d599', at(1))).toBeNull();
    expect(r.hasSeen('d599')).toBe(true);
    // The very oldest has aged out — documented and bounded, not a leak.
    expect(r.hasSeen('d0')).toBe(false);
  });
});

describe('revisions — the user moved on', () => {
  it('a context claimed at the current revision is fresh', () => {
    const r = new DelegationRegistry();
    const ctx = r.claim('d1', at(0))!;
    expect(r.isStale(ctx)).toBe(false);
  });

  it('bumping the revision makes everything claimed before it stale', () => {
    const r = new DelegationRegistry();
    const ctx = r.claim('d1', at(0))!;
    r.bumpRevision();
    expect(r.isStale(ctx)).toBe(true);
  });

  it('a NEWER delegation is fresh while the one it superseded is stale — the whole point', () => {
    const r = new DelegationRegistry();
    const first = r.claim('d1', at(0))!;
    r.bumpRevision();
    const second = r.claim('d2', at(10))!;
    expect(r.isStale(first)).toBe(true);
    expect(r.isStale(second)).toBe(false);
  });

  it('a FINISHED delegation is stale even at the same revision — no late narration', () => {
    const r = new DelegationRegistry();
    const ctx = r.claim('d1', at(0))!;
    r.finish('d1');
    expect(r.currentRevision()).toBe(ctx.revision);
    expect(r.isStale(ctx)).toBe(true);
  });

  it('reset abandons open work and bumps, so a surviving timer finds itself stale', () => {
    const r = new DelegationRegistry();
    const ctx = r.claim('d1', at(0))!;
    r.reset();
    expect(r.isStale(ctx)).toBe(true);
    expect(r.active()).toBeUndefined();
  });
});

describe('active()', () => {
  it('is the newest still-open delegation', () => {
    const r = new DelegationRegistry();
    r.claim('d1', at(0));
    r.claim('d2', at(50));
    expect(r.active()?.id).toBe('d2');
  });

  it('falls back to what is left when the newest finishes', () => {
    const r = new DelegationRegistry();
    r.claim('d1', at(0));
    r.claim('d2', at(50));
    r.finish('d2');
    expect(r.active()?.id).toBe('d1');
  });

  it('is undefined when nothing is open', () => {
    const r = new DelegationRegistry();
    expect(r.active()).toBeUndefined();
    r.claim('d1', at(0));
    r.finish('d1');
    expect(r.active()).toBeUndefined();
  });
});
