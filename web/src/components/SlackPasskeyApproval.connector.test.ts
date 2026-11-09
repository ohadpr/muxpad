import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * THE APPROVAL CARD MUST NAME THE SYSTEM IT IS ABOUT.
 *
 * This card was written when Slack was the only connector, so every string
 * and the logo were Slack's. The first msgvault failure therefore rendered as
 *
 *     [Slack logo]  Slack request failed. Nothing was retried.
 *
 * in a chat on the machine where Slack is not supposed to be reachable at
 * all. Reported as alarm, correctly: a card that names the wrong system is a
 * confident claim about what was touched.
 *
 * Fourth instance of this defect in one day — the broker's dialog, the CLI's
 * messages, the broker's error text, and this. Hence a test.
 */
const SRC = readFileSync(join(__dirname, 'SlackPasskeyApproval.tsx'), 'utf8');
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('the approval card follows the request', () => {
  it('derives the connector from the action, never from a default', () => {
    expect(CODE).toMatch(/const connectorOf = /);
    expect(CODE).toMatch(/String\(action \?\? ''\)\.split\('\.'\)\[0\]/);
  });

  it('has no Slack string left that a non-Slack request would wear', () => {
    for (const dead of [
      "'Slack request failed. Nothing was retried.'",
      "'Slack request expired.'",
      "'Finishing Slack approval…'",
      "'Slack approval'",
      'muxpad wants to access Slack<',
    ])
      expect(CODE, dead).not.toContain(dead);
  });

  it('shows the Slack mark only for Slack', () => {
    // Every SlackLogo is behind a connector check.
    for (const m of CODE.matchAll(/<SlackLogo \/>/g)) {
      const before = CODE.slice(Math.max(0, (m.index ?? 0) - 220), m.index);
      expect(before, 'an unguarded Slack logo').toMatch(/=== SLACK \?/);
    }
  });

  it('labels every msgvault verb with what it reads', () => {
    for (const action of [
      'msgvault.search',
      'msgvault.show-message',
      'msgvault.show-thread',
      'msgvault.list-senders',
      'msgvault.stats',
      'msgvault.meetings',
      'msgvault.person',
    ]) {
      const label = new RegExp(`'${action}': '([^']+)'`).exec(CODE);
      expect(label, `${action} has no label`).toBeTruthy();
      expect(label?.[1]?.length ?? 0).toBeGreaterThan(8);
    }
  });

  it('sends the REQUEST’s timed scope, not Slack’s', () => {
    // A timed approval of an archive read asked for `slack-team-all-v2`. The
    // broker refused it — and had it not, the human would have granted
    // something other than what this card described.
    expect(CODE).toMatch(/request\.timedScope \?\? 'slack-team-all-v2'/);
    expect(CODE).not.toMatch(/scope: 'slack-team-all-v2'/);
    expect(CODE).not.toMatch(/: 'slack-team-all-v2',\s*\}\)/);
  });
});
