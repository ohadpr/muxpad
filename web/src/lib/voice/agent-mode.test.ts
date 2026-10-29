import { describe, expect, it } from 'vitest';
import { chatVoiceActive, voiceSpokenAvailable } from '../chat-voice';

/**
 * ── THE MIC IS OFFERED IN BOTH MODES ─────────────────────────────────────
 *
 * These were ONE predicate, and the comment at the call site said so with
 * some pride: "the mic can never appear in Agent mode… one predicate, no
 * second door". The door was in the wrong place.
 *
 * `chatVoiceActive` decides whether this pane's prose is a PRIVATE
 * SCRATCHPAD — a Chat-mode contract, and applying it to an Agent pane would
 * blank a chat whose prose IS the conversation. That has nothing to do with
 * whether you can talk to the pane.
 */
describe('which panes can be spoken to', () => {
  it('offers the mic in Agent mode, which it never used to', () => {
    expect(voiceSpokenAvailable({ mode: 'agent' })).toBe(true);
    expect(voiceSpokenAvailable({ mode: 'chat' })).toBe(true);
  });

  it('offers nothing to a pane with no mode yet', () => {
    // "No agent here" and "an agent in some mode" are different states, and
    // only the second one can answer.
    expect(voiceSpokenAvailable({ mode: null })).toBe(false);
  });

  it('still does NOT apply Chat mode’s written contract to an Agent pane', () => {
    // The half that must stay Chat-only. Demoting Agent prose to a private
    // scratchpad would hide the entire conversation.
    expect(
      chatVoiceActive({
        mode: 'agent',
        turnActive: false,
        assistant: 'claude',
        closedTurnStartId: null,
      }),
    ).toBe(false);
  });

  it('keeps the two apart on a codex pane, which has no reply tool either', () => {
    expect(
      chatVoiceActive({
        mode: 'chat',
        turnActive: false,
        assistant: 'codex',
        closedTurnStartId: null,
      }),
      'codex cannot deliver Chat mode’s written contract',
    ).toBe(false);
    // …and can still be talked to: its answer comes from the stream buffer
    // like every other backend's (server/src/spoken-answer.ts).
    expect(voiceSpokenAvailable({ mode: 'agent' })).toBe(true);
  });
});
