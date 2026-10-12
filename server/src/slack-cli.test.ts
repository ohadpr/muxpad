import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const MUXPAD = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'muxpad');
const SRC = readFileSync(MUXPAD, 'utf8');
/** Code only. Half of this file's job is proving an absence, and a comment
 *  explaining why something is absent names the thing — which is how an
 *  earlier version of these assertions failed against a correct script. */
const CODE = SRC.split('\n')
  .filter((l) => !l.trim().startsWith('#'))
  .join('\n');

/**
 * THE CLI HOLDS NO CREDENTIAL, AND MAKES NO CLAIM ABOUT WHO IT IS.
 *
 * It used to do both, and both were the same mistake — trusting the caller:
 *
 *   · it SOURCED ~/.claude/secrets/slack.env. A chat that was refused could
 *     read the token out of that file and curl Slack directly, so the
 *     workspace check only ever stopped an agent that wanted to be stopped;
 *   · it identified itself with $MUXPAD_PANE_ID, which the caller sets.
 *     `MUXPAD_PANE_ID=<a work pane> muxpad slack post …` from a personal chat
 *     went straight through. The test suite at the time asserted that
 *     $MUXPAD_WORKSPACE_ID could not be spoofed — the variable that was no
 *     longer being read — and said nothing about the one that was.
 *
 * These assertions are about ABSENCE for that reason. A behavioural test
 * passes just as happily with a token-reading fallback sitting unused beside
 * the new path, and an unused fallback is one bug away from being used.
 */
describe('the Slack CLI reads no credential', () => {
  it('names no Slack token variable at all', () => {
    expect(CODE).not.toMatch(/SLACK_USER_TOKEN|SLACK_BOT_TOKEN/);
  });

  it('names no secrets file', () => {
    expect(CODE).not.toMatch(/SLACK_SECRETS|secrets\/slack\.env/);
  });

  it('never sources anything', () => {
    // `set -a; . "$FILE"` was the mechanism. Nothing in this script should
    // dot-source a file now, Slack or otherwise.
    expect(CODE).not.toMatch(/^\s*\.\s+["$]/m);
  });

  it('never talks to slack.com', () => {
    expect(CODE).not.toContain('slack.com/api');
  });
});

describe('the Slack CLI cannot simply assert which pane it is', () => {
  it('presents the key beside the id, never the id alone', () => {
    // The id is a value any caller can set — that was the hole. The key is
    // one the server minted for THIS pane and put in its spawn environment.
    for (const verb of ['read', 'search', 'post', 'unpost', 'channels']) {
      const body = CODE.slice(CODE.indexOf(`cmd_slack_${verb}() {`));
      const fn = body.slice(0, body.indexOf('\n}\n'));
      expect(fn, verb).toContain('MUXPAD_PANE_KEY');
    }
  });

  it('fails closed, with instructions, when the pane has no key', () => {
    // Panes older than the feature have none and cannot be given one while
    // running. "Restart this pane" is the only useful thing to say.
    const body = CODE.slice(CODE.indexOf('slack_ident() {'));
    const fn = body.slice(0, body.indexOf('\n}\n'));
    expect(fn).toContain('MUXPAD_PANE_KEY');
    expect(fn).toMatch(/exit 1/);
    expect(SRC).toMatch(/Restart this pane, or open a new/);
  });

  it('never sends the workspace id — that is the caller grading its own paper', () => {
    const section = CODE.slice(CODE.indexOf('slack_ident()'), CODE.indexOf('cmd_slack() {'));
    expect(section).not.toContain('MUXPAD_WORKSPACE_ID');
  });
});

describe('one identity, and the disclosure is not ours to forget', () => {
  it('offers no way to ask for a bot', () => {
    expect(SRC).not.toContain('--as-bot');
  });

  it('does not add the robot prefix here', () => {
    // The server does it. This script is no longer the only thing that can
    // post, so a prefix applied by each caller is a prefix that will be
    // missing from whichever caller is written next.
    const post = CODE.slice(CODE.indexOf('cmd_slack_post() {'));
    expect(post.slice(0, post.indexOf('\n}\n'))).not.toContain('🤖');
  });

  it('keeps the ts, because it is the only undo handle', () => {
    const post = CODE.slice(CODE.indexOf('cmd_slack_post() {'));
    expect(post).toContain('muxpad slack unpost');
  });
});
