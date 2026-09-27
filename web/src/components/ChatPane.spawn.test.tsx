import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

/**
 * …AND THE CARDS MUST COUNT THE SAME CHILDREN THE ROSTER DOES.
 *
 * The roster above reads `liveSpawnedChildren`. The foot-of-log cards read
 * `spawnedChildren` — every child ever spawned — so the two surfaces answered
 * "what is this chat running" with different sets, and the cards' answer
 * included every agent that had already finished. A child is never deleted, so
 * those cards were permanent: six delivered agents parked between the last
 * message and the composer after a single afternoon, reported as "why do all
 * these older chats persist here".
 *
 * `spawnedChildren` has a CAP and no age. The neighbouring store had already
 * written down why that is not enough — "a single old card at the foot of a
 * conversation you have moved on from is clutter that never earns its place
 * back" (lib/chat-directed) — but under the cap nothing ever expired.
 *
 * ─── Why this is a SOURCE assertion and not a rendered one ────────────────
 * Stated plainly because the weaker kind of test is how this class of bug keeps
 * shipping here: `data-child` was emitted on no element for three reviews while
 * a grouping test and a stylesheet test both passed, each right about its own
 * half. The list-choice is one identifier deep inside a 6,200-line render that
 * needs a socket, a router, a corpus and a transcript to mount, and a mount that
 * elaborate is its own source of false greens. So this pins the SEAM instead:
 * both surfaces must name the same list. It would not catch a card list that
 * re-filtered wrongly downstream — `chat-mention.test.ts` owns what the list
 * itself contains, and that half is already covered.
 */
describe('the spawn cards and the roster read ONE list', () => {
  const SRC = readFileSync(join(process.cwd(), 'src/components/ChatPane.tsx'), 'utf8');

  it('never re-derives the card list from every child ever spawned', () => {
    // The whole bug in one symbol. `spawnedChildren` is still exported and still
    // tested — it is simply not what a conversation's live furniture is made of.
    expect(SRC).not.toContain('spawnedChildren(');
  });

  it('renders the cards from the same list the roster counts', () => {
    // One memo, both consumers. Two lists is what let them disagree.
    expect(SRC).toContain('liveSpawnedChildren(corpus, myChat?.tabId)');
    expect(SRC).toContain('{spawnedLive');
    expect(SRC).toContain('for (const kid of spawnedLive)');
    // …and exactly one definition of it, so a future edit cannot quietly fork
    // the card list off a second memo again.
    expect(SRC.split('const spawnedLive').length - 1).toBe(1);
  });
});
