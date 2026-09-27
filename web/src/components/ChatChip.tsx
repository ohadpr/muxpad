import { CHAT_DECAY_DAYS, type ChatClock } from '@muxpad/shared';
import type React from 'react';
import './ChatChip.css';

/**
 * THE CHIP — the one visual primitive for "how much life is left in this chat".
 *
 * A chat has a CLOCK: {@link DECAY_DAYS} days, reset by any message the user
 * sends it. When the clock runs out the chat is `done` — it leaves the live
 * list and collapses into the sidebar's done group. Nothing is ever deleted,
 * and a message revives it. Pinning stops the clock entirely.
 *
 * This component draws that clock, and ONLY that clock. It is a mark, not a
 * row and not a card: the sidebar row, the conversation card and the inline
 * mention pill are three different containers that all put THIS in their
 * leading slot. Whoever renders a container owns the container; the material
 * inside it is decided here, once, so the three surfaces cannot drift.
 *
 * ─── The material: NO CONTAINER FOR FOUR DAYS ────────────────────────────
 *
 *   fresh      the emoji at 20px on the row's OWN surface, full colour,
 *              nothing around it
 *   −1 day     the same glyph at --fade-1, 50% of the colour drained
 *   −2 days    at --fade-2, 85% drained
 *   last day   the outline arrives, ONCE: a dotted 24px box, the glyph
 *              stepping to 18px so it lands inside it, ghosted (grayscale,
 *              0.34 opacity)
 *   done       drawn exactly as `last day`. The mark has nothing left to say
 *              about time, and the row's PLACE (inside the done group) is what
 *              says it is over. Two phases, one drawing, on purpose.
 *   pinned     the fresh mark, forever. The clock is stopped.
 *   child      a 6px dot of --clock, becoming a hollow RING once it delivers
 *
 * Three of every four rows therefore have no frame at all, and the glyph is
 * 20px on the row's own ground — 2× the area of the 14px it had inside the
 * tile, off the white plate that was working against it. The shipped tile was
 * 24×24 around that 14px glyph (2.9× its area) and neither half of it was loud
 * alone: the fill measured a 1.16:1 step off the sidebar surface, the hairline
 * 1.20:1. A lighter field inside a darker outline at a hard radius is what
 * makes the eye resolve a SHAPE anyway, and the tile was --bg-elev — correct
 * for a vessel that must read as empty, wrong when it makes the brightest pixel
 * on the row the one with no information in it.
 *
 * ─── THE GLYPH IS NOT THE TILE ───────────────────────────────────────────
 * A container at 50% opacity reads *disabled*; an ICON fading out of a row
 * reads *departing*. What survives from the deleted fill's rule is the part
 * underneath it: encode the clock in something with a FIXED ZERO. The
 * descending fill had one (the tile's bottom). Saturation does NOT — an emoji
 * that starts grey has nowhere to drain to, and the material is user-chosen.
 * Opacity does. So opacity CARRIES the clock and the drain RIDES ALONG; on an
 * achromatic icon the drain does nothing and the fade still does the whole job.
 * (The first version of this was saturation-only, and a stress strip of ⌚ 🧾 🐑
 * 📄 through every step is why it was unshippable.)
 *
 * The rule the fill left behind, kept because it is still true of any
 * CONTAINER: never re-encode the clock as the tile at a fraction of its
 * opacity. The answer was to delete the tile, not to dim it.
 *
 * --clock survives as the SUB-CHAT DOT's ink — 6px of it, and the one thing on
 * a row that is a definite colour rather than the user's own artwork. It is a
 * THEME token (styles.css): the accent cut to 34%, with the colour it is cut
 * with re-stepping per theme the way --status-* do. The two fade alphas
 * re-step there for the same reason, arriving through a different channel: an
 * emoji composited at α over a LIGHT ground loses contrast faster than the same
 * α over a dark one.
 *
 * ─── Densities ───────────────────────────────────────────────────────────
 * Three, and they differ in SIZE ONLY — same phases, same ink, same drawing:
 *
 *   row    24px box, 20px glyph — the sidebar row's leading mark. The box is
 *                 what the last day's outline is drawn on and what a child's dot
 *                 is centred in; for four days out of five nothing paints it.
 *                 The mobile sheet renders this same density in its own 20px
 *                 cell, with the two glyph sizes re-scaled by the same ratios
 *                 (NavTree.css) — one drawing on both surfaces, not two.
 *   card   24px — a chat card inline in a conversation (a chat spawning, or
 *                 reporting back). Identical to `row` by construction: a card
 *                 is a row in a different container, and the day the two
 *                 diverge is the day the sidebar stops predicting what a card
 *                 will look like. It has its own token so a future divergence
 *                 is a one-line change rather than a fork.
 *   chip   16px — inline in running text, from an `@` mention. Sized to sit on
 *                 a text line without driving its leading; a 24px mark in a
 *                 20px line box pushes the line apart and the paragraph ripples.
 *                 A2 is safe here for one reason: the BOX does not move. The
 *                 pill is already the container the tile was duplicating, so
 *                 deleting the tile takes a container out of a container and
 *                 the glyph inside grows to 13px within the same 16px box.
 *
 * ─── A SUB-CHAT HAS NO CLOCK, so its dot has two states and no fill ──────
 * A sub-chat is not a small chat that ages more quietly — it is a piece of
 * work with a result, and the result comes back to the parent as a card. The
 * moment it delivers, it retires. There is no clock to draw, because nothing
 * is counting down: it is either still working or it is done.
 *
 *   live      a solid 6px dot at full presence
 *   retired   a hollow ring
 *
 * So the dot does NOT fade with anything, and it never shows a fill. That is
 * the whole vocabulary a 6px mark can carry anyway, and it is now carrying
 * exactly the distinction that matters.
 *
 * This replaced a dot whose opacity tracked the parent's clock — a mark that
 * quietly said "your parent is three days old", which is not a fact about the
 * sub-chat and not a fact anyone can read off six pixels of alpha.
 */
