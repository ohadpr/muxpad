// The Chat contract's reply-guard clause, pinned because it is the only
// verbosity-adjacent rule in CHAT_MODE_SEED with a measured effect behind it.
//
// THE MEASUREMENT (isolated instance, real `muxpad agent --mode chat` runners,
// matched prompts, one fresh pane per prompt):
//
//   trivial turns — a lookup, a one-file chore — where the whole job is to
//   answer and there is nothing to report:
//
//     without this clause   6 of 10 turns ended with NO `reply` call
//     with it               0 of 10        (Fisher exact p = 0.011)
//
//   Reply LENGTH was unchanged (~70–130 chars either way): the clause fixes
//   which channel the answer leaves by, not how big it is.
//
// Why it matters even though the harness guard catches the miss. The guard
// promotes the turn's LAST prose block, which is whatever the model happened to
// write last — on a turn that ends "Done." the user gets "Done.", and the real
// answer stays folded. It also costs the sign-off drop (chat-voice.ts pass 3)
// and makes the push body fall back to `lastAssistantText`. A turn that goes
// through `reply` has none of those failure modes.
//
// If this assertion is failing because someone deliberately removed the
// clause: re-run the trivial-prompt arm before deleting the test, not after.
import { describe, expect, it } from 'vitest';
import { CHAT_MODE_SEED } from './agent-modes.js';

describe('CHAT_MODE_SEED — the reply-guard clause', () => {
  it('tells the model that the EASY turns go through `reply` too', () => {
    expect(CHAT_MODE_SEED).toMatch(/every turn ends with a `reply`/i);
    // The specific case the misses clustered on, named so the instruction has
    // something concrete to attach to rather than being a restatement of
    // "reply is your only voice" (which was already there, and did not hold).
    expect(CHAT_MODE_SEED).toMatch(/lookup/i);
  });

  it('is stated positively — what to do, not what to avoid', () => {
    const clause = CHAT_MODE_SEED.split('\n')
      .join(' ')
      .match(/\*\*Every turn ends with a `reply`[^*]*/i)?.[0];
    expect(clause).toBeTruthy();
    expect(clause).not.toMatch(/\bdo not\b|\bnever\b|\bdon't\b/i);
  });
});
