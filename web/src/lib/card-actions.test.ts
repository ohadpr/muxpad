import { describe, expect, it } from 'vitest';
import { changeRequestDraft, removalFollowUp } from './card-actions';

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

describe('removing a card that something still writes', () => {
  it('says nothing when nothing writes it', () => {
    // A card somebody set by hand and then cleared is not worth a turn, and a
    // message per dismissal would make tidying up cost money.
    expect(removalFollowUp('scratch', [])).toBeNull();
  });

  it('names the schedule, so nobody has to go looking for it', () => {
    const say = removalFollowUp('market', ['market-hourly']) ?? '';
    expect(say).toContain('`market`');
    expect(say).toContain('`market-hourly`');
    expect(say).toContain('schedule ');
    // The reason the message exists at all: without this the card returns on
    // the next fire and the button looks broken.
    expect(say).toContain('come back');
  });

  it('reads correctly with more than one writer', () => {
    const say = removalFollowUp('build', ['a', 'b']) ?? '';
    expect(say).toContain('schedules `a`, `b`');
  });
});
