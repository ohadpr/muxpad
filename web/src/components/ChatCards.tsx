import { type ChatCard, cardFreshness, cardIsStale } from '@muxpad/shared';
import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { subscribe, subscribeResync } from '../events';
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

/**
 * The bounded preview of a multi-line card.
 *
 * FADED ONLY WHEN SOMETHING IS ACTUALLY CUT. An unconditional fade dims the
 * last line of a card that fits perfectly, which reads as the card being
 * stale or broken rather than as "there is more" — the same reason the stack
 * above only fades when it is genuinely scrolled. So it measures itself, the
 * way the stack does.
 */
function CardPreview({ card }: { card: ChatCard }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [clipped, setClipped] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => setClipped(el.scrollHeight > el.clientHeight + 1);
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <span className={`chat-card-preview${clipped ? ' -clipped' : ''}`} ref={ref}>
      {card.format === 'markdown' ? <Markdown text={card.content} /> : card.content}
    </span>
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
        // THE NAME IS ONLY WORTH ITS WIDTH WHEN THERE IS SOMETHING TO TELL IT
        // APART FROM. With one card it is a label on the only thing in the
        // strip — and on a 430px phone those seven characters cost the tail of
        // the value, which is the part you actually came to read ("stocks
        // -0.4…", truncated mid-number). With several, it is the only thing
        // that says which row is which, so it comes back.
        //
        // The name is never LOST either way: opening a card shows it, and it is
        // the row's title.
        const showName = cards.length > 1 || open;
        // An html card is a sandboxed frame — there is no "one line" of it to
        // put in the row, so it always keeps a body underneath. Text and
        // markdown ride IN the row until somebody opens them.
        //
        // …BUT ONLY IF THERE IS ONE LINE OF THEM. A card with several lines put
        // into the row's leftover column gets every line cut at the same x a
        // few words in, because the column is what the name and the age did not
        // take: "split into free columns which severely limits how much content
        // can fit in each card". Those cards keep the header and put their
        // content underneath at full width instead.
        const multiline = card.format !== 'html' && card.content.trim().includes('\n');
        const inline = !open && card.format !== 'html' && !multiline;
        const preview = !open && multiline;
        const body = open || card.format === 'html';
        // ALWAYS, AND HARD RIGHT. This was suppressed until a card went overdue,
        // on the argument that the age is noise until it is news — the rail
        // carries freshness as colour, so the text was redundant. Asked for
        // back: "put the 'how long ago did this update' on the right edge of
        // the container." A colour ramp tells you something is getting old; it
        // does not tell you it is four hours old, and that is a number you read
        // off a market card.
        //
        // Pinned to the far edge rather than trailing the value: the gap
        // between them is slack the value gets to use, and the age never moves
        // as the content changes length.
        return (
          <section
            className={`chat-card${stale ? ' -stale' : ''}${open ? ' -open' : ''}`}
            key={card.id}
            // The rail IS the freshness readout now that the row carries no
            // timestamp — see cardFreshness. A number, not a class, so it is a
            // continuous fade rather than three buckets somebody has to name.
            style={{ '--card-fresh': cardFreshness(card, now) } as React.CSSProperties}
          >
            {/* THE WHOLE ROW IS THE CONTROL. This is a phone surface first, and
              the × it replaced was a 15px glyph with 5px of padding — under
              every touch-target guideline there is, and sitting right next to
              the thing it destroyed. A full-width row has nothing to mis-hit. */}
            <button
              type="button"
              className="chat-card-row"
              aria-expanded={open}
              onClick={() => {
                if (tabId) toggleCardOpen(tabId, card.name);
              }}
              title={open ? `Collapse ${card.name}` : `Expand ${card.name}`}
            >
              {showName ? <span className="chat-card-name">{card.name}</span> : null}
              {inline ? (
                // One line, ellipsized — never wrapped. A compact card that
                // silently becomes two rows on a narrow pane has given back
                // exactly the height this layout exists to save.
                <span className="chat-card-value">
                  {card.format === 'markdown' ? <Markdown text={card.content} /> : card.content}
                </span>
              ) : null}
              {/* The dotted run from the value to the age — see the css. It
                takes the row's slack, which is why the age needs no
                `margin-left: auto` any more, and its dots carry freshness and
                drift toward the age as they do it. */}
              {inline || preview ? (
                <span className="chat-card-leader" aria-hidden="true" />
              ) : null}
              <span className={`chat-card-age${stale ? ' -stale' : ''}`}>
                {ago(now - card.updated_at)}
                {stale ? ' · overdue' : ''}
              </span>
              {/* Its own line in the wrapped row, so the content is bounded by
                the CARD rather than by whatever the header left over. */}
              {preview ? <CardPreview card={card} /> : null}
            </button>
            {/* Unmounted, not hidden. An html card is a sandboxed iframe that
              re-measures itself and re-posts its height; left mounted behind
              `display:none` it would keep a frame alive and keep reporting a
              height for something nobody can see. */}
            {body ? (
              <div className={`chat-card-body${card.format === 'html' ? ' -flush' : ''}`}>
                <CardBody card={card} />
              </div>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}
