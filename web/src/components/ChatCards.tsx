import { type ChatCard, cardIsStale } from '@muxpad/shared';
import type React from 'react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { subscribe, subscribeResync } from '../events';
import { cardColorScheme } from '../lib/card-frame';
import { isCardOpen, toggleCardOpen, useCardOpen } from '../lib/card-open';
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

/**
 * Relative age, in the shortest form that is still true — and SHORT, because
 * this is a tail in the corner of a card rather than a column of its own.
 * "4s", not "4 seconds ago": the only question it answers is how stale the
 * value above it is, and two characters answer it.
 */
function shortAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 45) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 45) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h}h`;
  return `${Math.round(h / 24)}d`;
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

function themeBlock(surface: string): string {
  if (typeof window === 'undefined') return '';
  const cs = getComputedStyle(document.documentElement);
  const vars = THEME_VARS.map((v) => `${v}:${cs.getPropertyValue(v).trim() || 'inherit'}`).join(
    ';',
  );
  // ─── PAINTED, NOT TRANSPARENT ───────────────────────────────────────────
  // This used to set `background:transparent` so the card's surface would show
  // through, and read `color-scheme` from a `--card-scheme` variable NO THEME
  // HAS EVER DEFINED. Per CSS a transparent root hands the canvas to the UA
  // default, and that default follows color-scheme — so it fell back to
  // `light dark`, the UA took the BROWSER's preference, and a laptop set to
  // dark rendered every html card as a black slab inside a light app.
  // Measured on the running app, in alucard.
  //
  // Transparent cannot be made to work, so the frame is painted with the
  // card's own measured background: the exact resolved colour, read off the
  // card element. That is the only form that stays right through a theme
  // switch and through color-mix() values JS cannot recompute.
  //
  // The scheme follows that colour rather than the browser, so form controls
  // and scrollbars inside a card match the card they are in.
  return `:root{${vars};color-scheme:${cardColorScheme(surface)}}
