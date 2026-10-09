import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'muxpad'),
  'utf8',
);

/**
 * A SCHEDULE'S TURN IS MACHINERY, AND THE FIRE SAYS WHAT IT MEANS TO SAY.
 *
 * ── THREE SHAPES, AND THE LAST ONE IS ON THE RIGHT AXIS ────────────────────
 * `--fold` folded the injected PROMPT. Then the prompt started folding
 * unconditionally — an instruction a schedule handed the agent is never
 * something a person said — and the flag quietly became "fold the REPLY", the
 * opposite of its documentation, so it was renamed `--silent`. Then the
 * DEFAULT turned out to be backwards too, because no schedule here has
 * anything to say: each writes a card or sends a push and replies with
 * whatever token its prompt asked for in place of an answer. Reported as the
 * cron "making its way to the main chat window" — chip, "3 actions", "ok".
 *
 * Inverting it to `--speak` fixed the common case and left the real one
 * broken, which is the point of this file. `net-watch` is "SILENT unless a
 * trigger fires": declared quiet it hides the one message that matters,
 * declared speaking it prints "net: no" every weekday. A flag on the SCHEDULE
 * cannot answer a question only the FIRE knows.
 *
 * So there is no flag. Everything a fire does folds, and `muxpad say` is the
 * exception — it prints a marker that the normalizer lifts into a message with
 * `voice: 'reply'`, which was already exempt from every fold in the product.
 * Chat mode has had exactly this since it shipped, as the `reply` TOOL; agent
 * mode registers no muxpad tools ("AGENT MODE IS RAW"), so it gets the same
 * distinction through the CLI.
 *
 * ── AND NOT BY READING THE TEXT ────────────────────────────────────────────
 * One attempt in between matched the reply against a list of acknowledgement
 * words — "ok", "done", "closed" — so a chatty-by-default cron saying nothing
 * would fold itself. Overfitting a guess about English onto a question the
 * agent can answer outright, and wrong the first time a job replies "no change
 * since yesterday".
 */
describe('muxpad say', () => {
  it('exists and prints the marker the normalizer looks for', () => {
    expect(SRC).toContain('cmd_say()');
    expect(SRC).toMatch(/printf '<muxpad-said>%s<\/muxpad-said>/);
    expect(SRC).toContain('say) cmd_say');
  });

  it('reads stdin with `-`, because output is usually piped into it', () => {
    const body = SRC.slice(SRC.indexOf('cmd_say() {'));
    expect(body.slice(0, body.indexOf('\n}\n'))).toContain('text="$(cat)"');
  });

  it('is documented as the ONE thing a fire renders', () => {
    // Both surfaces: the top-level verb list, and the command's own usage —
    // somebody reaching for this is in one or the other and must not have to
    // find the second to learn that everything else is folded.
    const list = SRC.indexOf('  say "<text>"');
    expect(list).toBeGreaterThan(-1);
    expect(SRC.slice(list, list + 700)).toMatch(/machinery/);
    const usage = SRC.indexOf('usage: muxpad say');
    expect(usage).toBeGreaterThan(-1);
    expect(SRC.slice(usage, usage + 500)).toMatch(/ONLY\s+thing that renders/);
  });
});

describe('the flags it replaced', () => {
  it('sets no voice field on a cron any more', () => {
    const code = SRC.split('\n')
      .filter((l) => !l.trim().startsWith('#'))
      .join('\n');
    expect(code).not.toMatch(/\\"speak\\":/);
    expect(code).not.toMatch(/\\"fold\\":/);
  });

  it('still ACCEPTS them, because crons already carry them', () => {
    // Silently ignored beats a usage error on a schedule that has been firing
    // for months.
    expect(SRC).toMatch(/--silent\|--fold\|--speak\)/);
  });

  it('no longer claims the reply stays visible', () => {
    // The exact sentence that was false. If it ever comes back, so does the bug.
    expect(SRC).not.toContain('The agent’s reply stays');
    expect(SRC).not.toContain("The agent's reply stays");
  });
});
