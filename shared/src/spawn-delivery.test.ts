import { describe, expect, it } from 'vitest';
import { renderCronMarker } from './cron.js';
import {
  DELIVERY_BODY_BUDGET,
  DELIVERY_MAX_PER_CHILD,
  DELIVERY_MIN_PER_CHILD,
  type SpawnDeliveryEntry,
  isMachineMessage,
  parseSpawnDelivery,
  perChildBudget,
  renderSpawnDelivery,
} from './spawn-delivery.js';

const entry = (over: Partial<SpawnDeliveryEntry> = {}): SpawnDeliveryEntry => ({
  tabId: 't1',
  name: 'research auth',
  state: 'ok',
  report: 'Found three call sites.',
  ...over,
});

describe('the spawn delivery marker', () => {
  it('round-trips through render → parse', () => {
    const text = renderSpawnDelivery([entry(), entry({ tabId: 't2', name: 'build ui' })]);
    const parsed = parseSpawnDelivery(text);
    expect(parsed?.marker).toEqual({ count: 2, from: ['t1', 't2'] });
    expect(parsed?.body).toContain('research auth');
    expect(parsed?.body).toContain('build ui');
  });

  it('tells the agent it is a result, not a question', () => {
    // An orchestrator that reads a delivery as a user asking something will
    // reply to it instead of acting on it.
    const text = renderSpawnDelivery([entry()]);
    expect(text).toMatch(/not a human asking a question/);
    expect(text.startsWith('<muxpad-delivery')).toBe(true);
  });

  it('names a crashed worker as crashed', () => {
    const text = renderSpawnDelivery([entry({ state: 'crashed', report: null })]);
    expect(text).toContain('CRASHED');
    expect(text).toContain('(no report)');
  });

  it('adds no state note to the heading in the ordinary case', () => {
    // `ok` is the uninteresting case; a suffix on it is noise on every row of
    // a 23-way fan-out. (Asserted on the HEADING — the marker's own note
    // legitimately contains prose.)
    const text = renderSpawnDelivery([entry({ state: 'ok' })]);
    expect(text).toContain('## research auth\n');
    const text2 = renderSpawnDelivery([entry({ state: null })]);
    expect(text2).toContain('## research auth\n');
  });

  it('carries artifacts', () => {
    const text = renderSpawnDelivery([entry({ artifacts: ['https://pub/x', 'https://pub/y'] })]);
    expect(text).toContain('Artifacts: https://pub/x https://pub/y');
  });

  it('returns null for ordinary text, and for a merely-mentioned tag', () => {
    expect(parseSpawnDelivery('just a message')).toBeNull();
    expect(parseSpawnDelivery('look at <muxpad-delivery count="1">x</muxpad-delivery>')).toBeNull();
  });

  it('returns null for a marker with no count', () => {
    expect(parseSpawnDelivery('<muxpad-delivery from="t1">x</muxpad-delivery>\n\nbody')).toBeNull();
  });

  describe('the body budget — a 65-way fan-out is not a context window', () => {
    it('bounds the whole message however many children land', () => {
      // The real shape in this install: one orchestrator with 65 children.
      const many = Array.from({ length: 65 }, (_, i) =>
        entry({ tabId: `t${i}`, name: `worker ${i}`, report: 'x'.repeat(5_000) }),
      );
      const text = renderSpawnDelivery(many);
      // Headings and the marker are outside the per-child budget, so the check
      // is that the REPORTS are bounded — generously, with room for the frame.
      expect(text.length).toBeLessThan(DELIVERY_BODY_BUDGET * 1.5);
      expect(text).toContain('[report truncated]');
    });

    it('never cuts one child below the floor', () => {
      expect(perChildBudget(1_000)).toBe(DELIVERY_MIN_PER_CHILD);
    });

    it('never gives one child more than the ceiling', () => {
      expect(perChildBudget(1)).toBe(DELIVERY_MAX_PER_CHILD);
    });

    it('leaves a short report untouched and unmarked', () => {
      const text = renderSpawnDelivery([entry({ report: 'Done.' })]);
      expect(text).toContain('Done.');
      expect(text).not.toContain('truncated');
    });

    it('says so when it truncates, rather than looking like a worker stopped', () => {
      const text = renderSpawnDelivery([entry({ report: 'word '.repeat(1_000) })]);
      expect(text).toContain('[report truncated]');
    });
  });
});

describe('isMachineMessage', () => {
  it('knows both of the things muxpad injects', () => {
    // The list is the thing that gets forgotten: this was
    // `parseCronMarker(text) === null` and a report delivery would have read as
    // a human typing — suppressing the push for the turn the user waits on and
    // deferring a due cron behind `quiet_mins`.
    expect(isMachineMessage(renderSpawnDelivery([entry()]))).toBe(true);
    expect(
      isMachineMessage(renderCronMarker({ id: 'c1', name: 'sweep', at: 1, missed: 0 }, 'go')),
    ).toBe(true);
  });

  it('leaves a person alone', () => {
    expect(isMachineMessage('what happened to the build?')).toBe(false);
    expect(isMachineMessage('')).toBe(false);
  });
});

describe('it does not collide with the directed-mention report', () => {
  it('uses a tag of its own', () => {
    // `<muxpad-report>` belongs to chat-mention.ts (one chat answering another),
    // and that parser requires only a leading tag — so sharing the name meant a
    // batch of sub-chat reports rendered as "a report from t1,t2".
    const text = renderSpawnDelivery([entry()]);
    expect(text).toContain('<muxpad-delivery');
    expect(text).not.toContain('<muxpad-report');
  });

  it('still refuses to claim a directed report', () => {
    // The guard that was already here, kept: the other side's marker has an
    // `id` and no `count`, and must stay none of our business.
    const theirs =
      '<muxpad-report id="r1" from="Investing" pane="p1"></muxpad-report>\n\nthe answer';
    expect(parseSpawnDelivery(theirs)).toBeNull();
  });
});
