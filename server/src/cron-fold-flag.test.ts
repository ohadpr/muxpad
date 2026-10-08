import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'muxpad'),
  'utf8',
);

/**
 * `--silent` MEANS THE REPLY, NOT THE PROMPT.
 *
 * The flag used to fold the injected prompt, and the help said so: "it folds the
 * PROMPT only: whatever the agent replies stays visible." Then the prompt
 * started folding unconditionally — it is an instruction a schedule handed the
 * agent, never something a person said — and the flag quietly became "fold the
 * REPLY", the opposite of its documentation.
 *
 * Nobody noticed until three live schedules were found carrying it, two of them
 * jobs whose reply IS the deliverable: `nw-close` prints a market snapshot and
 * pushes it, and the next fire would have hidden the snapshot.
 *
 * So the name changed with the meaning, and the old spelling keeps working
 * because crons already exist carrying it.
 */
describe('the cron fold flag', () => {
  it('accepts both spellings, same field', () => {
    expect(SRC).toMatch(/--silent\|--fold\)\s*fold_flag=1/);
  });

  it('documents what it actually does — the reply, not the prompt', () => {
    const i = SRC.indexOf('cron new … --silent');
    expect(i).toBeGreaterThan(-1);
    const help = SRC.slice(i, i + 700);
    expect(help).toMatch(/REPLY/);
    // …and warns about the failure that was found in the wild.
    expect(help).toMatch(/Do NOT use it on a job whose reply is the/);
  });

  it('no longer claims the reply stays visible', () => {
    // The exact sentence that was false. If it ever comes back, so does the bug.
    expect(SRC).not.toContain('The agent’s reply stays');
    expect(SRC).not.toContain("The agent's reply stays");
  });
});
