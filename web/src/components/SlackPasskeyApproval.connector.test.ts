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
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const CODE = strip(readFileSync(join(__dirname, 'SlackPasskeyApproval.tsx'), 'utf8'));
/* What a request SAYS it is now lives in one module, so the heading, the
   limits and the marks cannot drift apart. */
const DESC = strip(readFileSync(join(__dirname, '..', 'lib', 'approval-request.ts'), 'utf8'));

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

  it('describes every msgvault verb by what it reads — and only the live ones', () => {
    // A description of a verb the broker no longer accepts describes a
    // request that can never arrive.
    for (const dead of ['msgvault.list-senders', 'msgvault.meetings', 'msgvault.person'])
      expect(DESC, dead).not.toContain(`'${dead}'`);
    for (const action of [
      'msgvault.search',
      'msgvault.show-message',
      'msgvault.show-thread',
      'msgvault.stats',
    ]) {
      const title = new RegExp(`'${action}': \\{[\\s\\S]*?title: \\(\\) => '([^']+)'`).exec(DESC);
      expect(title, `${action} has no heading`).toBeTruthy();
      expect(title?.[1]?.length ?? 0).toBeGreaterThan(8);
    }
  });

  it('decides the mark from the verb alone, never from the payload', () => {
    // A mark guessed from a query that says "standup" is wrong the moment
    // somebody emails about a standup, and a mark that lies about what is
    // being read is worse than no mark at all.
    expect(DESC).toMatch(/const MARKS: Record<string, readonly SourceMark\[\]>/);
    expect(DESC).toMatch(/'msgvault.stats': \['gmail', 'calendar', 'contacts'\]/);
    const marksFor = DESC.slice(DESC.indexOf('export const marksFor'));
    expect(marksFor.slice(0, 200)).not.toMatch(/payload|query/);
    // …and the card asks for them by action, not by connector.
    expect(CODE).toMatch(/marksFor\(request\.action\)/);
  });

  it('never hides part of the request behind a disclosure', () => {
    // The card used to put the query in 0.75rem inside a collapsed
    // <details>. A security prompt that conceals part of what it is about is
    // asking for approval of something it did not show.
    expect(CODE).not.toContain('<details');
    expect(CODE).toMatch(/fields\.map/);
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

/**
 * …AND THE REST OF THE CARD, which a review found still speaking Slack.
 *
 * Picking any duration other than "once" on an ARCHIVE request printed "All
 * agents can read, search, send, edit, delete, react, open DMs and upload
 * files in this Slack workspace" — a description of a grant that was not
 * being made. The details line showed the Slack team id. "Timed Slack access
 * is already active" appeared whenever ANY grant existed, archive ones
 * included. And the origin — the broker's entire justification for carrying
 * the field is "it is shown to the human before they approve" — was never
 * displayed in this mode at all.
 */
describe('the card describes the grant it is actually making', () => {
  it('describes a duration per capability, not always as Slack', () => {
    expect(CODE).toMatch(/connectorOf\(request\.action\) === SLACK\s*\?\s*'All agents can read/);
    expect(CODE).toMatch(/search and read your mail/);
    expect(CODE).toMatch(/cannot send, draft or change anything/);
  });

  it('shows the machine that asked, and says when it is unverified', () => {
    expect(CODE).toMatch(/asked by/);
    expect(CODE).toMatch(/request\.origin \?\? 'unknown'/);
    // A duration is refused for an origin the broker cannot attribute, so the
    // card must not imply otherwise.
    expect(CODE).toMatch(/unverified, so approve-once only/);
  });

  it('only says "already active" for the SAME capability', () => {
    expect(CODE).toMatch(/grants\?\.some\(/);
    expect(CODE).toMatch(/connectorOfGrant\(g\) === connectorOf\(request\.action\)/);
    // The unconditional version is gone.
    expect(CODE).not.toMatch(/Timed Slack access is already active/);
  });

  it('does not put a Slack team id on an archive request', () => {
    // It moved out of the origin line and in with the other payload fields —
    // it is a detail, and three facts of different weight in one small line
    // is what unbalanced the card. Still guarded: a workspace id means
    // nothing on an archive read.
    expect(CODE).toMatch(
      /=== SLACK\s*\?\s*\[\.\.\.described\.rest, \['workspace', request\.teamID\]/,
    );
    expect(CODE).not.toMatch(/` · \$\{request\.teamID\}`/);
  });
});

describe('it offers only what the broker would accept', () => {
  it('replaces the duration picker with the reason when a duration is refused', () => {
    // `timedAllowed: false` means the broker will refuse any duration: it
    // cannot attribute the origin, so a lasting permission would rest on a
    // claim anything on this machine could make. Offering 10m/1h/1d anyway
    // invited the failure that teaches people to distrust a dialog — pick,
    // sign the ceremony, watch it fail.
    expect(CODE).toMatch(/request\.timedAllowed === false \?/);
    expect(CODE).toMatch(/can only be approved <strong>once<\/strong>/);
    // The REASON is shown, not just an absence: "unavailable" with no
    // explanation is its own puzzle.
    expect(CODE).toMatch(/request\.timedRefusedReason \?\?/);
  });

  it('never sends a duration it was told would be refused', () => {
    const decide = CODE.slice(CODE.indexOf('const chosen ='));
    expect(decide.slice(0, 220)).toMatch(/request\.timedAllowed === false/);
    // Forced where the value is USED. setDuration is async and would not have
    // landed before the ceremony is built.
    expect(CODE).not.toMatch(/timedAllowed === false && duration !== 'once'\) setDuration/);
  });
});
