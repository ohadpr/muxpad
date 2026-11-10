import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A DOOMED COMMAND MUST GO QUIET, NOT DRUM.
 *
 * `muxpad serve` restarts its child for ever, which is right — but the backoff
 * ceiling was 30s, and 30s is not a ceiling for a command that can never
 * start. It is a promise to retry 120 times an hour until somebody notices.
 *
 * Measured, from the incident this test exists for: a browser host whose
 * Chrome could not be attached to was restarted for TEN HOURS at that cadence,
 * about 1,200 times, each attempt leaking a process. The machine reached 4,040
 * processes, 3,014 of them orphaned `chrome-headless-shell`.
 *
 * The leak is fixed in the host. This is the other half: the rate.
 *
 * Asserted against the script's own arithmetic rather than by running a shell
 * loop for an hour — the policy is four lines of bash and it is the policy
 * that can be wrong.
 */
const script = readFileSync(join(__dirname, '../../scripts/muxpad'), 'utf8');

/** The doubling the script performs, read off the script itself. */
function policy() {
  const cap = Number(/backoff" -gt (\d+) \]/.exec(script)?.[1]);
  const healthy = Number(/if \[ "\$ran" -lt (\d+) \]/.exec(script)?.[1]);
  if (!Number.isFinite(cap) || !Number.isFinite(healthy))
    throw new Error('the backoff policy has moved — this test is now about nothing');
  return { cap, healthy };
}

describe('the serve supervisor backs off far enough to matter', () => {
  it('does not settle at a cadence that hammers a dead command all day', () => {
    const { cap } = policy();
    // 30s was the old value and the reason the incident lasted ten hours.
    expect(cap).toBeGreaterThan(30);
    // Attempts per hour at the ceiling, which is the number that actually
    // describes the cost of a permanent failure.
    expect(3600 / cap).toBeLessThanOrEqual(12);
  });

  it('still retries fast at first, so a slow bind is not punished', () => {
    const { cap } = policy();
    // Ordinary doubling from 2s: a service that takes a few tries to bind
    // must not be pushed straight to the ceiling.
    let wait = 2;
    const waits: number[] = [];
    for (let i = 0; i < 7; i++) {
      wait = Math.min(wait * 2, cap);
      waits.push(wait);
    }
    expect(waits[0]).toBe(4);
    // 4+8+16+32+64+128+256 — seven retries inside nine minutes, before the
    // ceiling is reached at all.
    expect(waits.reduce((a, b) => a + b, 0)).toBe(508);
    expect(waits.every((w) => w <= cap)).toBe(true);
  });

  it('resets after a run that actually lived', () => {
    const { healthy } = policy();
    expect(healthy).toBeGreaterThanOrEqual(10);
    expect(script).toMatch(/fails=0\n\s*backoff=2/);
  });

  it('gives up after a term, and that term is seven days by default', () => {
    // The owner's call: a thing muxpad runs for you should survive a weekend
    // outage and a Monday morning, and should NOT still be hammering a broken
    // command a fortnight later with nobody told.
    expect(script).toMatch(/FLAG_retry_for:-7d/);
    // The spell is what is timed, not the process: a command that works all
    // week and breaks on Friday gets its own full term from Friday.
    expect(script).toMatch(/first_fail=\$SECONDS/);
    expect(script).toMatch(/first_fail=0/);
    expect(script).toMatch(/giving up/);
    // …and forever is still available for the command that must never stop.
    expect(script).toMatch(/retry_for" != "0"/);
  });

  it('refuses a malformed term instead of guessing one', () => {
    // `bogus` ends in `s`, so a loose parser read it as seconds, kept "bogu",
    // and a typo silently configured a retry term of nothing at all.
    expect(script).toMatch(/\*\[!0-9dhms\]\*/);
  });

  it('says once, out loud, that the command is not starting', () => {
    // The per-restart line scrolls past. Somebody opening this pane an hour
    // later needs to know it has been failing since long before they looked.
    expect(script).toMatch(/failures in a row/);
  });
});
