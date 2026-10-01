import { describe, expect, it } from 'vitest';
import { isAgentPane, tabShowsPaneStrip, tabTakesPanes } from './agent-pane.js';

describe('isAgentPane', () => {
  it('reads the durable startup marker', () => {
    expect(isAgentPane({ startup_cmd: 'muxpad agent' })).toBe(true);
    expect(isAgentPane({ startup_cmd: "muxpad agent --mode chat --model 'claude-opus-5'" })).toBe(
      true,
    );
    // The pending pick is an agent pane that has not chosen a harness yet.
    expect(isAgentPane({ startup_cmd: 'muxpad agent --pick' })).toBe(true);
  });

  it('reads the chat FACE, for a pane converted after creation', () => {
    expect(isAgentPane({ startup_cmd: '/bin/zsh', face: 'chat' })).toBe(true);
  });

  it('does not fork on the agent MODE — Chat and Agent are one primitive', () => {
    expect(isAgentPane({ startup_cmd: 'muxpad agent --mode chat' })).toBe(
      isAgentPane({ startup_cmd: 'muxpad agent' }),
    );
  });

  it('is false for the surfaces where splitting is a real tool', () => {
    expect(isAgentPane({ startup_cmd: null, face: 'terminal' })).toBe(false);
    expect(isAgentPane({ startup_cmd: 'npm run dev', face: 'web' })).toBe(false);
    expect(isAgentPane(undefined)).toBe(false);
    // Not a prefix match on something that merely mentions the CLI.
    expect(isAgentPane({ startup_cmd: 'watch muxpad agent list' })).toBe(false);
  });
});

describe('tabTakesPanes', () => {
  it('is false for a tab that is nothing but agents — every chat', () => {
    expect(tabTakesPanes([{ startup_cmd: 'muxpad agent' }])).toBe(false);
    expect(
      tabTakesPanes([{ startup_cmd: 'muxpad agent' }, { startup_cmd: 'muxpad agent --mode chat' }]),
    ).toBe(false);
  });

  it('is true when ANY pane is a surface you can split', () => {
    expect(tabTakesPanes([{ startup_cmd: 'muxpad agent' }, { face: 'terminal' }])).toBe(true);
  });

  it('is true for an empty tab — there is no chat to protect', () => {
    expect(tabTakesPanes([])).toBe(true);
  });
});

describe('tabShowsPaneStrip', () => {
  it('is false for a ONE-PANE chat — the case that was painting a strip anyway', () => {
    // Removing the `+` was only half of "one pane per tab, except terminals".
    // The strip still painted, so every chat carried a row naming the pane it
    // was already showing, a duplicate of the sidebar's status mark, a × that
    // only empties the tab, and an "Expand to split" with nothing to split.
    expect(tabShowsPaneStrip([{ startup_cmd: 'muxpad agent' }])).toBe(false);
    // The CONVERTED pane counts too — face, not just the startup command.
    expect(tabShowsPaneStrip([{ startup_cmd: 'zsh', face: 'chat' }])).toBe(false);
  });

  it('is true once an agent-only tab holds TWO — the strip is the only way across', () => {
    expect(
      tabShowsPaneStrip([
        { startup_cmd: 'muxpad agent' },
        { startup_cmd: 'muxpad agent --mode chat' },
      ]),
    ).toBe(true);
  });

  it('is true for a one-pane tab that TAKES panes — that is where the + lives', () => {
    expect(tabShowsPaneStrip([{ face: 'terminal' }])).toBe(true);
    expect(tabShowsPaneStrip([])).toBe(true);
  });
});
