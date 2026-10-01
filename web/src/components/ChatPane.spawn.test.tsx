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
          liveLabel={liveStatusLabel({ chats: agents.length })}
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
  /**
   * The same slice with runs of whitespace collapsed.
   *
   * For assertions about a JSX PROP, where the formatter owns the line breaks:
   * an unrelated comment elsewhere in the file pushed one prop past the width
   * limit, biome wrapped it over three lines, and a test about expander
   * behaviour failed for a reason that had nothing to do with expanders. Use
   * this where the shape could legally be reflowed; use BODY where the exact
   * text is the point.
   */
  const BODY_FLAT = BODY.replace(/\s+/g, ' ');
  /** Everything AFTER it — the pane's own chrome, where the block used to be. */
  const AFTER_BODY = SRC.slice(SRC.indexOf('// The agent is working when'));

  it('never re-derives the card list from every child ever spawned', () => {
    // The old two-list bug in one symbol. `spawnedChildren` is still exported and
    // still tested — it is simply not what this component reaches for.
    expect(SRC).not.toContain('spawnedChildren(');
  });

  it('derives the roster from the CARDS, so they cannot disagree', () => {
    // Not two calls into the lib that happen to agree: one memo, and the running
    // list is that memo filtered to the ones actually at work. `spawnCards`
    // keeps every live child past the cap (chat-mention.test.ts) so this stays a
    // complete count.
    //
    // The filter USED to be `!c.chat.done`, and this test pinned that string.
    // It was wrong: `done` is retirement, not liveness, so the bar counted a
    // worker between turns and one whose runner had DIED — "4 agents" over one
    // working child. `runningChildren` reads the pane status the sidebar spins
    // on. See ChatPane.liveset.test.tsx, which holds all three surfaces to one
    // answer; what THIS test still owns is that there is exactly one list.
    expect(SRC).toContain('spawnCards(corpus, myChat?.tabId');
    // Still derived from the cards, and still `runningChildren` — but DEDUPED
    // by child first, because a worker now appears once per ROUND and the bar
    // counts chats, not cards.
    expect(SRC).toContain('runningChildren([...new Map(spawnedCards.map((c) => [c.chat.tabId');
    expect(SRC).toContain('for (const kid of spawnedLive)');
    // …and exactly one definition of each, so a future edit cannot quietly fork
    // a second card list off a second memo again.
    expect(SRC.split('const spawnedCards').length - 1).toBe(1);
    expect(SRC.split('const spawnedLive').length - 1).toBe(1);
  });

  it('builds the cards INSIDE the transcript, placed by time', () => {
    // The entries handed to the interleave are `items`, possibly wrapped —
    // browser moments are injected as ordinary timed entries first, so they
    // land in the log by time without this interleave knowing they exist. What
    // this pins is that the cards are built from THE TRANSCRIPT's entries and
    // the one spawned-card list, not from some second source.
    expect(BODY).toMatch(
      /interleaveSpawnCards\(\s*(?:\/\/[^\n]*\n\s*)*(?:injectBrowserMoments\()?items[,)]/,
    );
    expect(BODY).toContain('spawnedCards,');
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

  it('draws a LAUNCH entry and a COMPLETION entry, not one card that mutates', () => {
    // "the original card should be an indication of launching/progress and when
    // the sub-chat is done we should add another card marking its completion
    // with the summary etc, and that card should be added at the bottom of the
    // chat so the user will see it."
    // TWO renders, and two separate anchors — which is also what lets the scroll
    // memory address them independently and expanding one hold the right row.
    expect(BODY).toContain("if (x.card.kind === 'launch')");
    expect(BODY.split('<ChatMentionCard').length - 1).toBe(2);
    // Each takes its anchor FROM THE CARD. It used to be rebuilt here as
    // `spawn-${kid.tabId}` / `done-${kid.tabId}`, which named one row per child
    // — correct until `spawn_rounds` made a worker draw a pair per ROUND, at
    // which point twenty-seven rows in one log shared an id and the reader was
    // thrown 3,200px whenever they scrolled onto a later one. See
    // `lib/spawn-card-scroll.test.ts`.
    expect(BODY.match(/const anchorId = x\.card\.anchorId;/g)).toHaveLength(2);
  });

  it('gives the LAUNCH entry no summary, no expand, and no mark once it is over', () => {
    // At a launch there is nothing to summarise. And once the work is finished
    // its outcome lives on the completion card at the bottom — repeating it here
    // would be the same fact in two places, with the copy nobody can see being
    // the one that claims to be current.
    const launch = BODY.slice(
      BODY.indexOf("if (x.card.kind === 'launch')"),
      BODY.indexOf('// THE COMPLETION'),
    );
    expect(launch).toContain("working={state === 'working'}");
    expect(launch).not.toContain('onToggleExpanded');
    expect(launch).not.toContain('spawnReportSummary');
    expect(launch).not.toContain('tone=');
    expect(launch).not.toContain('state=');
  });

  it('gives the launch card a LABEL, a HANDLE and a SUB-CHAT MARK', () => {
    // The cards read `status-line` and `cross-ws` — a dot, a slug and a spinner,
    // and nothing else. "Sub chats need a more purposeful card, something more
    // informative."
    expect(BODY).toContain('mark="spawn"');
    expect(BODY).toContain('name: spawnLabel(kid)');
    expect(BODY).toContain('sub={spawnHandle(kid)}');
  });

  it('NEVER PUTS THE HEADLINE UNDER THE NAME', () => {
    // The card read `biggest-files / largest source files in muxpad / delivered`
    // and the middle line is HeadlineWriter's label: it restates the PROMPT, it
    // is generated on a 6-minute interval so it turns up long after the work is
    // done, and it says nothing about what the worker FOUND. "that explanation
    // line took a ton of time to show and its like meaningless."
    expect(BODY).not.toContain('kid.headline');
    // …and the summary that replaces it goes in the BODY, which wraps. `sub`
    // clips with an ellipsis — it turned the summary into "Ranked the repo by
    // line count: ws.ts (4,812) and C…".
    // …and a completion ALWAYS carries a line. A bare tick over a missing
    // summary claims "there was nothing to it", which nobody has a basis for.
    expect(BODY).toContain('body={spawnCardSummary(report)}');
    expect(BODY).not.toMatch(/sub=\{[^}]*report/);
  });

  it('RENDERS THE GENERATED SUMMARY, and never transcript text in its place', () => {
    // The defect this replaces: the collapsed card showed nothing and the
    // expander dumped the child's narration — "I'll start by reading the
    // constraints doc", "Now the core of item 1 —". The summary the server had
    // generated (`spawn_report`, 356 characters of it for `dead-css`) was on the
    // wire the whole time; the card has to be the thing that reads it.
    expect(BODY).toContain('body={spawnCardSummary(report)}');
    // And the transcript is NOT a substitute for it: the fetched work is only
    // ever reached for behind a report that earned the expander.
    expect(BODY).toContain('const canExpand = canExpandSpawn(kid)');
    expect(BODY).toContain('work={expanded ? <SpawnWorkBody');
    expect(BODY).toContain('expanded={expanded}');
  });

  it('SHOWS WHERE THE WORK IS, and says something even with no summary', () => {
    // The `cross-ws` case: a published page, a 13 KB report, a refused summary,
    // and a card that was a green tick and nothing else. The artifacts do not
    // ride the summary — that is why they survive it — and the summary line
    // falls back to a sentence rather than to a blank.
    expect(BODY).toContain('artifacts={kid.artifacts}');
    expect(BODY).toContain('body={spawnCardSummary(report)}');
  });

  it('offers NO expander when there is nothing behind it', () => {
    // Three report states in the wild — `ok`, `none`, and unset — and two of
    // them have nothing to show. An expander over those fell through to the
    // transcript, which is how the narration got on screen.
    expect(BODY_FLAT).toContain('onToggleExpanded={ canExpand ?');
    // …and the click-through survives either way.
    expect(BODY).toContain('onOpen={() => openChat(kid)}');
  });

  it('DRAWS FROM ROUNDS when the conversation has them', () => {
    // A worker is handed successive jobs; both cards were anchored to tab
    // timestamps, which happen once. Five handovers left one pair of cards.
    expect(SRC).toContain('spawnCards(corpus, myChat?.tabId, MAX_SPAWN_CARDS, spawnRounds)');
    // …fetched once per conversation, not once per card.
    expect(SRC).toContain('loadSpawnRounds(');
  });

  it("uses each ROUND's own result, never the tab's newest one", () => {
    // The tab carries ONE report — the newest. Reading it for every completion
    // card would make an old card restate the latest result, which is exactly
    // what "do not double-report" forbids.
    expect(BODY).toContain('x.card.report ?? kid.report');
  });

  it('keeps the expansion EPHEMERAL — a disclosure is not a preference', () => {
    // Nothing persisted and nothing synced: opening a report on the phone must
    // not open it on the desktop.
    expect(SRC).toContain('useState<ReadonlySet<string>>(EMPTY_EXPANDED)');
    expect(SRC).not.toMatch(/expandedReports[\s\S]{0,400}localStorage/);
    // Keyed by the CARD, not the child. Child tab id was the only handle that
    // could not move while a worker had one completion entry; since
    // `spawn_rounds` it has one per round, and a set keyed by the tab opened
    // every one of them from a single tap — twenty-seven boxes on the measured
    // child, most of them above the reader. The work cache is also per card:
    // each round in that transcript has a different final answer.
    expect(SRC).toContain('next.add(anchorId)');
    expect(SRC).toContain('reportWork.get(anchorId)');
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
