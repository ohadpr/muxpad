import { CHAT_DECAY_DAYS, type ChatClock, chatClockDone } from '@muxpad/shared';
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
 * ─── The material ────────────────────────────────────────────────────────
 *
 *   fresh      a clean WHITE tile, 1px border, the emoji at full colour
 *   ageing     a SOLID fill of --clock descends from the TOP, burying the
 *              emoji: 25% / 50% / 75% as the days pass
 *   last day   the tile is gone — a dashed border in --clock around a ghosted
 *              emoji (grayscale, 0.34 opacity)
 *   done       drawn exactly as `last day`. The tile has nothing left to say
 *              about time, and the row's PLACE (inside the done group) is what
 *              says it is over. Two phases, one drawing, on purpose.
 *   pinned     a clean tile with no fill, ever. The clock is stopped.
 *   child      the same material at dot size — 6px of --clock, becoming a
 *              hollow RING on the last day
 *
 * ─── The fill is a COLOUR, not an opacity ────────────────────────────────
 * The fill is `background: var(--clock)` on a block whose HEIGHT animates from
 * 0 to 100%. It is emphatically NOT the tile at a fraction of its opacity.
 * This went through several rounds and the difference is the whole idea: a
 * definite colour descending from the top reads as a vessel FILLING UP, which
 * is what a clock running down looks like. The same information encoded as
 * opacity reads as "this row is DIMMED" — a disabled state, not a countdown —
 * and at 50% it is indistinguishable from a row that has simply been
 * de-emphasised. Never re-encode this as opacity, however much simpler the
 * CSS gets.
 *
 * --clock is ONE colour at every size: `color-mix(in srgb, <accent> 34%,
 * #d9d3ea)`. The 24px tile's fill and the 6px child dot are the same ink, so
 * the tile and the dot read as the same substance at two scales rather than as
 * two indicators that happen to sit near each other.
 *
 * ─── Densities ───────────────────────────────────────────────────────────
 * Three, and they differ in SIZE ONLY — same phases, same ink, same drawing:
 *
 *   row    24px — the sidebar row's leading mark
 *   card   24px — a chat card inline in a conversation (a chat spawning, or
 *                 reporting back). Identical to `row` by construction: a card
 *                 is a row in a different container, and the day the two
 *                 diverge is the day the sidebar stops predicting what a card
 *                 will look like. It has its own token so a future divergence
 *                 is a one-line change rather than a fork.
 *   chip   16px — inline in running text, from an `@` mention. Sized to sit on
 *                 a text line without driving its leading; a 24px tile in a
 *                 20px line box pushes the line apart and the paragraph ripples.
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
  parent,
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

  const clock = chipClock(chat.clock ? chat : (parent ?? chat));
  const common = {
    className: `chatchip${className ? ` ${className}` : ''}`,
    'data-density': density,
    'data-phase': clock.phase,
    onClick,
    onDoubleClick,
    title,
  };

  return (
    <span {...common} data-shape="tile">
      {/* The descending fill. Always in the DOM, at height 0 when there is
          nothing to bury, so the transition has something to run between and a
          chat that is talked to animates back UP rather than snapping. */}
      {/* Empty and unlabelled, so it contributes nothing to the a11y tree on
          its own — no aria-hidden needed, and biome rightly objects to one. */}
      <i className="chatchip-fill" style={{ height: `${clock.fill}%` }} />
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
  /**
   * The parent chat. A FALLBACK only — the server publishes a child's
   * effective clock on the child's own row, so this is needed just for rows
   * that predate `clock`.
   */
  parent?: ChatChipChat | undefined;
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
   * The clock as the server publishes it, or NULL for a chat that has none.
   *
   * Null is the SUB-CHAT's answer and it is a real answer, not a gap: a
   * sub-chat retires on delivery rather than on a timer, so there is no clock
   * to publish. `undefined` means something different — a row from a server
   * that predates the column — and `chipClock` treats the two apart.
   */
  clock?: ChatClock | null | undefined;
  /** Last-resort clock origin for rows with no published `clock`. */
  last_activity_at?: number | null | undefined;
}

/** Re-exported so the three surfaces agree on the number without each
 *  reaching into `@muxpad/shared` for it. */
export const DECAY_DAYS = CHAT_DECAY_DAYS;

const DAY_MS = 86_400_000;