export function ChatChip({
  density,
  chat,
  shape,
  className,
  onClick,
  onDoubleClick,
  title,
}: ChatChipProps) {
  const isDot = shape ? shape === 'dot' : chat.spawned_by != null;

  // A SUB-CHAT HAS NO CLOCK. It does not read its parent's and it does not run
  // one of its own — it retires when it delivers. So the dot asks one question
  // and never touches `chipClock`: has this finished?
  if (isDot) {
    const retired = isChatRetired(chat);
    return (
      /* biome-ignore lint/a11y/useKeyWithClickEvents: mouse-only by design, exactly as the tile is — the keyboard path to this chat's actions is the row's context menu, and adding a key handler here would put a second tab stop on every row of the rail. */
      <span
        className={`chatchip${className ? ` ${className}` : ''}`}
        data-density={density}
        data-phase={retired ? 'done' : 'live'}
        data-shape="dot"
        onClick={onClick}
        onDoubleClick={onDoubleClick}
        title={title}
      >
        <i className="chatchip-dot" data-hollow={retired ? 'true' : undefined} />
      </span>
    );
  }

  const clock = chipClock(chat);
  const common = {
    className: `chatchip${className ? ` ${className}` : ''}`,
    'data-density': density,
    'data-phase': clock.phase,
    onClick,
    onDoubleClick,
    title,
  };

  return (
    // `data-step` is the whole seam between this component and the fade: the
    // stylesheet reads it and nothing else. Always present, 0 included, so a
    // chat that is talked to has a value to animate back UP from rather than an
    // attribute appearing and disappearing under the transition.
    <span {...common} data-shape="tile" data-step={clock.step}>
      <b className="chatchip-glyph">{chat.icon ?? '•'}</b>
    </span>
  );
}

export interface ChatChipProps {
  /** Size only — see the densities note above. */
  density: ChatChipDensity;
  chat: ChatChipChat;
  /**
   * Force the mark's form. Omit and it follows `spawned_by`, which is right
   * nearly everywhere; pass it when the CALLER already knows better. The
   * sidebar does: a chat whose `spawned_by` points at a tab that is not in the
   * list (deleted, or in another workspace) is drawn as a top-level row there,
   * and a dot with no parent row above it to belong to is just a lost mark.
   */
  shape?: 'tile' | 'dot' | undefined;
  /* There is deliberately NO `parent` prop. It existed to lend a child its
     parent's clock, and both halves of that are now wrong: the server resolves
     the effective clock onto the row it belongs to, and a sub-chat has no clock
     to lend in the first place. A second chat as an input is a second place for
     this component to get time from. */
  className?: string | undefined;
  onClick?: ((e: React.MouseEvent) => void) | undefined;
  onDoubleClick?: ((e: React.MouseEvent) => void) | undefined;
  title?: string | undefined;
}

