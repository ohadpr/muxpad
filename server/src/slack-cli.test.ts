import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const MUXPAD_BIN = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'scripts',
  'muxpad',
);
const SRC = readFileSync(MUXPAD_BIN, 'utf8');

/** The body of a shell function, by name. */
function fn(name: string): string {
  const i = SRC.indexOf(`${name}() {`);
  if (i < 0) throw new Error(`no function ${name}`);
  // functions here are flat — the first line starting with `}` closes it
  const end = SRC.indexOf('\n}\n', i);
  return SRC.slice(i, end);
}

/**
 * `muxpad slack` — the identity rules, as tests.
 *
 * ── THE INCIDENT ────────────────────────────────────────────────────────────
 * "Send Andrey a PR review message" was posted as the BOT. It did not land in
 * the user's DM with Andrey; it landed in Andrey's separate DM with "muxpad", a
 * conversation the user cannot see. It could not be undone either: the bot
 * lacks `conversations.history`, and `chat.postMessage`'s response — including
 * the ts, which is the only handle `chat.delete` takes — was thrown away.
 *
 * Underneath was a plain coupling bug: `cmd_slack_post` chose the bot token to
 * post with, while `slack_channel_id` defaulted to the USER token to resolve
 * `@andrey`. A DM's conversation id is per-identity, so it opened the user's own
 * DM and then tried to post into it with a token that is not a member —
 * `channel_not_found`, on a channel that certainly existed.
 *
 * These pin the three things that stop it recurring. No network: everything
 * here is either the script's own source or a failure that happens before any
 * API call.
 */
describe('slack identity', () => {
  it('resolves a conversation with the SAME token it will use it with', () => {
    // The fix is structural, not a careful call site: the token is a REQUIRED
    // first argument, so a caller that forgets it gets an error instead of
    // silently borrowing the other identity.
    const body = fn('slack_channel_id');
    expect(body).not.toMatch(/local tok="\$\{2:-/); // the default that caused it
    expect(body).toMatch(/local tok="\$\{1:-\}" ref="\$\{2:-\}"/);
    expect(body).toMatch(/slack_channel_id needs <token> <ref>/);
  });

  it('every caller passes its own token positionally', () => {
    // `cmd_slack_read` had the same latent coupling — it computed a token and
    // then called the lookup without it. It only worked because the default
    // happened to match.
    for (const caller of ['cmd_slack_read', 'cmd_slack_post']) {
      const body = fn(caller);
      // Invocations only — the word also appears in a comment pointing at the
      // function, and matching that made this assert against prose.
      const calls = body
        .split('\n')
        .filter((l) => !l.trimStart().startsWith('#'))
        .flatMap((l) => [...l.matchAll(/slack_channel_id ([^\n]*)/g)].map((m) => m[1] ?? ''));
      expect(calls.length).toBeGreaterThan(0);
      for (const c of calls) expect(c).toMatch(/^"\$tok" "\$ref"/);
    }
  });

  it('has no identity to choose any more — every message is the user', () => {
    // This file used to pin that a DM REFUSED without an explicit `--as-me` or
    // `--as-bot`, which was the right fix while both identities existed. They
    // do not: a bot DM lands in the recipient's separate conversation with
    // "muxpad", invisible to the sender, so the option was removed rather than
    // guarded. See slack-guard.test.ts for what replaced it.
    expect(fn('cmd_slack_post')).not.toContain('as_bot');
    expect(fn('cmd_slack_post')).toMatch(/tok="\$\{SLACK_USER_TOKEN:-\}"/);
  });

  it('keeps the ts, because it is the only undo handle', () => {
    // `chat.delete` takes a ts and nothing else, and recovering a forgotten one
    // needs history scope the bot does not have. Discarding the response made
    // the bot message permanent.
    const body = fn('cmd_slack_post');
    expect(body).toMatch(/out="\$\(slack_api chat\.postMessage/);
    expect(body).toMatch(/jq -r '\.ts/);
    expect(body).toMatch(/unpost/);
  });

  it('names the sender AND the conversation in its confirmation', () => {
    // "sent to @andrey" was true and useless — it named neither of the two
    // things that went wrong.
    const body = fn('cmd_slack_post');
    expect(body).toMatch(/sent as you → \$\{ref\}/);
    expect(body).toMatch(/\$\{id\}/);
  });

  it('deletes with the one identity there is', () => {
    // Slack only lets a token delete its own messages. With a single identity
    // there is nothing to carry through — which is the simplification, not an
    // omission.
    expect(fn('cmd_slack_unpost')).toMatch(/tok="\$\{SLACK_USER_TOKEN:-\}"/);
  });
});
