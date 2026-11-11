import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A SIGN WITH NO DOOR.
 *
 * The "older build" panel named a real problem — this agent is running
 * different code, and instructions, from what muxpad would start now — and
 * then offered nothing but a paragraph. The objection that kept it that way
 * (a restart ends the pane's background work) is an argument for making the
 * act DELIBERATE, which a control somebody has to find, open and press
 * already is.
 *
 * One button, not two: "any sign of old instructions / old agent / old
 * whatever — REBASE". Keeping the conversation and refreshing the
 * instructions is one act from where the reader sits.
 */
const SRC = readFileSync(join(__dirname, 'ChatStart.tsx'), 'utf8');
const API = readFileSync(join(__dirname, '..', 'api.ts'), 'utf8');

/** The stale popover's own markup, so a button elsewhere cannot satisfy this. */
const panel = (): string => {
  const at = SRC.indexOf('Running an older build');
  expect(at, 'the stale panel is gone — this test is about nothing').toBeGreaterThan(-1);
  return SRC.slice(at, SRC.indexOf('chat-status-seg-wrap', at));
};

describe('the older-build panel offers the way out', () => {
  it('has exactly ONE button', () => {
    const buttons = panel().match(/<button/g) ?? [];
    expect(buttons).toHaveLength(1);
  });

  it('and it rebases, rather than respawning behind the user’s back', () => {
    expect(panel()).toMatch(/rebasePane\(paneId\)/);
    expect(panel()).toMatch(/Rebase this chat/);
  });

  it('says the cost before the press — background work ends', () => {
    // The whole reason this was a paragraph for months. It still has to be
    // said; it just no longer has to be the only thing said.
    expect(panel()).toMatch(/background work and scheduled wake-ups/);
  });

  it('keeps the history: the call asks for `keep`, never `fresh`', () => {
    // `fresh` drops the conversation out of the agent's context and seeds a
    // briefing — a compaction wearing a nicer name, and the opposite of what
    // "rebase" was asked for.
    const call = API.slice(API.indexOf('rebasePane:'), API.indexOf('rebasePane:') + 400);
    expect(call).toContain("mode: 'keep'");
    expect(call).not.toContain('fresh');
  });
});