export type ChatChipDensity = 'row' | 'card' | 'chip';

/**
 * What the chip needs off a chat, and nothing more.
 *
 * Structural rather than `Tab` on purpose. Every field but the name is
 * OPTIONAL, so a `Tab` satisfies it whether or not the server has grown the
 * clock columns yet — the chip degrades to `fresh` on a row that has no clock
 * rather than failing to compile against one. The server's own shape is
 * territory A's (`shared/src/types.ts`); this is the contract the three
 * rendering surfaces share.
 */
export interface ChatChipChat {
  name: string;
  /** The leading emoji. Callers should pass their own fallback, not a default. */
  icon?: string | null | undefined;
  /** Pinned stops the clock outright — the one override there is. */
  pinned?: boolean | undefined;
  /** Set on a chat spawned under another; the id of that parent. */
  spawned_by?: string | null | undefined;
  /**
   * The SERVER's lifecycle verdict. Authoritative: the client never decides
   * whether a chat is over, it only draws the decision.
   */
  done?: boolean | undefined;
  /**
   * The clock as the server publishes it — the ONLY input to how this chip
   * draws time. Pass `tab.clock` straight through; do not unpack it, do not
   * rebuild it from a timestamp, and do not substitute one when it is absent.
   *
   * `null` is a real answer (a sub-chat has no clock — it retires on delivery
   * rather than decaying), and `undefined` is "not told". Both draw a clean
   * tile, so callers need not tell them apart.
   */
  clock?: ChatClock | null | undefined;
}

/** Re-exported so the three surfaces agree on the number without each
 *  reaching into `@muxpad/shared` for it. */
export const DECAY_DAYS = CHAT_DECAY_DAYS;

export type ChipPhase = 'pinned' | 'fresh' | 'ageing' | 'last-day' | 'done';

export interface ChipClock {
  phase: ChipPhase;
  /** Whole days remaining, DECAY_DAYS…0. */
  daysLeft: number;
  /**
   * WHICH RUNG of the fade the mark is on: 0 fresh, 1 one day gone, 2 two.
   * 0 for pinned, last-day and done — they are drawn by their phase, not by the
   * ladder. There is no 3: `last_day` is read before the quantisation below, so
   * the fourth day is the outline and not a third fade.
   *
   * This was `fill` — a percentage of a tile that no longer exists. Same
   * quantisation, named for what it now drives.
   */
  step: number;
}

/**
 * What the chip DRAWS, from what the server PUBLISHES. Nothing else.
 *
 * ONE OWNER. `stopped`, `last_day` and `done` are READ off the row — the
 * client does not decide, re-check or second-guess any of them, and there is
 * no timestamp anywhere in this function. The only number it computes is the
 * clock's RESOLUTION.
 *
 * This is stricter than it looks, and it is stricter on purpose. It used to
 * carry a fallback that derived the whole lifecycle from `last_activity_at`
 * for "rows that predate the column" — which sounded prudent and was in fact a
 * second, unowned implementation of the decay rules living in the client. It
 * cost territory C a defensive guard in its adapter (a null `clock` had to be
 * carefully distinguished from a missing one, or a sub-chat that cannot decay
 * would have been handed a countdown), and it is the exact shape of the bug
 * muxpad has shipped three times: two surfaces deriving one value, agreeing
 * today, drifting the moment either moves. The fallback is gone. A row with no
 * clock draws a mark at full presence and says nothing.
 *
 * The quantisation that remains is a RENDERING decision, not a disagreement:
 *
 *   · it is the settled visual language — one rung per day, and the ladder is
 *     what nine rounds with the user converged on;
 *   · a 20px glyph cannot carry a continuous value. The difference between 61%
 *     and 62% faded is not information, and animating it would have every chip
 *     in the rail re-rendering on a timer to say nothing.
 *
 * It takes no `now`, and that absence is load-bearing: a function with a clock
 * in it is a function that can disagree with the server about what time it is.
 */
