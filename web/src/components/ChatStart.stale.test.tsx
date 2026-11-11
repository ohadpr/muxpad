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

/** The stale CELL's own markup, so a control elsewhere cannot satisfy this. */
const cell = (): string => {
  const at = SRC.indexOf('data-testid="chat-status-stale"');
  expect(at, 'the stale cell is gone — this test is about nothing').toBeGreaterThan(-1);
  return SRC.slice(at, SRC.indexOf('</button>', at));
};

describe('the older-build cell IS the button', () => {
  it('rebases on press — no panel in between', () => {
    // It used to be a label that opened a panel that held the control:
    // three steps to one act. "i need a single rebase button… i only see
    // 'older build' label which i thought we dropped."
    expect(cell()).toMatch(/rebasePane\(paneId\)/);
    // …and the panel is gone, not merely bypassed.
    expect(SRC).not.toContain("panel === 'stale'");
  });

  it('says what you can DO, not what is wrong', () => {
    expect(cell()).toMatch(/'rebasing…' : 'rebase'/);
    expect(cell()).not.toMatch(/>older build</);
  });

  it('keeps the diagnosis and the cost in the title', () => {
    // The question "why is this here" is asked once; the action is taken
    // every time. But the cost must still be readable before the press.
    expect(cell()).toMatch(/older build of muxpad/);
    expect(cell()).toMatch(/background work and scheduled wake-ups/);
  });

  it('cannot be double-fired while it is running', () => {
    expect(cell()).toMatch(/if \(rebasing\) return;/);
    expect(cell()).toMatch(/disabled=\{rebasing\}/);
  });

  it('sends NO mode — the server picks the best it can do for this chat', () => {
    // One button, one promise: this conversation, on today's instructions.
    // How far muxpad can get toward that differs per chat, and that choice
    // belongs on the server — which is also how the button gets better when
    // the transcript rebase lands, without a line changing here.
    // The entry itself, not the 400 characters after it: the next api call
    // along mentions a mode of its own and made this pass for the wrong
    // reason the first time.
    const at = API.indexOf('rebasePane:');
    const call = API.slice(at, API.indexOf('}),', at) + 3);
    expect(call).toContain('/rebase');
    expect(call).not.toContain('mode');
    // `fresh` summarises the history out of the window. It answers a
    // different question and must not be reachable by pressing this.
    expect(call).not.toContain('fresh');
  });
});
