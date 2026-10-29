import { type ChatCard, cardIsStale } from '@muxpad/shared';
import type React from 'react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { subscribe, subscribeResync } from '../events';
import { cardColorScheme } from '../lib/card-frame';
import { cardLineMarkdown, cardLineText } from '../lib/card-line';
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
  font:0.875rem/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}
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
    // AND THE HEIGHT OF THE FIRST ELEMENT, which is what the card collapses to.
    // An html card has no "first line" the parent can find — the markup is
    // opaque to it — so the frame, which can see its own layout, measures the
    // first child and reports it. An author who wants a card to fold puts the
    // summary row first; one who does not simply never gets peeked, because a
    // single-element card measures the same either way.
    var f = b.firstElementChild;
    var h1 = f ? Math.ceil(f.getBoundingClientRect().height) : 0;
    parent.postMessage({ muxpadCard: 1, h: Math.ceil(h), h1: h1 }, '*');
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

function HtmlCard({
  card,
  peek,
  onFoldable,
}: { card: ChatCard; peek: boolean; onFoldable: (v: boolean) => void }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const slot = useRef<HTMLDivElement>(null);
  const [h, setH] = useState(120);
  // the first element's height; 0 until the frame reports one
  const [h1, setH1] = useState(0);
  // Rebuilt when the content or the THEME changes — a card keeps its injected
  // palette until it is re-rendered, so a theme switch has to produce new
  // srcdoc rather than hoping the frame notices.
  const theme = document.documentElement.dataset.theme ?? '';
  // THE CARD'S OWN SURFACE, measured rather than recomputed. It is a
  // color-mix() of two theme tokens, which JS cannot evaluate — and the frame
  // has to be painted with it exactly, or the card has a differently-coloured
  // rectangle inside it. Layout effect so it is known before the first paint.
  //
  // ─── AND THE FRAME DOES NOT EXIST UNTIL IT IS KNOWN ─────────────────────
  // This used to render the iframe at once with a `transparent` placeholder
  // and swap in the measured colour from this effect — a second srcdoc, set in
  // the same task the frame was inserted. Chrome runs a sandboxed frame out of
  // process, and a srcdoc replaced before its first navigation commits loses
  // the race more often than not: the document that lands is never laid out
  // and never paints. Every height it posts is 0 (ignored, rightly), the
  // ResizeObserver never fires, and the card sits at the 120px guess with
  // nothing in it. Measured on the live app: 6 of 10 loads, at any width.
  // Safari keeps the frame in process and never hits it, which is why the
  // phone looked fine. So the frame is inserted ONCE, with its final srcdoc.
  const [paint, setPaint] = useState<{ theme: string; surface: string } | null>(null);
  useLayoutEffect(() => {
    const el = slot.current?.closest('.chat-card');
    setPaint({ theme, surface: el ? getComputedStyle(el).backgroundColor : 'transparent' });
  }, [theme]);
  // `paint.theme` is never read here, and it does not have to be: a new
  // `paint` object IS the signal that themeBlock() would now return different
  // values, which is exactly when the srcdoc must be rebuilt.
  const srcdoc = useMemo(
    () =>
      paint
        ? `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>${themeBlock(
            paint.surface,
          )}</style></head><body>${card.content}${SELF_MEASURE}</body></html>`
        : null,
    [card.content, paint],
  );
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const d = e.data as { muxpadCard?: number; h?: number; h1?: number } | null;
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
        const full = Math.min(Math.max(d.h, 24), 600);
        setH(full);
        if (typeof d.h1 === 'number' && d.h1 > 0) {
          const first = Math.min(d.h1, 600);
          setH1(first);
          // ── FOLDABLE ONLY IF FOLDING DOES SOMETHING ────────────────────
          // `togglable = !isHtml` existed to kill one specific complaint:
          // "clicking the line changes it a bit but doesn't expand". A card
          // that is a single element has firstElementChild === the whole body,
          // so its peek height IS its full height — make that clickable and
          // the gesture is back to changing nothing. The parent cannot know
          // which kind it has until the frame measures, so the frame says.
          // 24px of slack: a trailing margin is not a second row.
          onFoldable(first < full - 24);
        }
      }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, []);
  return (
    <div ref={slot}>
      {srcdoc === null ? null : (
        <iframe
          ref={ref}
          className="chat-card-frame"
          title={card.name}
          // ── A LINK IN A CARD LEAVES THE CARD ────────────────────────────
          // Reported: a link in a pinned card opened INSIDE it, replacing the
          // card with the page. There is no back button in a 90px frame, and
          // nothing else in muxpad behaves that way — every other surface
          // (chat markdown, file chips, artifact links, the brand mark) is
          // already `target="_blank"`. This frame was the one exception, and
          // only because it is sandboxed: a sandboxed frame CAN navigate
          // itself, and `<base>` plus popup permission is what redirects that
          // to a new tab.
          //
          // `allow-popups-to-escape-sandbox` is the half people forget: without
          // it the opened tab inherits the sandbox and lands as a scriptless,
          // origin-less page — a broken version of the site, which reads as the
          // link being broken.
          //
          // NO `allow-same-origin`, unchanged: the frame still cannot reach
          // muxpad. What it gains is the ability to open a tab, which the chat
          // text beside it could already do — a card is written by the agents
          // you already run.
          sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
          srcDoc={srcdoc}
          // Collapsed, the frame is cut to its first element — the card's own
          // summary row. The document inside is unchanged and still fully laid
          // out, so expanding is instant and costs no re-measure.
          style={{ height: `${peek && h1 > 0 ? h1 : h}px` }}
        />
      )}
    </div>
  );
}

