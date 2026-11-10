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

/**
 * A DELIVERY HANDS BACK THE MEANS TO ACT ON IT.
 *
 * The owner's report: "the moment the chat yields, it's back at me — and 99%
 * of the time I need to send it back to do something, and an agent can surely
 * do a better job at that than me."
 *
 * Two things made that the path of least resistance. The note ended "act on
 * them, or carry on if nothing is needed", which reads as permission to do
 * nothing; and the message carried TAB ids while sending a worker back needs a
 * PANE id — so the one action an orchestrator most needs after reading a
 * report required a lookup it had no reason to know how to do.
 */
describe('a delivery is work to review, not news to relay', () => {
  const entry = (over: Partial<SpawnDeliveryEntry> = {}): SpawnDeliveryEntry => ({
    tabId: 't1',
    paneId: 'p1',
    name: 'build the importer',
    state: 'ok',
    report: 'Added the CSV importer and a test.',
    ...over,
  });

  /** The text under one heading, up to the next — what a reader attributes
   *  to that worker. Both assertions below are about ATTRIBUTION, which a
   *  `toContain` over the whole message cannot see. */
  const sectionFor = (out: string, name: string): string => {
    const start = out.indexOf(`## ${name}`);
    const rest = out.slice(start + 1);
    const next = rest.indexOf('\n## ');
    return next === -1 ? rest : rest.slice(0, next);
  };

  it('puts the send-back command inside the section it belongs to', () => {
    // An earlier version asserted only that the command appeared AFTER the
    // heading, which a footer at the end of the whole message also satisfies.
    const out = renderSpawnDelivery([
      entry(),
      entry({ tabId: 't2', paneId: 'p2', name: 'write the docs' }),
    ]);
    expect(sectionFor(out, 'build the importer')).toContain('muxpad agent send p1');
  });

  it('gives each worker its OWN handle, not merely a handle each', () => {
    // The version of this test that shipped checked both strings were
    // present somewhere, so swapping the two handles between workers passed
    // it — and a parent following the wrong one sends corrections for the
    // importer to the worker writing the docs.
    const out = renderSpawnDelivery([
      entry(),
      entry({ tabId: 't2', paneId: 'p2', name: 'write the docs' }),
    ]);
    expect(sectionFor(out, 'build the importer')).toContain('muxpad agent send p1');
    expect(sectionFor(out, 'build the importer')).not.toContain('p2');
    expect(sectionFor(out, 'write the docs')).toContain('muxpad agent send p2');
    expect(sectionFor(out, 'write the docs')).not.toContain('p1');
  });

  it('names the alternative for a worker that cannot be resumed', () => {
    const { paneId: _none, ...crashed } = entry({ state: 'crashed', report: null });
    const out = renderSpawnDelivery([crashed]);
    expect(out).not.toContain('muxpad agent send');
    // "No handle" alone reads as "nothing to do here", which is false — the
    // work still needs doing, by somebody new.
    expect(out).toMatch(/cannot be resumed/);
    expect(out).toContain('muxpad agent new');
  });

  it('tells the parent to review before it says anything to the human', () => {
    const out = renderSpawnDelivery([entry()]);
    expect(out).toMatch(/REVIEW each result against what you asked for/);
    expect(out).toMatch(/send that worker back/);
    // The sentence that made doing nothing a legitimate reading is gone.
    expect(out).not.toMatch(/carry on if nothing is needed/);
  });

  it('says the worker keeps its context, so sending back is resuming', () => {
    // An orchestrator that thinks a send-back costs a fresh briefing will
    // weigh it against bothering the human and pick wrong.
    expect(renderSpawnDelivery([entry()])).toMatch(/keeps its context/);
  });

  it('omits the handle rather than inventing one for a worker that has no pane', () => {
    const { paneId: _dropped, ...noPane } = entry();
    const out = renderSpawnDelivery([noPane]);
    expect(out).toContain('build the importer');
    expect(out).not.toContain('muxpad agent send');
  });
});

/**
 * NOTHING A WORKER SAID IS LOST.
 *
 * A single child's report was capped at 1,200 characters, so a 6,000-character
 * code review arrived as its first fifth, cut mid-word — and the parent
 * reviewed a fragment while believing it had the report. Truncation is exactly
 * the wrong economy for the one message whose job is to be acted on.
 *
 * But 65 unabridged reports is a context window, not a message. So the inline
 * text stays bounded and the whole thing goes to a file whose path travels
 * with it.
 */
describe('a report too long to inline is still readable in full', () => {
  const long = 'x'.repeat(5_000);

  it('names the file when the text was cut', () => {
    const out = renderSpawnDelivery([
      {
        tabId: 't1',
        name: 'review',
        state: 'ok',
        report: long,
        reportPath: '/Users/me/.muxpad/spawn-reports/r-1.md',
      },
    ]);
    expect(out).toContain('[report truncated]');
    expect(out).toContain('Full report: `/Users/me/.muxpad/spawn-reports/r-1.md`');
  });

  it('does NOT name a file for a report that arrived whole', () => {
    // A path beside something you have already read in full is noise, and it
    // teaches a parent to open the file every time.
    const out = renderSpawnDelivery([
      {
        tabId: 't1',
        name: 'review',
        state: 'ok',
        report: 'short and complete',
        reportPath: '/Users/me/.muxpad/spawn-reports/r-1.md',
      },
    ]);
    expect(out).toContain('short and complete');
    expect(out).not.toContain('Full report');
    expect(out).not.toContain('[report truncated]');
  });

  it('still says it was cut when there is no file to point at', () => {
    // A server with nowhere to write degrades to the old behaviour rather
    // than losing the delivery.
    const out = renderSpawnDelivery([{ tabId: 't1', name: 'review', state: 'ok', report: long }]);
    expect(out).toContain('[report truncated]');
    expect(out).not.toContain('Full report');
  });
});
