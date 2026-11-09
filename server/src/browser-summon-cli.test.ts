import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MUXPAD = resolve(ROOT, 'scripts', 'muxpad');
const SRC = readFileSync(MUXPAD, 'utf8');
const CODE = SRC.split('\n')
  .filter((l) => !l.trim().startsWith('#'))
  .join('\n');
const INSTRUCTIONS = readFileSync(resolve(ROOT, 'server', 'src', 'agent-instructions.ts'), 'utf8');

/**
 * THE SUMMON MUST SURVIVE `enforce`.
 *
 * Asking for a human was the one documented call that sent no credential: a
 * raw `curl` in the agent instructions, straight at
 * `/api/browsers/:profile/needs-you`. In `off` and `observe` that costs
 * nothing. The moment API auth is enforced it is a 401 on the one path whose
 * entire job is "I am stuck and only a person can clear this" — raised by a
 * caller that has just been told to stop and not retry, so the failure is
 * silent and terminal.
 *
 * It is a CLI verb now, so the credential comes from `http_request` with every
 * other call and nothing about it is special.
 */
describe('summoning a person goes through the CLI, credential and all', () => {
  it('has the verb, and routes it through the one authenticated funnel', () => {
    expect(CODE).toMatch(/cmd_browser_needs_you\(\) \{/);
    expect(CODE).toMatch(/browser\) cmd_browser /);
    const fn = CODE.slice(CODE.indexOf('cmd_browser_needs_you() {'), CODE.indexOf('cmd_slack() {'));
    expect(fn).toMatch(/http_request POST "\/api\/browsers\/\$profile\/needs-you"/);
    // Never its own curl: that is how it ends up without the header again.
    expect(fn).not.toMatch(/\bcurl\b/);
  });

  it('defaults to the browser THIS pane is stuck in', () => {
    const fn = CODE.slice(CODE.indexOf('cmd_browser_needs_you() {'), CODE.indexOf('cmd_slack() {'));
    expect(fn).toMatch(/profile="s-\$\{MUXPAD_TAB_ID:-\}"/);
    // …and refuses rather than posting to the profile literally named "s-".
    expect(fn).toMatch(/\[ "\$profile" != "s-" \]/);
  });

  it('no longer tells agents to curl the endpoint themselves', () => {
    expect(INSTRUCTIONS).toContain('muxpad browser needs-you');
    expect(INSTRUCTIONS).not.toMatch(/curl[^\n]*needs-you/);
  });

  it('refuses without a reason, and names the missing piece', () => {
    const r = spawnSync('bash', [MUXPAD, 'browser', 'needs-you'], { encoding: 'utf8' });
    expect(r.status).not.toBe(0);
    expect(`${r.stderr}${r.stdout}`).toMatch(/reason/i);
  });

  it('prints usage for an unknown browser subcommand instead of calling anything', () => {
    const r = spawnSync('bash', [MUXPAD, 'browser', 'wat'], { encoding: 'utf8' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/usage:/);
    expect(r.stderr).toMatch(/needs-you/);
  });
});
