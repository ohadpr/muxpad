import { spawnSync } from 'node:child_process';
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
    expect(script).toMatch(/FLAG_retry:-7d/);
    // ── THE FLAG NAME IS A SHELL VARIABLE NAME ──────────────────────────
    // It shipped as `--retry-for`, and `unset FLAG_retry-for` is not a valid
    // identifier: under `set -e` that killed `cmd_serve` on its first line,
    // so EVERY hosted app — browser hosts, dev servers, the tunnel — failed
    // to start. Caught by hosted-e2e, which is the only test that runs a
    // real `muxpad serve`.
    expect(script).not.toMatch(/reset_flags[^\n]*\bretry-for\b/);
    // …and the parser now refuses such a name out loud instead of dying.
    expect(script).toMatch(/flag name '\$f' must be letters, digits or _/);
    // The spell is what is timed, not the process: a command that works all
    // week and breaks on Friday gets its own full term from Friday.
    expect(script).toMatch(/first_fail=\$SECONDS/);
    expect(script).toMatch(/giving up/);
    // …and forever is still available for the command that must never stop.
    expect(script).toMatch(/retry_for" != "0"/);

    // ── THE DEFECT THIS LINE EXISTS FOR ─────────────────────────────────
    // The spell was cleared by any run lasting 10s — the BACKOFF heuristic,
    // reused as the definition of recovery. A command that waits 15s on a
    // dependency that never arrives and exits nonzero therefore reset the
    // deadline every time: it retried for ever and the seven days never came.
    // Recovery is now a run that genuinely served.
    expect(script).toMatch(/if \[ "\$ran" -ge 600 \]; then\n\s*first_fail=-1/);
    // -1, not 0: 0 is a real value of $SECONDS (an immediate first failure)
    // and read as "no spell in progress" for one whole round.
    expect(script).toMatch(/first_fail=-1/);
    expect(script).toMatch(/first_fail" != "-1"/);
    // NOTE: the seven-day expiry itself is not executed here — it needs a
    // week of wall clock. What is executed is the parser below; what is
    // asserted here is the arithmetic that was wrong.
  });

  /**
   * ── RUN IT, DO NOT READ IT ──────────────────────────────────────────────
   *
   * The first version of these asserted that certain TEXT appeared in the
   * script, which a review called out correctly: a pattern can be present and
   * wrong, and none of them would have caught the three defects below. The
   * parser is a shell function, so the test extracts it and executes it.
   */
  const parse = (value: string): { ok: boolean; out: string } => {
    const fn = /^parse_duration_days\(\) \{[\s\S]*?^\}/m.exec(script)?.[0];
    if (!fn) throw new Error('parse_duration_days has moved — this test is about nothing');
    const r = spawnSync('bash', ['-c', `${fn}\nparse_duration_days "$1"`, '_', value], {
      encoding: 'utf8',
    });
    return { ok: r.status === 0, out: r.stdout.trim() };
  };

  it('reads the durations a person would actually type', () => {
    expect(parse('7d')).toEqual({ ok: true, out: String(7 * 86400) });
    expect(parse('36h')).toEqual({ ok: true, out: String(36 * 3600) });
    expect(parse('90m')).toEqual({ ok: true, out: '5400' });
    expect(parse('45s')).toEqual({ ok: true, out: '45' });
  });

  it('refuses a number too wide to be arithmetic, rather than WRAPPING it to zero', () => {
    // The dangerous one. `18446744073709551616` overflowed to 0, and 0 is
    // this script's sentinel for "retry for ever" — so a fat-fingered
    // duration silently removed the bound it was being asked to set.
    expect(parse('18446744073709551616').ok).toBe(false);
    expect(parse('99999999999999999999d').ok).toBe(false);
    // …and a plausible large-but-sane value still works.
    expect(parse('3650d')).toEqual({ ok: true, out: '315360000' });
  });

  it('reads a leading zero as a decimal, not as a broken octal literal', () => {
    // `08` is a good digit string and an invalid octal literal, so bare
    // arithmetic ERRORED on it instead of reading it.
    expect(parse('08')).toEqual({ ok: true, out: '8' });
    expect(parse('08d')).toEqual({ ok: true, out: String(8 * 86400) });
    // And every spelling of zero is the one sentinel, not a 0-second term
    // that would give up on the first failure.
    expect(parse('00s').out).toBe('0');
    expect(parse('0').out).toBe('0');
  });

  it('refuses what it cannot read instead of guessing', () => {
    // `bogus` ends in `s`, so a loose `*s)` branch read it as "bogu" seconds.
    for (const bad of ['bogus', '', '7dd', 'd', '3x', '-5d'])
      expect(parse(bad).ok, bad || '(empty)').toBe(false);
  });

  it('STAYS down when it gives up, instead of being respawned into a new term', () => {
    /**
     * The loop between two supervisors, which made the seven-day term nearly
     * inert: this one gives up and exits, the SERVER's serve-supervisor sees
     * a pane with no pty, respawns it, and the fresh process starts a brand
     * new term. A broken app would retry for ever at seven-day granularity
     * and never once say so.
     *
     * `stopped` is the one state AppHeal refuses to touch — "the user's own
     * decision and outranks any observation" — so stopping the app is what
     * makes the decision stick.
     */
    expect(script).toMatch(/api\/apps\/\$own\/stop/);
    expect(script).toMatch(/select\(\.pane_id==\$p\)/);
    // Best effort, always: a plain `muxpad serve` in a pane is not a
    // registered app and must still just exit.
    expect(script).toMatch(/\|\| true/);
  });

  it('says once, out loud, that the command is not starting', () => {
    // The per-restart line scrolls past. Somebody opening this pane an hour
    // later needs to know it has been failing since long before they looked.
    expect(script).toMatch(/failures in a row/);
  });
});
