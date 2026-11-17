import { describe, expect, it } from 'vitest';
import { changeRequestDraft, removalFollowUp } from './card-actions';

const w = (name: string, enabled = true) => ({ name, enabled });

describe('asking for a change to a card', () => {
  it('names the card and stops, leaving the sentence to the person', () => {
    // The draft is PREFILLED, never sent: only the person knows the change,
    // and a card that rewrote itself from one click is a card nobody can
    // predict.
    const d = changeRequestDraft('market');
    expect(d).toContain('`market`');
    expect(d.endsWith(': ')).toBe(true);
  });
});

describe('removing a card', () => {
  it('speaks even when the database knew of no writer', () => {
    // THE CASE THIS GETS WRONG IF IT STAYS QUIET. Measured on this machine:
    // `nw-open` and `nw-close` keep the market card fresh by running
    // scripts/market_card.sh, so the card's name is nowhere in the database.
    // Silence on an empty list is silence in exactly the common case.
    const say = removalFollowUp('market', []);
    expect(say).toContain('`market`');
    expect(say).toContain('no schedule naming it');
    expect(say).toContain('cron list');
  });

  it('never claims the list is complete', () => {
    const say = removalFollowUp('market', [w('nw-hourly')]);
    expect(say).toContain('`nw-hourly`');
    expect(say).toMatch(/hint, not an inventory/);
    // The thing a manual cleanup actually finds, and a database never will.
    expect(say).toContain('script');
  });

  it('calls out a PAUSED schedule separately rather than dropping it', () => {
    // A disabled cron cannot fire, but it is litter named for something that
    // no longer exists — and somebody resuming it later gets a job writing a
    // card nobody kept. The manual cleanup removes these too.
    const say = removalFollowUp('gmail-sync', [w('gmail-sync-card', false)]);
    expect(say).toContain('`gmail-sync-card`');
    expect(say).toContain('paused');
  });

  it('reads correctly with live and paused writers at once', () => {
    const say = removalFollowUp('build', [w('a'), w('b'), w('old', false)]);
    expect(say).toContain('`a`, `b` still write it');
    expect(say).toContain('`old` is paused');
  });

  it('asks for one line back, so the cleanup is reported and not assumed', () => {
    expect(removalFollowUp('x', [])).toContain('tell me in one line');
  });
});