export type ChipPhase = 'pinned' | 'fresh' | 'ageing' | 'last-day' | 'done';

export interface ChipClock {
  phase: ChipPhase;
  /** Whole days remaining, DECAY_DAYS…0. */
  daysLeft: number;
  /** Percent of the tile buried from the top. 0 for pinned, last-day and done. */
  fill: number;
}

/**
 * What the chip DRAWS, from what the server PUBLISHES.
 *
 * The server's `clock.fill` is continuous (0 → 1, see shared/chat-clock.ts);
 * this quantises it to the four steps the tile actually has — clean, a
 * quarter, a half, and then the dashed outline of the final day.
 *
 * That quantisation is a rendering decision, not a disagreement with the
 * server, and it is deliberate on both counts:
 *
 *   · it is the settled visual language — "25% / 50% / 75% as days pass" is
 *     what the prototype does and what eight rounds with the user converged on;
 *   · 24px of tile cannot carry a continuous value. The difference between 61%
 *     and 62% buried is not information, and animating it would have every
 *     chip in the rail re-rendering on a timer to say nothing.
 *
 * Lifecycle is NEVER re-derived here. `stopped`, `last_day` and `done` are all
 * read off the row; only the fill's resolution is the client's business.
 */
export function chipClock(chat: ChatChipChat, now: number = Date.now()): ChipClock {
  const published = chat.clock;
  if (published) {
    if (published.stopped) return { phase: 'pinned', daysLeft: DECAY_DAYS, fill: 0 };
    // The row's `done` is the answer. `chatClockDone` is the SERVER's own
    // predicate, reached for only when the row does not carry the flag — so
    // even the fallback is the server's rule rather than a second one.
    if (chat.done ?? chatClockDone(published, now)) return { phase: 'done', daysLeft: 0, fill: 0 };
    // Buried QUARTERS, floored: a tile shows the step it has fully reached.
    const steps = Math.floor(Math.max(0, Math.min(1, published.fill)) * DECAY_DAYS);
    const daysLeft = Math.max(0, DECAY_DAYS - steps);
    if (published.last_day) return { phase: 'last-day', daysLeft: 1, fill: 0 };
    const fill = (steps / DECAY_DAYS) * 100;
    return { phase: fill === 0 ? 'fresh' : 'ageing', daysLeft, fill };
  }

  // ── No published clock ──────────────────────────────────────────────────
  // A row from a server that predates the column. Derive the same four steps
  // from whatever timestamp there is, so the rail does not go blank during a
  // rolling upgrade, and treat a row with no timestamp at all as FRESH rather
  // than as instantly done.
  if (chat.pinned) return { phase: 'pinned', daysLeft: DECAY_DAYS, fill: 0 };
  const startedAt = chat.last_activity_at ?? now;
  const elapsed = Math.max(0, Math.floor((now - startedAt) / DAY_MS));
  const daysLeft = Math.max(0, Math.min(DECAY_DAYS, DECAY_DAYS - elapsed));
  if (chat.done ?? daysLeft <= 0) return { phase: 'done', daysLeft, fill: 0 };
  if (daysLeft <= 1) return { phase: 'last-day', daysLeft, fill: 0 };
  const fill = (1 - daysLeft / DECAY_DAYS) * 100;
  return { phase: fill === 0 ? 'fresh' : 'ageing', daysLeft, fill };
}

/**
 * True iff this chat has left the live list — the sidebar's grouping rule.
 *
 * The server's `done` is the answer. The derivation behind it exists only for
 * rows that predate the column; this is not a second opinion, and a chat is
 * never swept out of the live list by the client's own arithmetic while the
 * server is saying otherwise.
 */
export function isChatDone(chat: ChatChipChat, now: number = Date.now()): boolean {
  if (chat.done !== undefined) return chat.done;
  return chipClock(chat, now).phase === 'done';
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
export function chatTooltip(
  chat: ChatChipChat & { headline?: string | null | undefined },
  now: number = Date.now(),
): string {
  const parts = [chat.name];
  if (chat.headline) parts.push(chat.headline);
  // A SUB-CHAT HAS NO CLOCK, so it says nothing about time. It reports the one
  // thing it has to report — whether it has delivered — and a live one says
  // nothing at all rather than inventing a countdown it is not running.
  if (chat.spawned_by != null) {
    if (isChatRetired(chat)) parts.push('done');
  } else {
    const clock = chipClock(chat, now);
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
