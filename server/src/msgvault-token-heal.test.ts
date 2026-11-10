import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * THE HEALER'S ONE JUDGEMENT CALL, PINNED.
 *
 * msgvault agent grants live in memory and die with the daemon, so a
 * LaunchDaemon re-issues them. The whole script is mechanical except for one
 * decision: whether a failed probe means "the grant is gone" or "something
 * else is wrong right now". Get that wrong towards re-issuing and a daemon
 * with any other fault becomes a token factory, minting a grant every two
 * minutes that the daemon then holds until it restarts.
 *
 * So the pattern is tested against the string msgvault ACTUALLY printed when
 * the grant had died — recorded here verbatim — and against the transient
 * failures that must not trigger a re-issue. A shell script is hard to test;
 * its one load-bearing regex is not.
 */
const script = readFileSync(join(__dirname, '../../scripts/msgvault-agent-token-heal.sh'), 'utf8');

const authPattern = (): RegExp => {
  const m = script.match(/grep -qiE '([^']+)'/);
  if (!m) throw new Error('the auth-error pattern has moved — this test is now about nothing');
  return new RegExp(m[1] as string, 'i');
};

describe('the healer re-issues for a dead grant and nothing else', () => {
  it('recognises the real failure, verbatim as msgvault printed it', () => {
    // Observed 2026-11-10 after a daemon restart killed the in-memory grant.
    expect(
      'Error: agent authentication failed: token is invalid, expired, revoked, or agent access is disabled: API error (401): Invalid or missing API key',
    ).toMatch(authPattern());
  });

  it('leaves the grant alone for failures that are not about authentication', () => {
    for (const transient of [
      'Error: context deadline exceeded',
      'Error: database is locked',
      'Error: dial tcp 127.0.0.1:8787: connect: connection refused',
      'Error: API error (503): service unavailable',
      'Error: disk I/O error',
    ])
      expect(transient, transient).not.toMatch(authPattern());
  });

  it('probes with a flag that exists — the bug that made it a token factory', () => {
    // `stats --json` is not a flag. A probe that can never succeed means
    // every run re-issues, forever. This asserts the probe line as shipped.
    const probe = script.match(/--log-level=error stats[^\n]*/)?.[0] ?? '';
    expect(probe).not.toContain('--json');
  });

  it('keeps a floor between re-issues, so a wrong verdict cannot loop fast', () => {
    expect(script).toMatch(/MIN_REISSUE_GAP=\d{3,}/);
    expect(script).toContain('NOW - LAST < MIN_REISSUE_GAP');
  });

  it('asks for no permission that could send', () => {
    const perms = script.match(/--permissions ([a-z.,]+)/)?.[1]?.split(',') ?? [];
    expect(perms.length).toBeGreaterThan(0);
    // An invite mails the attendees, which is sending under the owner's name.
    expect(perms).not.toContain('calendar.invite');
    expect(perms).not.toContain('calendar.write');
    expect(perms.every((p) => /\.(read|create|edit|delete)$/.test(p))).toBe(true);
  });
});
