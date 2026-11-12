import type { ChatAction } from '@muxpad/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import type { MentionChat } from '../lib/chat-mention';
import { spawnLabel, spawnState, spawnStateLabel } from '../lib/chat-mention';
import { isOutsideDismiss } from '../lib/dismiss-outside';
import { publishTerm } from '../lib/publish-term';
import { shortAge } from '../lib/short-age';
import {
  type SubChat,
  artifactsOf,
  subChatGroups,
  subChatIsOpen,
  subChatLiveWord,
  subChatsOf,
} from '../lib/sub-chats';
import { useArmed } from '../lib/use-armed';
import { ChatChip } from './ChatChip';
import { RosterSpinner } from './ChatTranscript';
import './ChatDrawer.css';

/**
 * WHAT THIS CONVERSATION SET IN MOTION — a panel on its right-hand side.
 *
 * ── WHY THE WORK MOVED OFF THE RAIL ──────────────────────────────────────
 * A sub-chat used to be a second-level row in the sidebar, under the chat that
 * spawned it. That put a conversation's internal bookkeeping in the app's
 * global navigation: the rail is a list of places you go, and a worker that
 * answered twenty minutes ago is not one — it is a detail OF a chat, and it
 * belongs beside that chat.
 *
 * So: a drawer, opened from the chat it belongs to, holding everything that
 * chat has going on beside itself. The rail goes back to being a list of
 * conversations.
 *
 * ── AN OVERLAY, NOT A COLUMN, AND THAT IS A CHOICE ───────────────────────
 * The obvious build is a flex sibling so the chat narrows and the drawer takes
 * the space. It is also the one that cannot be done without wrapping the
 * transcript in a new element when the drawer opens — which REMOUNTS it, and a
 * remounted transcript loses its scroll position and re-fetches its history.
 * Opening a drawer to glance at a worker must not throw away where you were
 * reading.
 *
 * An overlay anchored to the pane's right edge costs nothing structurally and
 * does the right thing at every width: wide, it covers a margin; narrow, it
 * covers the chat, which is what a phone wants anyway.
 *
 * ── AND IT HOLDS A WHOLE CHAT ────────────────────────────────────────────
 * Opening a row mounts the real chat for that sub-chat, rendered by whatever
 * the caller passes as `renderChat`. The drawer does not know what a chat is —
 * that inversion is what keeps it out of ChatPane's import cycle, and it is
 * also what lets a test drive the whole panel without a socket.
 */

export interface ChatDrawerProps {
  /** The chat this drawer belongs to. */
  tabId: string;
  /** Every chat muxpad knows about — the sidebar's own corpus. */
  corpus: readonly MentionChat[];
  /** This chat's acts on outside systems; the artifacts tab reads them. */
  actions: readonly ChatAction[];
  tab: 'subchats' | 'artifacts';
  onTab: (tab: 'subchats' | 'artifacts') => void;
  /** The sub-chat being shown inside the drawer, if any. */
  openPaneId: string | null;
  onOpenChat: (s: SubChat | null) => void;
  onClose: () => void;
  /** Mount a chat for `paneId`. Injected — see the note above. */
  renderChat: (chat: { paneId: string; tabId: string }) => React.ReactNode;
  /** Go to a sub-chat as a full page, for when the drawer is too small. */
  onNavigate?: ((chat: MentionChat) => void) | undefined;
}

