import { type ChatCard, cardIsStale } from '@muxpad/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { subscribe, subscribeResync } from '../events';
import './ChatCards.css';
import { Markdown } from './ChatMarkdown';

/**
 * THE PINNED CARDS of a chat — see shared/src/cards.ts for what a card is.
 *
 * Above the transcript and outside its scroller, because the whole point is a
 * value that does not scroll away: a build's progress or this morning's market
 * line is the thing you opened the chat to read, and in an append-only log it
 * is buried by the next thing said.
 */

/** Relative age, in the shortest form that is still true. */
function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 45) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 45) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/**
 * An html card, in a frame it cannot get out of.
 *
 * ─── WHY AN IFRAME AND NOT SANITISED MARKUP ────────────────────────────────
 * A card is written by an agent and pinned where it cannot be scrolled past, so
 * the two failure modes are "it breaks the app" and "it is boring". A sanitiser
 * answers the first by permanently limiting the second, and it is a standing
 * attack surface besides. A sandboxed frame answers the first completely —
 * no same-origin, so no reach into muxpad at all — and answers the second by
 * allowing anything inside.
 *
 * ─── THE PARENT CANNOT MEASURE IT ──────────────────────────────────────────
 * That isolation is not free, and this is the part that silently bites: with no
 * `allow-same-origin`, `contentDocument` is null, so the parent cannot read the
 * frame's height. Any parent-side auto-size does nothing at all and the card
 * renders at the iframe default of 150px with its content cut off — observed
 * while prototyping this. So the frame measures ITSELF and posts the number
 * out, and a ResizeObserver inside keeps doing it as fonts land and content
 * changes.
 *
 * ─── AND IT INHERITS NO THEME ──────────────────────────────────────────────
 * CSS variables do not cross the boundary either, so the document's resolved
 * palette is injected as a `:root` block. Without it every html card renders
 * black-on-white inside a dark app.
 */
const THEME_VARS = [
  '--bg',
  '--bg-elev',
  '--bg-hover',
  '--fg',
  '--fg-dim',
  '--fg-faint',
  '--border',
  '--border-strong',
  '--accent',
  '--accent-fg',
  '--danger',
] as const;

function themeBlock(): string {
  if (typeof window === 'undefined') return '';
  const cs = getComputedStyle(document.documentElement);
  const vars = THEME_VARS.map((v) => `${v}:${cs.getPropertyValue(v).trim() || 'inherit'}`).join(
    ';',
  );
  // `color-scheme` so form controls and scrollbars inside the card match, and a
  // sane default type stack so a card that styles nothing still looks native.
  return `:root{${vars};color-scheme:${cs.getPropertyValue('--card-scheme').trim() || 'light dark'}}
html,body{margin:0;background:transparent;color:var(--fg);
  font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}
/* The same inset the text and markdown cards have, so a card that styles
   nothing still sits properly in its frame instead of running edge to edge.
   A DEFAULT, not a rule: an author who wants the full bleed sets
   body padding to 0 and gets it. */
body{padding:10px 13px}
a{color:var(--accent)}`;
}

/**
 * BODY, never documentElement.
 *
 * `documentElement.scrollHeight` inside an iframe reports the VIEWPORT — the
 * height the parent just set — so a frame measuring it reports back exactly
 * what it was given and sticks there forever. Observed: every html card frozen
 * at the 120px initial guess with its content floating in empty space, which
 * reads as a styling bug and is not one. The body is the content.
 */
const SELF_MEASURE = `
<script>
  var send = function () {
    var b = document.body;
    var h = Math.max(b.scrollHeight, b.getBoundingClientRect().height);
    parent.postMessage({ muxpadCard: 1, h: Math.ceil(h) }, '*');
  };
  addEventListener('load', send);
  if (window.ResizeObserver) new ResizeObserver(send).observe(document.body);
  send();
</script>`;

