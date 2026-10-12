import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SecretsModeError,
  clearSlackToken,
  migrateLegacySlackEnv,
  secretsPath,
  setSlackToken,
  slackToken,
  slackTokenHint,
} from './slack-secrets.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'secrets-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const TOKEN = 'xoxp-1111-2222-abcdef4f2a';

describe('the Slack credential', () => {
  it('round-trips', () => {
    expect(slackToken(dir)).toBeNull();
    setSlackToken(dir, TOKEN);
    expect(slackToken(dir)).toBe(TOKEN);
    clearSlackToken(dir);
    expect(slackToken(dir)).toBeNull();
  });

  it('is written 0600, not whatever the umask says', () => {
    setSlackToken(dir, TOKEN);
    // eslint-disable-next-line no-bitwise
    expect(statSync(secretsPath(dir)).mode & 0o777).toBe(0o600);
  });

  it('REFUSES to read a file other processes can', () => {
    // Not a tidiness check. A credential file that something copied with the
    // wrong mode is readable by every process on the machine, and the failure
    // is silent unless somebody looks — so this looks, on every read.
    setSlackToken(dir, TOKEN);
    chmodSync(secretsPath(dir), 0o644);
    expect(() => slackToken(dir)).toThrow(SecretsModeError);
    expect(() => slackToken(dir)).toThrow(/chmod 600/);
  });

  it('tells the UI there is one, and four characters of it', () => {
    setSlackToken(dir, TOKEN);
    const hint = slackTokenHint(dir);
    expect(hint).toBe('xoxp-…4f2a');
    // Enough to tell two tokens apart; not enough to use. A field that can be
    // read back is a field that ends up in a screenshot.
    expect(hint).not.toContain('1111');
    expect(hint?.length).toBeLessThan(TOKEN.length);
  });

  it('survives a corrupt file rather than taking the process down', () => {
    writeFileSync(secretsPath(dir), 'not json at all', { mode: 0o600 });
    expect(slackToken(dir)).toBeNull();
    setSlackToken(dir, TOKEN);
    expect(slackToken(dir)).toBe(TOKEN);
  });
});

/**
 * THE MIGRATION, which is most of the point — and which destroyed a real
 * credential before it was shaped like this.
 *
 * The first version lived inside `slackToken()` and read a hardcoded
 * `~/.claude/secrets/slack.env`, so the first test to call `slackToken()`
 * against an empty temp dir read the author's actual token and unlinked it.
 * Every assertion below takes an explicit path for that reason; none of them
 * can reach a real file even by accident.
 */
describe('migrating off the old shell-sourced env file', () => {
  const legacyIn = (contents: string) => {
    const home = mkdtempSync(join(tmpdir(), 'legacy-'));
    const path = join(home, 'slack.env');
    writeFileSync(path, contents);
    return path;
  };

  it('moves the token and DELETES the original', () => {
    // Deleting is the point, not tidiness: the old file is the one any pane
    // could read, so copying out and leaving it would change where the
    // credential lives and nothing about who can reach it.
    const legacy = legacyIn(`SLACK_USER_TOKEN=${TOKEN}\nSLACK_BOT_TOKEN=xoxb-dead\n`);
    expect(migrateLegacySlackEnv(dir, legacy)).toBe('migrated');
    expect(slackToken(dir)).toBe(TOKEN);
    expect(existsSync(legacy)).toBe(false);
  });

  it('lands it at 0600 like anything else written here', () => {
    const legacy = legacyIn(`export SLACK_USER_TOKEN="${TOKEN}"\n`);
    migrateLegacySlackEnv(dir, legacy);
    // eslint-disable-next-line no-bitwise
    expect(statSync(secretsPath(dir)).mode & 0o777).toBe(0o600);
  });

  it('does nothing, and deletes nothing, when there is already a token', () => {
    setSlackToken(dir, TOKEN);
    const legacy = legacyIn('SLACK_USER_TOKEN=xoxp-some-other-one\n');
    expect(migrateLegacySlackEnv(dir, legacy)).toBe('nothing-to-do');
    expect(slackToken(dir)).toBe(TOKEN);
    expect(existsSync(legacy)).toBe(true);
  });

  it('does not delete a file it could not read a token out of', () => {
    // The real file on the author's machine had an `xapp-` value in the user
    // slot. Deleting that would have thrown away the only record of a
    // misconfiguration, for nothing.
    const legacy = legacyIn('SLACK_USER_TOKEN=xapp-1-A0C-notatoken\n');
    expect(migrateLegacySlackEnv(dir, legacy)).toBe('nothing-to-do');
    expect(existsSync(legacy)).toBe(true);
    expect(slackToken(dir)).toBeNull();
  });

  it('is a no-op when the old file was never there', () => {
    expect(migrateLegacySlackEnv(dir, join(dir, 'nope.env'))).toBe('nothing-to-do');
  });
});

/**
 * AND READING NEVER DESTROYS ANYTHING. The rule that came out of the above,
 * asserted directly so it cannot quietly stop being true.
 */
describe('slackToken is a read', () => {
  it('does not touch a legacy file, even one sitting right there', () => {
    const home = mkdtempSync(join(tmpdir(), 'legacy-'));
    const path = join(home, 'slack.env');
    writeFileSync(path, `SLACK_USER_TOKEN=${TOKEN}\n`);
    expect(slackToken(dir)).toBeNull();
    expect(existsSync(path)).toBe(true);
  });
});
