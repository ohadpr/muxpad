import { describe, expect, it } from 'vitest';
import {
  isAgentPane,
  isSplitLayout,
  rowNoun,
  rowNounTitle,
  tabIsOccupied,
  tabTakesPanes,
} from './agent-pane.js';

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
  it('is false for every tab — a tab holds one thing', () => {
    // A chat, as before.
    expect(tabTakesPanes([{ startup_cmd: 'muxpad agent' }])).toBe(false);
    // A terminal: this was the last tab that offered a `+`, and the `+` was
    // how a second pane got in.
    expect(tabTakesPanes([{ face: 'terminal' }])).toBe(false);
    expect(tabTakesPanes([{ startup_cmd: 'muxpad agent' }, { face: 'terminal' }])).toBe(false);
    // An empty tab gets its first thing from its empty state, not a `+`.
    expect(tabTakesPanes([])).toBe(false);
  });
});

describe('rowNoun — what a person calls the row', () => {
  it('names an agent row by its mode, which is fixed at creation', () => {
    expect(rowNoun({ startup_cmd: 'muxpad agent --mode chat', mode: 'chat' })).toBe('chat');
    expect(rowNoun({ startup_cmd: 'muxpad agent', mode: 'agent' })).toBe('agent');
    // The pre-rename spellings are still on old rows.
    expect(rowNoun({ startup_cmd: 'muxpad agent', mode: 'do' })).toBe('chat');
    expect(rowNoun({ startup_cmd: 'muxpad agent', mode: 'deep' })).toBe('agent');
  });

  it('reads a row with no recorded mode as Agent, never as Chat', () => {
    // Claiming Chat would assert a contract nobody put in front of the model.
    expect(rowNoun({ startup_cmd: 'muxpad agent' })).toBe('agent');
  });

  it('calls a shell a terminal, whatever mode its row happens to carry', () => {
    // The live install's one terminal row has `mode: 'chat'` stored — a column
    // default, not a fact about it.
    expect(rowNoun({ startup_cmd: null, face: 'terminal', mode: 'chat' })).toBe('terminal');
    expect(rowNoun({ startup_cmd: 'npm run dev', face: 'web' })).toBe('terminal');
    expect(rowNoun(undefined)).toBe('terminal');
  });

  it('calls a converted pane by what it now is', () => {
    expect(rowNoun({ startup_cmd: '/bin/zsh', face: 'chat', mode: 'chat' })).toBe('chat');
  });

  it('does not call a page with no terminal behind it a terminal', () => {
    expect(rowNoun({ kind: 'url', face: 'web' })).toBe('web view');
  });

  it('capitalises for a label', () => {
    expect(rowNounTitle({ startup_cmd: 'muxpad agent', mode: 'chat' })).toBe('Chat');
    expect(rowNounTitle({ startup_cmd: null })).toBe('Terminal');
    expect(rowNounTitle({ kind: 'url' })).toBe('Web view');
  });
});

describe('tabIsOccupied — does this tab already hold its one thing?', () => {
  it('is true when the layout names a pane that is really in the tab', () => {
    expect(tabIsOccupied('p', ['p'])).toBe(true);
  });

  it('is false for an empty tab — it may still get its first chat', () => {
    expect(tabIsOccupied('', [])).toBe(false);
  });

  it('is false for a leaf naming a pane that is gone', () => {
    // Otherwise a deleted row would lock its tab out of ever holding anything.
    expect(tabIsOccupied('gone', ['other'])).toBe(false);
  });

  it('is false for a document tab: rows, but no layout', () => {
    expect(tabIsOccupied('', ['block-1', 'block-2'])).toBe(false);
  });

  it('reads an old split too', () => {
    expect(tabIsOccupied({ direction: 'row', first: 'a', second: 'b' }, ['b'])).toBe(true);
  });
});

describe('isSplitLayout', () => {
  it('is a tree, never a leaf or nothing', () => {
    expect(isSplitLayout({ direction: 'row', first: 'a', second: 'b' })).toBe(true);
    expect(isSplitLayout('a')).toBe(false);
    expect(isSplitLayout('')).toBe(false);
  });
});