function HtmlCard({ card }: { card: ChatCard }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [h, setH] = useState(120);
  // Rebuilt when the content or the THEME changes — a card keeps its injected
  // palette until it is re-rendered, so a theme switch has to produce new
  // srcdoc rather than hoping the frame notices.
  const theme = document.documentElement.dataset.theme ?? '';
  // biome-ignore lint/correctness/useExhaustiveDependencies: `theme` is deliberately a dependency it does not read — it is the SIGNAL that `themeBlock()` would now return different values, which is exactly when the srcdoc must be rebuilt. Dropping it leaves every html card wearing the previous theme until its content changes.
  const srcdoc = useMemo(
    () =>
      `<!doctype html><html><head><meta charset="utf-8"><style>${themeBlock()}</style></head><body>${card.content}${SELF_MEASURE}</body></html>`,
    [card.content, theme],
  );
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const d = e.data as { muxpadCard?: number; h?: number } | null;
      if (!d || d.muxpadCard !== 1 || typeof d.h !== 'number') return;
      if (ref.current && ref.current.contentWindow === e.source) {
        // Clamped: a card that reports a runaway height would push the whole
        // transcript off screen, and it is pinned — you could not scroll past it.
        setH(Math.min(Math.max(d.h, 24), 600));
      }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, []);
  return (
    <iframe
      ref={ref}
      className="chat-card-frame"
      title={card.name}
      // No `allow-same-origin`: the frame must not be able to reach muxpad.
      sandbox="allow-scripts"
      srcDoc={srcdoc}
      style={{ height: `${h}px` }}
    />
  );
}

function CardBody({ card }: { card: ChatCard }) {
  if (card.format === 'html') return <HtmlCard card={card} />;
  if (card.format === 'markdown')
    return (
      <div className="chat-card-md">
        <Markdown text={card.content} />
      </div>
    );
  return <div className="chat-card-text">{card.content}</div>;
}

export function ChatCards({ tabId }: { tabId: string | null | undefined }) {
  const [cards, setCards] = useState<ChatCard[]>([]);
  // Re-rendered on a timer ONLY to age the timestamps — a card that says "4s
  // ago" forever is worse than no timestamp, and staleness is the signal the
  // cadence exists for.
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(() => {
    if (!tabId) {
      setCards([]);
      return;
    }
    fetch(`/api/tabs/${encodeURIComponent(tabId)}/cards`)
      .then((r) => (r.ok ? r.json() : { cards: [] }))
      .then((b: { cards?: ChatCard[] }) => setCards(b.cards ?? []))
      // A failed read leaves whatever is on screen: a card going blank because
      // of one dropped request is a worse lie than a card a few seconds stale.
      .catch(() => {});
  }, [tabId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    // The event is thin (tab_id only) on purpose — re-fetch rather than trust a
    // payload, so the content cannot drift from the store. See its schema.
    const off = subscribe((e) => {
      if (e.type === 'cards.updated' && e.tab_id === tabId) load();
    });
    const offResync = subscribeResync(load);
    return () => {
      off();
      offResync();
    };
  }, [tabId, load]);

  useEffect(() => {
    if (cards.length === 0) return;
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [cards.length]);

  const dismiss = useCallback(
    (name: string) => {
      if (!tabId) return;
      // Optimistic: the card is gone from the stack immediately, and the event
      // that follows confirms it. A pinned block that lingers after you dismiss
      // it reads as a broken button.
      setCards((cs) => cs.filter((c) => c.name !== name));
      void fetch(`/api/tabs/${encodeURIComponent(tabId)}/cards/${encodeURIComponent(name)}`, {
        method: 'DELETE',
      }).then((r) => {
        if (!r.ok) load();
      });
    },
    [tabId, load],
  );

  if (cards.length === 0) return null;
  return (
    <div className="chat-cards">
      {cards.map((card) => {
        const stale = cardIsStale(card, now);
        return (
          <section className="chat-card" key={card.id}>
            <header className="chat-card-head">
              <span className="chat-card-name">{card.name}</span>
              <span className={`chat-card-age${stale ? ' -stale' : ''}`}>
                {ago(now - card.updated_at)}
                {stale ? ' · overdue' : ''}
              </span>
              <button
                type="button"
                className="chat-card-x"
                onClick={() => dismiss(card.name)}
                aria-label={`Dismiss ${card.name}`}
                title="Dismiss"
              >
                ×
              </button>
            </header>
            <div className={`chat-card-body${card.format === 'html' ? ' -flush' : ''}`}>
              <CardBody card={card} />
            </div>
          </section>
        );
      })}
    </div>
  );
}