html,body{margin:0;background:${surface};color:var(--fg);
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
  // SAYING IT AGAIN, UNPROMPTED. The first two measurements are always 0 — at
  // parse time and at load the body has not been laid out — and the only
  // message that carries the real height comes from the ResizeObserver, which
  // fires ONCE. Lose that one (the parent swaps srcdoc for a theme change, say,
  // so it arrives from a window the parent no longer recognises) and nothing
  // ever measures again, because the body's size never changes after that.
  // Measured: a card with a 90px block stuck at the 24px floor, for good.
  requestAnimationFrame(send);
  setTimeout(send, 120);
  setTimeout(send, 500);
</script>`;

function HtmlCard({ card }: { card: ChatCard }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [h, setH] = useState(120);
  // Rebuilt when the content or the THEME changes — a card keeps its injected
  // palette until it is re-rendered, so a theme switch has to produce new
  // srcdoc rather than hoping the frame notices.
  const theme = document.documentElement.dataset.theme ?? '';
  // THE CARD'S OWN SURFACE, measured rather than recomputed. It is a
  // color-mix() of two theme tokens, which JS cannot evaluate — and the frame
  // has to be painted with it exactly, or the card has a differently-coloured
  // rectangle inside it. Layout effect so it is known before the first paint.
  const [surface, setSurface] = useState('transparent');
  // biome-ignore lint/correctness/useExhaustiveDependencies: `theme` is a SIGNAL here, not an input — the card's background is a color-mix of theme tokens, so the measurement has to be retaken when the theme changes even though this body never reads it.
  useLayoutEffect(() => {
    const card = ref.current?.closest('.chat-card');
    if (card) setSurface(getComputedStyle(card).backgroundColor);
  }, [theme]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `theme` is deliberately a dependency it does not read — it is the SIGNAL that `themeBlock()` would now return different values, which is exactly when the srcdoc must be rebuilt. Dropping it leaves every html card wearing the previous theme until its content changes.
  const srcdoc = useMemo(
    () =>
      `<!doctype html><html><head><meta charset="utf-8"><style>${themeBlock(surface)}</style></head><body>${card.content}${SELF_MEASURE}</body></html>`,
    [card.content, theme, surface],
  );
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const d = e.data as { muxpadCard?: number; h?: number } | null;
      if (!d || d.muxpadCard !== 1 || typeof d.h !== 'number') return;
      if (ref.current && ref.current.contentWindow === e.source) {
        // A ZERO IS NOT A HEIGHT, it is "ask me later" — the body has not been
        // laid out yet. Clamping it UP to the floor is what made that
        // indistinguishable from a genuinely tiny card, and left a frame
        // parked at 24px with 90px of content in it.
        if (d.h <= 0) return;
        // Clamped at the top: a card that reports a runaway height would push
        // the whole transcript off screen, and it is pinned — you could not
        // scroll past it.
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
  const opened = useCardOpen();

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

  // ── WHICH END GETS CUT WHEN THERE ARE TOO MANY ────────────────────────────
  // The stack is bounded, so past a few cards something has to go off screen.
  // Glued to the bottom, the end that must stay is the BOTTOM one: it is
  // against the composer, it is where the eye already is, and it is where the
  // cron-driven card sits. Left alone, a scroller shows its TOP and clips the
  // last card mid-line, which reads as a broken card rather than a full stack.
  const stackRef = useRef<HTMLDivElement>(null);
  const [over, setOver] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `cards` and `opened` are deliberately dependencies the body does not read. The stack renders nothing when there are none, so on the first pass the ref is null and this bails — with no dependency it would never run again, for the whole session, and the overflow fade and bottom-pin would silently never work. It also has to re-observe when the card NODES are replaced.
  useEffect(() => {
    const el = stackRef.current;
    if (!el) return;
    const fit = () => {
      const o = el.scrollHeight > el.clientHeight + 1;
      setOver(o);
      // Pin to the bottom. Not a one-off: a card growing taller (an html card
      // re-measuring itself) changes scrollHeight after this runs.
      if (o) el.scrollTop = el.scrollHeight;
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    for (const child of el.children) ro.observe(child);
    return () => ro.disconnect();
  }, [cards, opened]);

  if (cards.length === 0) return null;
  return (
    <div className={`chat-cards${over ? ' -over' : ''}`} ref={stackRef}>
      {cards.map((card) => {
        const stale = cardIsStale(card, now);
        const open = isCardOpen(opened, tabId, card.name);
        // ── ONE SHAPE, WHATEVER IS IN IT ────────────────────────────────
        // The card used to be assembled three different ways and it showed.
        // The NAME appeared when there were two cards or when one was open, so
        // it moved between being inline, being a header, and being absent. An
        // html card kept a body at all times, so clicking its row toggled a
        // state that changed nothing visible — "clicking the line changes it a
        // bit but doesn't expand". And the header took a whole line from the
        // value on anything taller than one line.
        //
        // So: the name is not drawn at all (it is the identity for `card set`,
        // and it is on the title attribute), the age is a tail in the corner,
        // and the card is one block of content. Nothing moves between layouts.
        const isHtml = card.format === 'html';
        // AN HTML CARD HAS NOTHING TO EXPAND. It renders whole and measures
        // itself, so making it a control was offering a gesture that could not
        // do anything. It is a plain section; everything else toggles.
        const togglable = !isHtml;
        const showBody = open || isHtml;
        return (
          <section
            className={`chat-card${stale ? ' -stale' : ''}${open ? ' -open' : ''}${
              togglable ? ' -togglable' : ''
            }`}
            key={card.id}
            title={card.name}
            {...(togglable
              ? {
                  // ROLE, NOT <button>. A real button may only contain phrasing
                  // content and a markdown card emits <p> — which is why the
                  // control used to be a row BESIDE the body rather than around
                  // it, and why the two could disagree about what a click does.
                  // The whole card is one target now, as BrowserCard does it.
                  role: 'button',
                  tabIndex: 0,
                  'aria-expanded': open,
                  onClick: () => {
                    // A click that ENDS a text selection is not a click on the
                    // card: collapsing the thing somebody was reading, as they
                    // finish dragging across it, is worse than not toggling.
                    if (window.getSelection()?.toString()) return;
                    if (tabId) toggleCardOpen(tabId, card.name);
                  },
                  onKeyDown: (e: React.KeyboardEvent) => {
                    if (e.key !== 'Enter' && e.key !== ' ') return;
                    e.preventDefault();
                    if (tabId) toggleCardOpen(tabId, card.name);
                  },
                }
              : {})}
          >
            {/* THE TAIL. Pinned to the top-right corner rather than given a
              column, because a card is its value and the clock is a footnote on
              it: "I don't want the title and last updated to consume an entire
              line". Short form — 4s, 2m, 3h, 1d — for the same reason. */}
            <span className={`chat-card-age${stale ? ' -stale' : ''}`}>
              {shortAge(now - card.updated_at)}
              {stale ? <span className="chat-card-sr">, overdue</span> : null}
            </span>
            {showBody ? (
              // Unmounted, not hidden. An html card is a sandboxed iframe that
              // re-measures itself and re-posts its height; left mounted behind
              // `display:none` it would keep a frame alive and keep reporting a
              // height for something nobody can see.
              <div className={`chat-card-body${isHtml ? ' -flush' : ''}`}>
                <CardBody card={card} />
              </div>
            ) : (
              // ONE LINE, and the same one line whatever the content is: a
              // markdown card's blocks are flattened to it (see the css) rather
              // than being given a layout of their own.
              <div className="chat-card-line">
                {card.format === 'markdown' ? <Markdown text={card.content} /> : card.content}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