export function ChatDrawer({
  tabId,
  corpus,
  actions,
  tab,
  onTab,
  openPaneId,
  onOpenChat,
  onClose,
  renderChat,
  onNavigate,
}: ChatDrawerProps) {
  const subs = useMemo(() => subChatsOf(corpus, tabId), [corpus, tabId]);
  const artifacts = useMemo(() => artifactsOf(actions), [actions]);
  const open = openPaneId ? subs.find((s) => s.paneId === openPaneId) : undefined;
  const running = subs.filter(subChatIsOpen).length;
  const panel = useRef<HTMLElement>(null);

  /**
   * CLICKING AWAY CLOSES IT.
   *
   * A panel that covers a third of the screen and can only be dismissed by
   * its own × is a panel people leave open. What counts as "away" is the
   * interesting part and lives in lib/dismiss-outside — the toggle, a modal
   * above the panel and a detached target all look outside and are not.
   *
   * `pointerdown`, not `click`: a click fires after the mouse comes back up,
   * so a drag that starts in the panel and ends outside it would close the
   * thing you were dragging from. CAPTURE, so a row that stops propagation
   * cannot leave the panel un-dismissable from its own neighbourhood.
   */
  useEffect(() => {
    const away = (e: PointerEvent) => {
      if (
        isOutsideDismiss({
          target: e.target,
          panel: panel.current,
          toggle: document.querySelector('.chat-drawer-open'),
        })
      )
        onClose();
    };
    document.addEventListener('pointerdown', away, true);
    return () => document.removeEventListener('pointerdown', away, true);
  }, [onClose]);

  return (
    <aside className="chat-drawer" ref={panel} aria-label="This chat’s work">
      <div className="chat-drawer__head">
        {/* ONE BACK AFFORDANCE, and it is not the close button. A drawer
            showing a sub-chat has two different exits — back to the list, and
            shut the whole thing — and collapsing them meant glancing at two
            workers took four clicks. */}
        {open ? (
          <button
            type="button"
            className="chat-drawer__back"
            onClick={() => onOpenChat(null)}
            aria-label="Back to the list"
          >
            ‹
          </button>
        ) : null}
        {open ? (
          <span className="chat-drawer__title" dir="auto">
            {spawnLabel(open.chat)}
          </span>
        ) : (
          <div className="chat-drawer__tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'subchats'}
              className="chat-drawer__tab"
              onClick={() => onTab('subchats')}
            >
              Sub-chats
              {/* The count is the RUNNING ones, not the total: the total is
                  how much history there is, and nobody is waiting on history. */}
              {running > 0 ? <span className="chat-drawer__count">{running}</span> : null}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'artifacts'}
              className="chat-drawer__tab"
              onClick={() => onTab('artifacts')}
            >
              Artifacts
              {artifacts.length > 0 ? (
                <span className="chat-drawer__count">{artifacts.length}</span>
              ) : null}
            </button>
          </div>
        )}
        {open && onNavigate ? (
          <button
            type="button"
            className="chat-drawer__expand"
            onClick={() => onNavigate(open.chat)}
            title="Open as a full chat"
            aria-label="Open as a full chat"
          >
            ⤢
          </button>
        ) : null}
        <button
          type="button"
          className="chat-drawer__close"
          onClick={onClose}
          aria-label="Close this panel"
        >
          ×
        </button>
      </div>

      <div className="chat-drawer__body">
        {open?.paneId ? (
          // The real chat, in the panel. `active` is the caller's business —
          // see ChatPane's own prop — and the caller is what mounts it.
          <div className="chat-drawer__chat">
            {renderChat({ paneId: open.paneId, tabId: open.chat.tabId })}
          </div>
        ) : tab === 'subchats' ? (
          <SubChatList subs={subs} onOpen={onOpenChat} />
        ) : (
          <ArtifactList artifacts={artifacts} />
        )}
      </div>
    </aside>
  );
}

/**
 * ── THE LIST IS ITS BLOCKS ────────────────────────────────────────────────
 *
 * Reported with a screenshot of twenty-one rows: "still ugly, no accent no
 * information architecture no nothing." The rows were fine; the LIST was a
 * wall. Twenty-one identical dots, and the same four characters of age down
 * the right edge, because every row was drawn as though it carried news when
 * twenty of them carried the same news.
 *
 * The blocks are the information now (see `subChatGroups`), and two things
 * follow from that:
 *
 *   · THE ACCENT GOES WHERE SOMETHING IS HAPPENING. Only the running block is
 *     marked, and only its rows keep the chip. A mark on every row cannot say
 *     "this one" when every row has one.
 *   · THE HEADING CARRIES THE TIME, so a finished row does not repeat "2d"
 *     eleven times. Only `Earlier` keeps a per-row age, because that is the
 *     block where it varies.
 */
