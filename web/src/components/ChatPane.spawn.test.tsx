import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { liveStatusLabel } from '../lib/live-status';
import { SessionBar } from './ChatPane';

/**
 * "I SEE NO INDICATION THAT SOMETHING IS RUNNING."
 *
 * The status strip above the composer is the persistent answer to that, and it
 * counted harness SUBAGENTS only — while muxpad's own way of running work in
 * parallel is to spawn a child CHAT (which survives a runner restart, where a
 * subagent dies with its turn). So the one indicator built to say "there is
 * parallel work here" sat at nothing through a dozen working children.
 *
 * Mounted rather than rendered to markup because the roster only exists once the
 * cell is opened, and "can I get to the child from here" is a click.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('the status strip counts child chats as running work', () => {
  let host: HTMLDivElement | null = null;
  let root: ReturnType<typeof createRoot> | null = null;

  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    host = null;
    root = null;
  });

  const CHILD = {
    id: 'chat:t-kid',
    label: 'Work review',
    steps: 0,
    busy: true,
    chat: { workspaceSlug: 'personal', tabSlug: 'kid-slug' },
  };
  const SUBAGENT = { id: 'toolu_1', label: 'grep the logs', steps: 4, busy: true };

  function mount(agents: (typeof CHILD | typeof SUBAGENT)[], onOpenChat = vi.fn()) {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
      root?.render(
        <SessionBar
          paneId="p1"
          folder={null}
          status={null}
          send={() => {}}
          liveLabel={liveStatusLabel({ agentCount: agents.length })}
          agents={agents}
          onOpenChat={onOpenChat}
          mode="chat"
        />,
      );
    });
    return { box: host, onOpenChat };
  }

  it('says a child chat is running, with no turn and no subagent in sight', () => {
    // The pre-fix state of this exact scene was an empty cell: no turn active,
    // roster empty, and a worker chat busy for the last ten minutes.
    const { box } = mount([CHILD]);
    expect(box.textContent).toContain('1 agent');
  });

  it('counts children alongside the harness roster rather than instead of it', () => {
    const { box } = mount([SUBAGENT, CHILD]);
    expect(box.textContent).toContain('2 agents');
  });

  it('names the panel for what is in it, and a child is not a subagent', () => {
    const { box } = mount([SUBAGENT]);
    act(() => box.querySelector<HTMLButtonElement>('.chat-status-seg.-live')?.click());
    expect(box.textContent).toContain('Subagent');

    const mixed = mount([SUBAGENT, CHILD]);
    act(() => mixed.box.querySelector<HTMLButtonElement>('.chat-status-seg.-live')?.click());
    expect(mixed.box.textContent).toContain('Running');
    expect(mixed.box.textContent).not.toContain('Subagent');
  });

  it('opens the child from its row — the one entry you can GO to', () => {
    const { box, onOpenChat } = mount([CHILD]);
    act(() => box.querySelector<HTMLButtonElement>('.chat-status-seg.-live')?.click());
    const link = box.querySelector<HTMLButtonElement>('.chat-roster-link');
    expect(link?.textContent).toBe('Work review');
    act(() => link?.click());
    expect(onOpenChat).toHaveBeenCalledWith({ workspaceSlug: 'personal', tabSlug: 'kid-slug' });
  });

  it('leaves a subagent row inert — there is nowhere to send you', () => {
    const { box } = mount([SUBAGENT]);
    act(() => box.querySelector<HTMLButtonElement>('.chat-status-seg.-live')?.click());
    expect(box.querySelector('.chat-roster-link')).toBeNull();
    expect(box.textContent).toContain('grep the logs');
  });
});
