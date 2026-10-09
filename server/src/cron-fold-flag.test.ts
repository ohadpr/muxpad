import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'muxpad'),
  'utf8',
);

/**
 * A SCHEDULE'S TURN IS MACHINERY UNLESS IT SAYS OTHERWISE.
 *
 * ── THE FLAG'S THIRD AND LAST SHAPE ────────────────────────────────────────
 * It began as `--fold`, folding the injected PROMPT. Then the prompt started
 * folding unconditionally — an instruction a schedule handed the agent is
 * never something a person said — and the flag quietly became "fold the
 * REPLY", the opposite of its own documentation. It was renamed `--silent` to
 * match.
 *
 * What stayed wrong through all of that was the DEFAULT. A cron spoke unless
 * its author remembered a flag, and no schedule on this machine has anything
 * to say: each one writes a card or sends a push and then replies with
 * whatever token its prompt asked for in place of an answer. Reported as the
 * cron "making its way to the main chat window" — ⏱ chip, "3 actions", "ok",
 * three rows per fire whose total content is that a schedule ran.
 *
 * ── AND IT WAS ONLY EVER BROKEN IN HALF THE PRODUCT ────────────────────────
 * Chat mode has always had the general rule, with no flag and no list of
 * words: `applyChatVoice` promotes prose back only inside a segment a HUMAN
 * started, and `isHumanTurnStart` excludes a bubble preceded by a machine
 * notice — exactly a cron fire. It returns its input untouched when the voice
 * is not in force, so an agent-mode pane never ran it. The chat where this was
 * reported is an agent session.
 *
 * So: `--speak` means the reply is the deliverable, and the default is the
 * inverse of what it was. A flag rather than applying Chat mode's rule
 * unconditionally, because agent mode has no `reply` tool — the escape hatch
 * Chat mode uses does not exist there.
 *
 * ── WHAT THIS IS NOT ───────────────────────────────────────────────────────
 * A previous attempt matched the reply against a list of acknowledgement words
 * ("ok", "done", "closed") so a chatty-by-default cron saying nothing would
 * fold itself. That is overfitting a guess about English onto a question the
 * schedule's author can answer outright, and it would have been wrong the
 * first time a job replied "no change since yesterday".
 */
describe('the cron speak flag', () => {
  it('exists, and sets the field', () => {
    expect(SRC).toMatch(/--speak\)\s*speak_flag=1/);
    expect(SRC).toContain('\\"speak\\":true');
  });

  it('keeps the old spellings working as no-ops', () => {
    // Crons and scripts already pass them, and they asked for what is now the
    // default — so they must not error, and must not mean the opposite.
    expect(SRC).toMatch(/--silent\|--fold\)\s*fold_flag=1/);
    expect(SRC).not.toMatch(/fold_flag.*body\+=/);
  });

  it('documents the DEFAULT, not just the flag', () => {
    const i = SRC.indexOf('cron new … --speak');
    expect(i).toBeGreaterThan(-1);
    const help = SRC.slice(i, i + 900);
    expect(help).toMatch(/DELIVERABLE/);
    // The part a reader needs most: what happens if you say nothing at all.
    expect(help).toMatch(/Without it/);
    expect(help).toMatch(/not a\n?\s*#?\s*message|is not a message/);
  });

  it('no longer claims the reply stays visible', () => {
    // The exact sentence that was false. If it ever comes back, so does the bug.
    expect(SRC).not.toContain('The agent’s reply stays');
    expect(SRC).not.toContain("The agent's reply stays");
  });
});
