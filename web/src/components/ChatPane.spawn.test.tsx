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
 * …AND THE CARDS ARE TRANSCRIPT ENTRIES, NOT FURNITURE.
 *
 * Two bugs, one block. The cards were a fixed list at the FOOT of the log, above
 * the composer, and because a card there can never scroll away it had to keep
 * earning its place forever — so it was cut back to live children only, and then
 * said the same thing the status cell's "2 agents" already said, two inches
 * apart. Before that it rendered every child ever spawned (`spawnedChildren`)
 * while the roster counted `liveSpawnedChildren`: two lists, one question, six
 * delivered agents parked between the last message and the composer.
 *
 * Placing the card at the SPAWN — the child's own `created_at`, joined against
 * the transcript's times — settles both. It scrolls away like the message that
 * caused it, so nothing has to expire; and the finished ones can stay, because a
 * card in the log is the record that this chat started something and it landed.
 *
 * WHAT THIS FILE STILL HAS TO PIN, whatever the shape:
 *   1. the cards and the roster cannot disagree about what is RUNNING, and
 *   2. the foot-of-log block cannot come back.
 *
 * ─── Why these are SOURCE assertions and not rendered ones ────────────────
 * Stated plainly because the weaker kind of test is how this class of bug keeps
 * shipping here: `data-child` was emitted on no element for three reviews while
 * a grouping test and a stylesheet test both passed, each right about its own
 * half. Both facts above are wiring decisions inside a 6,200-line render that
 * needs a socket, a router, a corpus and a transcript to mount, and a mount that
 * elaborate is its own source of false greens. What the lists CONTAIN and where
 * a card LANDS are pure functions, and `chat-mention.test.ts` tests them against
 * real timestamps — that is the half a source assertion cannot cover.
 */
