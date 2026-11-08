import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A TURN STARTS CLEAN FROM EVERY DOOR.
 *
 * A turn begins two ways — a dequeued message, or autonomously when a wakeup
 * or a cron fires inside the persistent session — and each door used to carry
 * its own hand-written block of sixteen assignments. They were identical bar
 * one field, which is the lucky case. The unlucky one is a seventeenth fact
 * added to one door and not the other: it then leaks from the previous turn
 * into this one, on whichever path nobody edited, and the symptom is a reply
 * guard or a quota flag behaving differently depending on who started the
 * turn.
 *
 * Nothing in a unit test can see that happen, because it is a property of the
 * SOURCE: two copies of a list. So the source is what is asserted.
 */
const SRC = readFileSync(join(import.meta.dirname, 'backends', 'claude.ts'), 'utf8');

/**
 * Per-turn ACCUMULATORS and the value each is reset to.
 *
 * Only these: a flag like `interruptRequested` is also SET elsewhere, when a
 * stop actually arrives, so counting every assignment to it would be counting
 * the feature. What must appear once is the RESET — the assignment that means
 * "a new turn is starting".
 */
const RESETS: Array<[string, string]> = [
  ['answeredThisTurn', 'false'],
  ['repliesThisTurn', '0'],
  ['streamedTextThisTurn', 'false'],
  ['saidSomethingThisTurn', 'false'],
  ['uncertainToolResult', 'false'],
  ['toolUsesThisTurn', '0'],
  ['lastAssistantText', "''"],
  ['firstReplyText', "''"],
];

describe('the turn’s entry', () => {
  it('resets each per-turn accumulator in exactly ONE place', () => {
    for (const [field, value] of RESETS) {
      const resets =
        SRC.match(new RegExp(`^\\s*${field} = ${value.replace(/'/g, "'")};`, 'gm')) ?? [];
      expect(resets.length, `${field} is reset at ${resets.length} sites, not 1`).toBe(1);
    }
  });

  it('has both doors going through it', () => {
    // The dequeued message and the autonomous turn — two CALLS, plus the
    // declaration, which is an arrow function and so does not match a call.
    const calls = SRC.match(/^\s*beginTurn\(|[^=] beginTurn\(/gm) ?? [];
    expect(calls.length).toBe(2);
    expect(SRC).toContain("beginTurn(null, 'autonomous')");
  });

  it('leaves the SESSION’s own lifecycle alone', () => {
    // These outlive any single turn, and resetting them on entry is how a
    // paused session would quietly resume or a shutdown would be forgotten.
    const fn = SRC.slice(SRC.indexOf('const beginTurn ='), SRC.indexOf('const beginTurn =') + 1400);
    for (const survives of ['shuttingDown', 'quotaPaused', 'recoveryInFlight'])
      expect(fn, `${survives} must not be reset per turn`).not.toContain(`${survives} =`);
  });

  it('does not set `clearRequested`, which only a dequeued message can mean', () => {
    // Setting it from the shared path would invent a transition the caller
    // never made: an autonomous turn has no slash command in it.
    const fn = SRC.slice(SRC.indexOf('const beginTurn ='), SRC.indexOf('const beginTurn =') + 1400);
    expect(fn).not.toContain('clearRequested =');
  });

  it('owes a reply only to a person', () => {
    // A cron is a relay, a slash command talks to the session rather than the
    // agent, and nobody asked for an autonomous turn at all.
    expect(SRC).toContain("turnHuman = kind === 'human'");
    expect(SRC).toContain("turnCron = kind === 'cron'");
  });
});