export function chipClock(chat: ChatChipChat): ChipClock {
  const published = chat.clock;

  // NO CLOCK — and there is nothing to work out. A sub-chat (`clock: null`)
  // does not decay, and a row the server has said nothing about is not the
  // client's to guess at. Both draw the mark at full presence: no fade, no
  // countdown, no claim. "I have not been told" renders as "nothing to report",
  // which is the only honest option and the only one that cannot be wrong.
  if (!published) return { phase: 'fresh', daysLeft: DECAY_DAYS, step: 0 };

  // Everything below is READ, not derived. Three fields off the row, in the
  // server's own precedence.
  if (published.stopped) return { phase: 'pinned', daysLeft: DECAY_DAYS, step: 0 };
  if (chat.done) return { phase: 'done', daysLeft: 0, step: 0 };
  // READ BEFORE THE QUANTISATION, and that is why the ladder has four live
  // phases rather than five: by the time a row could reach rung 3 the server has
  // already flagged its last day, so the outline takes over instead. A rung 3 is
  // unreachable by construction — not a missing case.
  if (published.last_day) return { phase: 'last-day', daysLeft: 1, step: 0 };

  // The ONE thing this function computes, and it is a rendering decision
  // rather than a second opinion: the server's continuous `fill` (0 → 1)
  // quantised to the rungs the fade actually has. The value is A's; only its
  // resolution is ours.
  const step = Math.floor(clamp01(published.fill) * DECAY_DAYS);
  return {
    phase: step === 0 ? 'fresh' : 'ageing',
    daysLeft: Math.max(0, DECAY_DAYS - step),
    step,
  };
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/**
 * True iff this chat has left the live list — the sidebar's grouping rule.
 *
 * The server's `done`, and nothing else. There is no arithmetic behind this any
 * more: what leaves the sidebar is a lifecycle decision, the server owns
 * lifecycle, and a client that can reach a different answer will eventually
 * reach a different answer.
 */
export function isChatDone(chat: ChatChipChat): boolean {
  return chat.done === true;
}

/**
 * Has this SUB-CHAT delivered?
 *
 * The one question a sub-chat's mark asks, and the one the sidebar asks to
 * decide whether it still occupies a live row. It is `done` and nothing else:
 * a sub-chat has no clock, so there is no arithmetic to fall back to and none
 * is wanted — the server retires it when its work finishes (the
 * `close_when_done` semantics the cron scheduler already has, except that this
 * retires to the done group instead of closing, because nothing is deleted).
 *
 * Absent `done` means a row that predates the column, and it reads as still
 * live. That is the safe direction: a sub-chat wrongly shown as live is a row
 * you can see and act on, where one wrongly retired has silently left the list.
 */
export function isChatRetired(chat: ChatChipChat): boolean {
  return chat.done === true;
}

/**
 * The tooltip a one-line row carries.
 *
 * The row is NAME ONLY now, which is what bought the rail its scannability —
 * but the machine-written headline is not deleted, it moves HERE. It is still
 * the answer to "which of these did I want", it is still shown in the `@`
 * picker, and it is still on the row: one hover away instead of permanently
 * occupying a second line on every row whether or not you were asking.
 */
export function chatTooltip(chat: ChatChipChat & { headline?: string | null | undefined }): string {
  const parts = [chat.name];
  if (chat.headline) parts.push(chat.headline);
  // A SUB-CHAT HAS NO CLOCK, so it says nothing about time. It reports the one
  // thing it has to report — whether it has delivered — and a live one says
  // nothing at all rather than inventing a countdown it is not running.
  if (chat.spawned_by != null) {
    if (isChatRetired(chat)) parts.push('done');
  } else {
    const clock = chipClock(chat);
    parts.push(CLOCK_WORDS[clock.phase](clock.daysLeft));
  }
  return parts.join(' · ');
}

const CLOCK_WORDS: Record<ChipPhase, (daysLeft: number) => string> = {
  pinned: () => 'pinned',
  done: () => 'done',
  'last-day': () => 'last day',
  fresh: (d) => `${d}d left`,
  ageing: (d) => `${d}d left`,
};
