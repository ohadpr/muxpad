import { type ChatEvent, expandCronFire, renderCronMarker } from '@muxpad/shared';
import { describe, expect, it } from 'vitest';
import { coalesceCronFires, foldCronTurns } from './chat-voice';

/**
 * ONE CHIP PER QUIET STRETCH, NOT ONE PER FIRE.
 *
 * "An hourly refresh is going to cause 24 chips a day — that's crazy versus a
 * daily cron which produces a chip a day, which is reasonable." Both are the
 * same code: a folded fire already costs no bubble and no visible tool row, but
 * the chip is a `notice`, a notice is not an action, so it broke the collapsed
 * run either side of itself. 24 fires was 48 rows.
 *
 * These drive the REAL pipeline — `renderCronMarker` → `expandCronFire` →
 * `foldCronTurns` → `coalesceCronFires` — for the reason cron-fold.test.ts now
 * does: a hand-built fire is a second opinion about a shape, and the last one
 * drifted silently for a whole release.
 */
let n = 0;
const id = () => `e${++n}`;
const fire = (name: string, folded = true, prompt = 'Are the markets open?'): ChatEvent[] => {
  const out = expandCronFire(
    renderCronMarker({ id: `c${++n}`, name, at: null, missed: 0, fold: folded }, prompt),
    id(),
    Date.UTC(2026, 9, 7, 17, 25),
  );
  if (!out) throw new Error('fixture is not a cron fire');
  return out;
};
const prose = (text: string): ChatEvent => ({ kind: 'assistant', id: id(), ts: 0, text });
const reply = (text: string): ChatEvent => ({
  kind: 'assistant',
  id: id(),
  ts: 0,
  text,
  voice: 'reply',
});
const user = (text: string): ChatEvent => ({ kind: 'user', id: id(), ts: 0, text });
const tool = (): ChatEvent => ({
  kind: 'tool_use',
  id: id(),
  ts: 0,
  toolUseId: id(),
  name: 'Bash',
  input: {},
});

/** The whole pipeline, in the order ChatPane runs it. */
const run = (events: ChatEvent[]) => coalesceCronFires(foldCronTurns(events));
type Chip = Extract<ChatEvent, { kind: 'notice' }>;
const chips = (events: readonly ChatEvent[]): Chip[] =>
  events.filter((e): e is Chip => e.kind === 'notice' && e.variant === 'cron');

/** A quiet fire: the agent ran something and said one word nobody reads. */
const quiet = (name = 'nw-hourly') => [...fire(name), tool(), prose('closed')];

describe('coalesceCronFires', () => {
  it('collapses a day of silent hourly fires to ONE chip', () => {
    const events: ChatEvent[] = [];
    for (let i = 0; i < 24; i++) events.push(...quiet());
    const out = run(events);
    expect(chips(out)).toHaveLength(1);
  });

  it('says how many it absorbed, and when the last one landed', () => {
    const out = run([...quiet(), ...quiet(), ...quiet()]);
    const chip = chips(out)[0] as Chip;
    // A chip that silently stood for three fires would be a worse lie than
    // three chips: the count IS the audit trail now.
    expect(chip.detail).toMatch(/^3 fires · last /);
  });

  it('leaves a lone fire exactly as it was', () => {
    const events = foldCronTurns(quiet());
    // Same array identity — this runs on every render of every chat, and the
    // overwhelmingly common transcript has nothing to coalesce.
    expect(coalesceCronFires(events)).toBe(events);
    expect(chips(events)[0]).not.toHaveProperty('detail');
  });

  it('a fire that SPOKE keeps its own chip, above what it said', () => {
    // The one case the chip was always for: something appeared in the
    // conversation and you need to know a schedule put it there.
    const out = run([...quiet(), ...quiet(), ...fire('nw-close'), reply('CLOSE 10/7 · −$26K')]);
    const names = chips(out).map((c) => c.text);
    expect(names).toEqual(['nw-hourly', 'nw-close']);
  });

  it('a person typing ends the stretch', () => {
    const out = run([...quiet(), ...quiet(), user('hey'), prose('hi'), ...quiet(), ...quiet()]);
    expect(chips(out)).toHaveLength(2);
    expect(chips(out)[0]?.detail).toMatch(/^2 fires/);
  });

  it('never merges two different schedules into one chip', () => {
    // Averaging two schedules together answers a question nobody asked.
    const out = run([...quiet('nw-hourly'), ...quiet('pr-sweep')]);
    expect(chips(out).map((c) => c.text)).toEqual(['nw-hourly', 'pr-sweep']);
  });

  it('leaves an UNFOLDED fire alone — its prompt is a visible bubble', () => {
    const out = run([...fire('nw-hourly', false), tool(), ...fire('nw-hourly', false)]);
    expect(chips(out)).toHaveLength(2);
  });

  it('leaves a fire that collapsed MISSED fires alone', () => {
    // That detail is the unusual thing, and it is the thing worth a row.
    const missed = expandCronFire(
      renderCronMarker({ id: 'cm', name: 'nw-hourly', at: null, missed: 3, fold: true }, 'go'),
      id(),
      0,
    );
    if (!missed) throw new Error('fixture');
    const out = run([...quiet(), ...missed, prose('closed')]);
    expect(chips(out)).toHaveLength(2);
    expect(chips(out)[1]?.detail).toMatch(/missed/);
  });

  it('merges the action runs too — that is where the other 24 rows went', () => {
    // Dropping the chips is only half of it: the notices were the ONLY thing
    // separating each fire's plumbing from the next one's, so the whole quiet
    // stretch becomes one collapsible block.
    const out = run([...quiet(), ...quiet(), ...quiet()]);
    const i = out.findIndex((e) => e.kind === 'notice');
    const after = out.slice(i + 1);
    expect(after.some((e) => e.kind === 'notice')).toBe(false);
    expect(after.length).toBeGreaterThan(6);
  });
});

describe('coalesceCronFires — what counts as "nothing visible"', () => {
  it('does NOT absorb across a run that renders inline', () => {
    // Actions are plumbing only when they actually collapse. A lone tool row
    // (no demoted prose, so `foldsAsActionRun` is false) is rendered as a
    // VISIBLE row — absorbing the chip above it would leave work on screen with
    // nothing saying a schedule caused it.
    const out = run([...fire('nw-hourly', true, ''), tool(), ...fire('nw-hourly', true, '')]);
    expect(chips(out)).toHaveLength(2);
  });

  it('absorbs back-to-back fires that did nothing at all', () => {
    const out = run([
      ...fire('nw-hourly', true, ''),
      ...fire('nw-hourly', true, ''),
      ...fire('nw-hourly', true, ''),
    ]);
    expect(chips(out)).toHaveLength(1);
  });
});