describe('the spawn cards and the roster read ONE list', () => {
  const SRC = readFileSync(join(process.cwd(), 'src/components/ChatPane.tsx'), 'utf8');
  /** The transcript builder — everything the log is assembled from. */
  const BODY = (() => {
    const start = SRC.indexOf('const body = useMemo');
    const end = SRC.indexOf('// The agent is working when', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    return SRC.slice(start, end);
  })();
  /** Everything AFTER it — the pane's own chrome, where the block used to be. */
  const AFTER_BODY = SRC.slice(SRC.indexOf('// The agent is working when'));

  it('never re-derives the card list from every child ever spawned', () => {
    // The old two-list bug in one symbol. `spawnedChildren` is still exported and
    // still tested — it is simply not what this component reaches for.
    expect(SRC).not.toContain('spawnedChildren(');
  });

  it('derives the roster from the CARDS, so they cannot disagree', () => {
    // Not two calls into the lib that happen to agree: one memo, and the running
    // list is that memo minus the done ones. `spawnCards` keeps every live child
    // past the cap (chat-mention.test.ts) so this stays a complete count.
    expect(SRC).toContain('spawnCards(corpus, myChat?.tabId)');
    expect(SRC).toContain('spawnedCards.filter((c) => !c.chat.done)');
    expect(SRC).toContain('for (const kid of spawnedLive)');
    // …and exactly one definition of each, so a future edit cannot quietly fork
    // a second card list off a second memo again.
    expect(SRC.split('const spawnedCards').length - 1).toBe(1);
    expect(SRC.split('const spawnedLive').length - 1).toBe(1);
  });

  it('builds the cards INSIDE the transcript, placed by time', () => {
    expect(BODY).toContain('interleaveSpawnCards(items, spawnedCards)');
    expect(BODY).toContain('<ChatMentionCard');
    // The indicator is read off the corpus at render time — not latched at spawn
    // — which is what keeps it honest after the card has scrolled up. It used to
    // be `working={!x.card.chat.done}` inline; the resolution moved to
    // `spawnState` in the lib (where `failed` is tested, and where the reason a
    // crashed worker must not read as working is written down), but the property
    // this pins is the same one: a fresh read of the corpus row, every render.
    expect(BODY).toContain('spawnState(kid)');
    expect(BODY).toContain("working={state === 'working'}");
  });

  it('NEVER PUTS THE HEADLINE UNDER THE NAME', () => {
    // The card read `biggest-files / largest source files in muxpad / delivered`
    // and the middle line is HeadlineWriter's label: it restates the PROMPT, it
    // is generated on a 6-minute interval so it turns up long after the work is
    // done, and it says nothing about what the worker FOUND. "that explanation
    // line took a ton of time to show and its like meaningless."
    //
    // The subtitle is now the generated report summary or NOTHING. A blank line
    // is better than a slow meaningless one.
    expect(BODY).not.toContain('kid.headline');
    // …and the summary that replaces it goes in the BODY, which wraps. `sub`
    // clips with an ellipsis — it turned the summary into "Ranked the repo by
    // line count: ws.ts (4,812) and C…".
    expect(BODY).toContain('body={report ? spawnReportSummary(report) : undefined}');
    expect(BODY).not.toMatch(/sub=\{[^}]*report/);
  });

  it('EXPANDS EVERY FINISHED CHILD — the toggle does not wait on the server', () => {
    // "there's no toggle to expand to see a longer summary or whatever like idk
    // what this agent did. i have to click it to go view its entire work."
    //
    // Gated on `finished`, NOT on the generated summary existing: the expansion
    // is the child's own final message, read from the transcript endpoint, so it
    // answers "what did this thing do" for every delivered worker already in the
    // log — with or without a server that has written a report yet.
    expect(BODY).toContain("const finished = state !== 'working'");
    expect(BODY).toContain('onToggleExpanded={finished ?');
    expect(BODY).toContain('<SpawnWorkBody');
    // …and the click-through survives alongside it.
    expect(BODY).toContain('onOpen={() => openChat(kid)}');
  });

  it('holds the reader’s row when a card changes height', () => {
    // A disclosure in the middle of a scrolling log is the ActionGroup fold's
    // problem exactly, and it has a solution already: measure the row BEFORE the
    // commit. The card has to carry the anchor for that to resolve — without
    // `anchorId` the hold is a silent no-op.
    expect(SRC).toMatch(
      /const toggleReport = useCallback\(\s*\n?\s*\([^)]*\) => \{\s*\n(\s*\/\/[^\n]*\n)*\s*onFoldToggled\(anchorId\);/,
    );
    expect(BODY).toContain('anchorId={anchorId}');
  });

  it('keeps the expansion EPHEMERAL — a disclosure is not a preference', () => {
    // Nothing persisted and nothing synced: opening a report on the phone must
    // not open it on the desktop. The two stores are keyed by CHILD TAB ID, the
    // only handle that cannot move when the log grows or the memo rebuilds.
    expect(SRC).toContain('useState<ReadonlySet<string>>(EMPTY_EXPANDED)');
    expect(SRC).not.toMatch(/expandedReports[\s\S]{0,400}localStorage/);
    expect(SRC).toContain('next.add(chat.tabId)');
  });

  it('cannot park the cards at the foot of the log again', () => {
    // The two ways the block was ever written: map the card list, or map the live
    // list. Neither is reachable from the pane's chrome, because the card list is
    // not named there at all.
    expect(AFTER_BODY).not.toContain('spawnedCards');
    expect(AFTER_BODY).not.toMatch(/\{spawnedLive/);
  });
});

/**
 * THE CORPUS IS ASKED FOR ON MOUNT.
 *
 * "They were not there, then I refreshed and they were." The corpus is lazy and
 * push-only (lib/all-tabs: nothing fetches it, `tab.updated` patches it only if
 * a copy is already held), and the cards are derived from it — so a pane that
 * never asked showed no cards at all until something ELSE in the app happened to
 * fetch one. Every card in a conversation depends on this one effect.
 *
 * The laziness is kept where it earns its keep: a workspace nobody has opened
 * still costs nothing, because the fix is a fetch on first USE, not a poll. It is
 * one shared single-flight cache, so this is one request per app, not per pane.
 */
describe('a conversation asks for the corpus when it opens', () => {
  const SRC = readFileSync(join(process.cwd(), 'src/components/ChatPane.tsx'), 'utf8');

  it('asks unconditionally — any chat may have children, and looking is the only way to know', () => {
    expect(SRC).toContain('const mayHaveSpawnedWork = true;');
    expect(SRC).toMatch(/const needsCorpus =\s*\n?\s*mayHaveSpawnedWork \|\|/);
  });

  it('and does it in an effect, which is what makes it happen on mount', () => {
    expect(SRC).toMatch(/useEffect\(\(\) => \{\s*\n\s*if \(needsCorpus\) ensureCorpus\(\);/);
  });
});