function SubChatList({
  subs,
  onOpen,
  now = Date.now(),
}: {
  subs: SubChat[];
  onOpen: (s: SubChat) => void;
  now?: number;
}) {
  if (subs.length === 0)
    return (
      <p className="chat-drawer__empty">
        Nothing yet. Work this chat hands to another agent shows up here — while it runs, and after
        it reports.
      </p>
    );
  return (
    <>
      {subChatGroups(subs, now).map((g) => (
        <section className="chat-drawer__block" key={g.key} data-block={g.key} data-heat={g.heat}>
          <h3 className="chat-drawer__group">
            <span className="chat-drawer__group-label">{g.label}</span>
            {/* A PILL, not a bare number: "YESTERDAY 10" in a slab face reads
                as "|0". A count needs to look like a count. */}
            <span className="chat-drawer__group-count">{g.subs.length}</span>
            {/* The rule carries the block's tint across the panel, which is
                what gives the list its horizon lines. */}
            <span className="chat-drawer__group-rule" aria-hidden="true" />
          </h3>
          <ul className="chat-drawer__list">
            {g.subs.map((s) => {
              const state = spawnState(s.chat);
              const liveWord = subChatLiveWord(s);
              return (
                <li key={s.chat.tabId}>
                  <button
                    type="button"
                    className="chat-drawer__row"
                    data-state={state}
                    // A row whose pane is gone cannot be mounted. It stays in
                    // the list — it is part of the record — and says why
                    // rather than being a control that does nothing.
                    disabled={!s.paneId}
                    title={s.paneId ? undefined : 'This chat has ended — nothing is left to open'}
                    onClick={() => onOpen(s)}
                  >
                    {/* ── ONE MARK, NOT TWENTY-ONE ───────────────────────
                        A per-chat glyph was the wrong read of "a row should
                        look like a chat": twenty-one different icons is
                        another kind of noise, and none of them mean anything,
                        because a worker has no identity you would recognise
                        the way you recognise a conversation you named.

                        So every row wears the SAME mark — the branch the work
                        drawer's own control wears — and the accent does the
                        structural work instead: a tinted square at the head of
                        each row gives the column a rhythm, and the running
                        ones are tinted harder. Text alone is the blob; one
                        repeated shape in a colour is a list. */}
                    <span className="chat-drawer__mark" aria-hidden="true">
                      {/* biome-ignore lint/a11y/noSvgWithoutTitle: decorative — the wrapper is aria-hidden and the row's own name carries the meaning */}
                      <svg viewBox="0 0 16 16" width="11" height="11" fill="none">
                        <path
                          d="M4.5 3v4.2a2 2 0 0 0 2 2H11"
                          stroke="currentColor"
                          strokeWidth="1.6"
                          strokeLinecap="round"
                        />
                        <path
                          d="M9 7.2 11.4 9.2 9 11.2"
                          stroke="currentColor"
                          strokeWidth="1.6"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </span>
                    <span className="chat-drawer__row-text">
                      <span className="chat-drawer__row-name" dir="auto">
                        {spawnLabel(s.chat)}
                      </span>
                      {/* RUNNING SAYS SO IN WORDS at the end of its line. The tile is
                          identity now, so the one block whose state is news
                          carries it here — the only text on the panel wearing
                          the accent. */}
                      {/* EVERY ROW SAYS HOW LONG AGO. A running one says what it is
                          doing instead, which is the more useful fact and the
                          only one that changes while you look at it. */}
                      {/* THE WORD COMES FROM `spawnState`, not from "is it
                          retired". A worker that stopped to ask you something
                          does not retire, so `!done` read it as working and
                          this said so — while its own card in the log said
                          AWAITING. One worker, two surfaces, two different
                          claims about whether it needs you. */}
                      {/* ── EVERY ROW SAYS WHERE IT GOT TO ────────────────
                          It used to say so only while RUNNING, and a finished
                          worker was a name and an age — which is the one
                          question the panel exists to answer, left to be
                          inferred from which block the row fell into.

                          So the state is a word on every row, in the status
                          channel's own hue: green for a worker that delivered,
                          the blocked colour for one that stopped to ask you
                          something, the dead colour for a crash. The channel
                          and not the accent, because the accent changes with
                          the theme and "did this finish" must not.

                          The age stays for everything that is over — that is
                          when "how long ago" is the useful fact. A running row
                          spends the width on the spinner instead, because what
                          it is doing NOW is the thing that changes while you
                          look at it. */}
                      {state !== 'working' && s.chat.createdAt ? (
                        <span className="chat-drawer__row-sub">
                          {shortAge(now - s.chat.createdAt)}
                        </span>
                      ) : null}
                      <span className="chat-drawer__row-live" data-state={state}>
                        {state === 'working' ? (
                          <span className="chat-drawer__spin" aria-hidden="true">
                            <RosterSpinner />
                          </span>
                        ) : null}
                        {liveWord ?? spawnStateLabel(state)}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </>
  );
}

/**
 * ── A LINK YOU CAN SEE THE SHELF LIFE OF, AND ACT ON ─────────────────────
 *
 * `publish.create` is the most-used action muxpad has — 118 of 230 recorded
 * acts, more than every msgvault call combined. Until now this panel listed
 * the links and nothing else: no term, no warning, no way to keep one alive.
 * A link quietly 410s after seven days and the only place that fact existed
 * was `muxpad publish --list` in a terminal.
 *
 * So each row carries its own term and the two acts that matter. KEEP is
 * reversible and one click. TAKE DOWN arms first, because it is the only
 * thing here anybody else can notice — and it still destroys nothing: the
 * bytes stay and the link can be revived.
 */
function ArtifactList({ artifacts }: { artifacts: ReturnType<typeof artifactsOf> }) {
  const [live, setLive] = useState<Awaited<ReturnType<typeof api.listPublished>> | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(() => {
    api
      .listPublished()
      .then(setLive)
      // A listing that will not load must not take the links with it: the
      // rows below still render from the chat's own actions.
      .catch(() => setLive(null));
  }, []);
  useEffect(load, [load]);

  /** The published record for a row, matched on the slug inside its url. */
  const recordFor = (url: string) =>
    live?.items.find((i) => i.url === url || (i.slug && url.includes(`/${i.slug}/`)));

  const act = async (slug: string, run: () => Promise<unknown>) => {
    setBusy(slug);
    try {
      await run();
      load();
    } finally {
      setBusy(null);
    }
  };

  if (artifacts.length === 0)
    return (
      <p className="chat-drawer__empty">
        Nothing published from this chat yet. Anything it puts on the internet with{' '}
        <code>muxpad publish</code> is listed here, with its link.
      </p>
    );
  return (
    <ul className="chat-drawer__list">
      {artifacts.map((a) => {
        const rec = recordFor(a.url);
        const term = publishTerm(rec, Date.now());
        return (
          <li key={a.id}>
            <div className="chat-drawer__artifact">
              {/* A LINK, not a button that opens one: this is an address, and
                  a person expects to be able to copy it, middle-click it and
                  see where it goes before committing. */}
              <a
                className="chat-drawer__row chat-drawer__row--artifact"
                href={a.url}
                target="_blank"
                rel="noreferrer noopener"
              >
                <span className="chat-drawer__row-text">
                  <span className="chat-drawer__row-name" dir="auto">
                    {a.title}
                  </span>
                  <span className="chat-drawer__row-sub">{a.detail ?? a.url}</span>
                </span>
                {term ? (
                  <span className="chat-drawer__row-live" data-state={term.state}>
                    {term.label}
                  </span>
                ) : null}
              </a>
              {rec ? (
                <div className="chat-drawer__artifact-acts">
                  <button
                    type="button"
                    disabled={busy === rec.slug}
                    onClick={() => void act(rec.slug, () => api.extendPublish(rec.slug, 7))}
                    title="Another 7 days from now"
                  >
                    {term?.state === 'done' ? 'Revive' : 'Keep 7d'}
                  </button>
                  {term?.state === 'done' ? null : (
                    <ArmedTakeDown
                      busy={busy === rec.slug}
                      onConfirm={() => void act(rec.slug, () => api.expirePublish(rec.slug))}
                    />
                  )}
                </div>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** Take down arms first — the one act here anybody outside can notice. It
 *  still destroys nothing: the files stay and Revive brings the link back. */
function ArmedTakeDown({ busy, onConfirm }: { busy: boolean; onConfirm: () => void }) {
  const { armed, press, disarm } = useArmed();
  return (
    <button
      type="button"
      className={armed ? '-armed' : undefined}
      disabled={busy}
      onClick={() => {
        if (press()) onConfirm();
      }}
      onMouseLeave={disarm}
      onBlur={disarm}
      title={armed ? 'Click again — the link stops answering' : 'Stop serving this link'}
    >
      {armed ? 'Sure?' : 'Take down'}
    </button>
  );
}

/**
 * THE MARK FOR "THIS CHAT'S WORK".
 *
 * A panel sliding off the right edge: a rounded frame with its right-hand
 * third filled. Not a list, not a branch and not an avatar — the thing the
 * button does is open a side panel, and a glyph that says what will HAPPEN is
 * learnable in a way that a glyph about the contents is not (the contents are
 * two different things, and one of them is artifacts).
 */
export function SvgWorkDrawer({ size = 15 }: { size?: number } = {}) {
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: decorative — the button carries an aria-label
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <rect
        x="1.75"
        y="2.75"
        width="12.5"
        height="10.5"
        rx="2"
        stroke="currentColor"
        strokeWidth="1.3"
      />
      <path d="M9.75 3.4v9.2" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M9.75 2.75h2.5a2 2 0 0 1 2 2v6.5a2 2 0 0 1-2 2h-2.5z"
        fill="currentColor"
        opacity="0.38"
      />
    </svg>
  );
}