function CardBody({
  card,
  peek,
  onFoldable,
}: { card: ChatCard; peek: boolean; onFoldable: (v: boolean) => void }) {
  if (card.format === 'html') return <HtmlCard card={card} peek={peek} onFoldable={onFoldable} />;
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
  // Which html cards have a first row worth folding to, by card id. Only the
  // frame can know — it is the only thing that can see the document's layout —
  // so this fills in from the frame's first measurement, and until it does an
  // html card behaves exactly as it always did: whole, and not a control.
  const [foldable, setFoldable] = useState<Record<string, boolean>>({});
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
        // ── AN HTML CARD FOLDS TOO, TO ITS FIRST ELEMENT ──────────────────
        // This used to read `togglable = !isHtml`, on the reasoning that "an
        // html card has nothing to expand — it renders whole and measures
        // itself". That was true while every html card was one indivisible
        // block. It stopped being true the moment a card had a summary row and
        // a detail table under it: there IS something to fold to, the parent
        // just could not see it, because the markup is opaque from out here.
        // So the FRAME measures its own first child and reports that height,
        // and collapsing means rendering at it. No new API, no second copy of
        // the content to keep in sync, and a card that is a single element is
        // unaffected — it measures the same either way.
        // An html card is a control only once its frame has reported that it
        // has a foldable first row; everything else always was one.
        const togglable = !isHtml || foldable[card.id] === true;
        const showBody = open || isHtml;
        const peek = isHtml && !open && foldable[card.id] === true;
        return (
          <section
            // `-line` marks the COLLAPSED one-liner, which lays out differently
            // from a body: see "COLLAPSED, THE TAIL IS A COLUMN" in the CSS. It
            // is not the negation of `-open` — an html card has no `-open` and
            // still renders a body — so it is derived from `showBody`, the same
            // value that decides which of the two is actually drawn.
            className={`chat-card${stale ? ' -stale' : ''}${open ? ' -open' : ''}${
              togglable ? ' -togglable' : ''
            }${showBody ? '' : ' -line'}${peek ? ' -peek' : ''}`}
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
                <CardBody
                  card={card}
                  peek={peek}
                  onFoldable={(v) =>
                    setFoldable((m) => (m[card.id] === v ? m : { ...m, [card.id]: v }))
                  }
                />
              </div>
            ) : (
              // Preview the first content line; the expanded body keeps the
              // original source, including all details and block formatting.
              <div className="chat-card-line">
                {card.format === 'markdown' ? (
                  <Markdown text={cardLineMarkdown(card.content)} />
                ) : (
                  cardLineText(card.content)
                )}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
