import { type CardWithChat, cardIsStale } from '@muxpad/shared';
import { Link } from '@tanstack/react-router';
import { useCallback, useEffect, useState } from 'react';
import { CardBody, shortAge } from '../components/ChatCards';
import { useDocumentTitle } from '../use-document-title';
import './HostedView.css';
import './CardsView.css';

/**
 * CARDS — every pinned value on the install, on one page.
 *
 * A card is the CURRENT answer to something, pinned above one conversation:
 * the NAS backup state, the Claude quota, the market, whether a dev server is
 * up. That is the right home for reading one in context and the wrong one for
 * the question people actually arrive with, which is "what is true right now".
 * Measured when this was built: seven cards in seven different chats, a quota
 * card refreshing hourly and a backup card every fifteen minutes, and neither
 * visible unless you happened to open the chat that owned it. They were
 * updating into a drawer.
 *
 * ─── WHAT THIS PAGE IS FOR, WHICH IS NOT DISPLAY ────────────────────────────
 * Cards with a declared cadence (`--every`) know when they have gone quiet,
 * and that is the fact no single card can tell you. A card whose writer DIED
 * keeps showing its last value and looks completely normal — a dead watcher
 * and a watcher with nothing new to say are identical from inside the chat.
 * Across the whole set they are not: the overdue ones sort to the top, and
 * "which of my watchers stopped" is answered by looking rather than by opening
 * five chats. That is the reason this exists; the dashboard is the side
 * effect.
 *
 * ─── IT RENDERS WITH ChatCards' OWN BODY ────────────────────────────────────
 * `CardBody`, imported, not reimplemented. An html card runs in a sandboxed
 * frame that measures itself, and two copies of that would be two things to
 * keep agreeing about somebody else's markup. What this page adds around it is
 * only what the chat does not need: whose chat it is, and a way back.
 *
 * ─── THE ARCHIVE GROUP ──────────────────────────────────────────────────────
 * A card whose chat has left the live list is nearly always litter — two of
 * the seven here were last written in October — so it goes in its own quiet
 * group rather than among the values being watched, with the one control this
 * page has. Hiding them would be worse: the reason they accumulate is that
 * nobody can see them.
 */
export function CardsView() {
  useDocumentTitle('Cards · muxpad');
  const [cards, setCards] = useState<CardWithChat[]>([]);
  const [loaded, setLoaded] = useState(false);
  // Re-rendered on a timer only to age the tails and re-test overdue — the
  // same reason ChatCards keeps one, and the same 30s period.
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(() => {
    fetch('/api/cards')
      .then((r) => (r.ok ? r.json() : { cards: [] }))
      .then((b: { cards?: CardWithChat[] }) => setCards(b.cards ?? []))
      // A failed read leaves what is on screen. A page of values going blank
      // because one request dropped is a worse lie than a page a minute old.
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  useEffect(() => {
    load();
    // POLLED, not pushed. `cards.updated` is a per-tab event and this page is
    // not in a tab; subscribing to every chat's card traffic to redraw a list
    // of seven would be the spawn-rounds mistake in a smaller hat. 30s is
    // under the fastest cadence anything here declares (15m).
    const timer = window.setInterval(() => {
      setNow(Date.now());
      load();
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const live = cards.filter((c) => !c.chat.retired);
  const archived = cards.filter((c) => c.chat.retired);
  // OVERDUE FIRST, and only overdue: within each half the server's newest-first
  // order stands. A list that fully re-sorted itself every thirty seconds would
  // move the card you were reading, and the only re-ordering worth that is the
  // one that answers the question the page is for.
  const ordered = [
    ...live.filter((c) => cardIsStale(c, now)),
    ...live.filter((c) => !cardIsStale(c, now)),
  ];

  return (
    <div className="hosted cards-view">
      <div className="hosted-inner">
        <header className="hosted-head">
          <div>
            <h1 className="hosted-title">Cards</h1>
            <p className="hosted-sub">
              Every pinned value, from every chat. Anything overdue — a card whose writer has
              stopped — comes first.
            </p>
          </div>
        </header>

        {loaded && cards.length === 0 ? (
          <div className="mcl-empty">
            <p className="mcl-empty-title">No cards yet</p>
            <p className="mcl-empty-sub">
              Ask any chat to keep one: “put that on a card and refresh it hourly”.
            </p>
          </div>
        ) : null}

        {ordered.length > 0 ? (
          <div className="cards-grid">
            {ordered.map((card) => (
              <CardTile key={card.id} card={card} now={now} />
            ))}
          </div>
        ) : null}

        {archived.length > 0 ? (
          <section className="cards-archive">
            <h2 className="cards-archive-head">
              From chats you have finished with
              <span className="cards-archive-note">
                {' '}
                — the chat left the live list, so nothing is writing these any more.
              </span>
            </h2>
            <div className="cards-grid -archive">
              {archived.map((card) => (
                <CardTile key={card.id} card={card} now={now} onCleared={load} />
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}

/**
 * One card, with the two things the chat does not have to say: whose chat it
 * is, and how late it is.
 *
 * The chat's name is a LINK, and it is the only navigation on the tile. The
 * body is somebody else's markup in a frame, so making the whole tile a target
 * would mean a click inside an html card sometimes navigating away — the card
 * owns its own interior, including its links.
 */
function CardTile({
  card,
  now,
  onCleared,
}: {
  card: CardWithChat;
  now: number;
  /** Present only on the archive group, which is the only place with a
   *  control: a live card is cleared from its own chat, where whoever writes
   *  it can be told. */
  onCleared?: () => void;
}) {
  const stale = cardIsStale(card, now);
  const [clearing, setClearing] = useState(false);
  const chatName = card.chat.name || 'untitled chat';

  const clear = async () => {
    setClearing(true);
    try {
      await fetch(
        `/api/tabs/${encodeURIComponent(card.chat.tabId)}/cards/${encodeURIComponent(card.name)}`,
        { method: 'DELETE' },
      );
    } catch {
      // Swallowed on purpose: the refresh below is the answer either way, and
      // a rejected promise in a click handler is an unhandled one.
    }
    onCleared?.();
    setClearing(false);
  };

  return (
    <article className={`cards-tile${stale ? ' -stale' : ''}`}>
      <header className="cards-tile-head">
        <span className="cards-tile-name" title={`muxpad card set ${card.name}`}>
          {card.name}
        </span>
        <span className={`cards-tile-age${stale ? ' -stale' : ''}`}>
          {shortAge(now - card.updated_at)}
          {stale ? <span className="cards-tile-overdue"> overdue</span> : null}
        </span>
      </header>
      <div className="cards-tile-body">
        {/* `peek` false and a no-op for the fold: the chat folds a tall card
            because it is pinned above the thing you came to read. Here the
            card IS the thing you came to read. */}
        <CardBody card={card} peek={false} onFoldable={() => {}} />
      </div>
      <footer className="cards-tile-foot">
        <Link
          className="cards-tile-chat"
          to="/w/$wsSlug/t/$tabSlug"
          params={{ wsSlug: card.chat.workspaceSlug, tabSlug: card.chat.slug }}
        >
          {chatName}
          <span className="cards-tile-ws"> · {card.chat.workspaceName}</span>
        </Link>
        {onCleared ? (
          <button
            type="button"
            className="cards-tile-clear"
            onClick={clear}
            disabled={clearing}
            title={`Delete the ${card.name} card`}
          >
            {clearing ? 'clearing…' : 'clear'}
          </button>
        ) : null}
      </footer>
    </article>
  );
}
