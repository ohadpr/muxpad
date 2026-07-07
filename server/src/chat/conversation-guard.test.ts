import { describe, expect, it } from 'vitest';
import { findConversationRival } from './conversation-guard.js';

const sessions = [
  { pane_id: 'pane-a', current_sid: 'sid-1' },
  { pane_id: 'pane-b', current_sid: 'sid-1' }, // cross-pane resume of the same conversation
  { pane_id: 'pane-c', current_sid: 'sid-2' },
];

describe('findConversationRival', () => {
  it('flags another pane on the same sid with a live claude foreground', async () => {
    const rival = await findConversationRival('pane-a', 'sid-1', sessions, async (id) =>
      id === 'pane-b' ? 'claude --resume sid-1' : '-zsh',
    );
    expect(rival).toBe('pane-b');
  });

  it('ignores panes on other sids even when they run claude', async () => {
    const rival = await findConversationRival(
      'pane-a',
      'sid-1',
      sessions,
      async () => 'claude --resume sid-2',
    );
    // pane-b matches (same sid); pane-c does not even though claude runs there.
    expect(rival).toBe('pane-b');
    const free = await findConversationRival('pane-c', 'sid-2', sessions, async (id) =>
      id === 'pane-a' ? 'claude' : '-zsh',
    );
    expect(free).toBeNull();
  });

  it('never reports the asking pane itself', async () => {
    const rival = await findConversationRival(
      'pane-a',
      'sid-1',
      [{ pane_id: 'pane-a', current_sid: 'sid-1' }],
      async () => 'claude',
    );
    expect(rival).toBeNull();
  });

  it('is free when the sibling runs something else, and fails open on fg errors', async () => {
    const shell = await findConversationRival('pane-a', 'sid-1', sessions, async () => '-zsh');
    expect(shell).toBeNull();
    const erroring = await findConversationRival('pane-a', 'sid-1', sessions, async () => {
      throw new Error('ptyd unreachable');
    });
    expect(erroring).toBeNull();
  });

  it("flags a sibling SDK runner (writer='sdk') without a foreground probe", async () => {
    // An agent runner's foreground is `node …/agent-runner` — invisible to
    // the claude regex; the recorded writer must be enough on its own.
    const rival = await findConversationRival(
      'pane-a',
      'sid-1',
      [
        { pane_id: 'pane-a', current_sid: 'sid-1' },
        { pane_id: 'pane-b', current_sid: 'sid-1', writer: 'sdk' },
      ],
      async () => 'node /x/dist/agent-runner/index.js',
    );
    expect(rival).toBe('pane-b');
  });
});
