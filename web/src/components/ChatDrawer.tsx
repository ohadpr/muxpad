import type { ChatAction } from '@muxpad/shared';
import { useMemo } from 'react';
import type { MentionChat } from '../lib/chat-mention';
import { spawnLabel, spawnState, spawnStateLabel } from '../lib/chat-mention';
import { shortAge } from '../lib/short-age';
import {
  type SubChat,
  artifactsOf,
  subChatGroups,
  subChatIsOpen,
  subChatsOf,
} from '../lib/sub-chats';
import { ChatChip } from './ChatChip';
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

  return (
    <aside className="chat-drawer" aria-label="This chat’s work">
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
        <section className="chat-drawer__block" key={g.key} data-block={g.key}>
          <h3 className="chat-drawer__group">
            {g.label}
            <span className="chat-drawer__group-count">{g.subs.length}</span>
          </h3>
          <ul className="chat-drawer__list">
            {g.subs.map((s) => {
              const state = spawnState(s.chat);
              const live = g.key === 'running';
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
                    title={s.paneId ? undefined : 'This chat’s pane is gone'}
                    onClick={() => onOpen(s)}
                  >
                    {/* ONLY WHERE IT MEANS SOMETHING. A finished worker's mark
                        was the same dot as the twenty above it; the block
                        heading says "finished" once instead. A row that failed
                        keeps its mark, because that one is not like the
                        others. */}
                    {live || state === 'failed' ? (
                      <ChatChip density="row" chat={s.chat.chip} />
                    ) : null}
                    <span className="chat-drawer__row-text">
                      <span className="chat-drawer__row-name" dir="auto">
                        {spawnLabel(s.chat)}
                      </span>
                      {g.showAge && s.chat.createdAt ? (
                        <span className="chat-drawer__row-sub">
                          {shortAge(now - s.chat.createdAt)}
                        </span>
                      ) : null}
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

function ArtifactList({ artifacts }: { artifacts: ReturnType<typeof artifactsOf> }) {
  if (artifacts.length === 0)
    return (
      <p className="chat-drawer__empty">
        Nothing published from this chat yet. Anything it puts on the internet with{' '}
        <code>muxpad publish</code> is listed here, with its link.
      </p>
    );
  return (
    <ul className="chat-drawer__list">
      {artifacts.map((a) => (
        <li key={a.id}>
          {/* A LINK, not a button that opens one: this is an address, and a
              person expects to be able to copy it, middle-click it and see
              where it goes before committing. */}
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
          </a>
        </li>
      ))}
    </ul>
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
