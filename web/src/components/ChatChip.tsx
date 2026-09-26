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
 * ─── The child dot fades as the tile fills ───────────────────────────────
 * Note the two marks move in OPPOSITE directions: the parent's tile gains ink
 * as the clock runs down, and the child's dot loses it. That is not an
 * inconsistency. The tile is a vessel (filling), the dot is a presence
 * (fading), and a 6px dot has no room to be a vessel — a 25%-filled 6px disc
 * is a rendering artefact, not a signal. Both reach their loudest change on
 * the last day, which is the only day the distinction has to survive.
 */
export function ChatChip({
  density,
  chat,
  parent,
  className,
  onClick,
  onDoubleClick,
  title,
}: ChatChipProps) {
  // A child chat shares its PARENT's clock — work spawned under a chat should
  // not outlive it. `parent` is how the caller supplies it; falling back to the
  // child's own row keeps the mark drawable when the parent is not to hand
  // (another workspace, or a list that was not built as a tree).
  const isChild = parent != null || chat.spawned_by != null;
  const clock = chatClock(parent ?? chat);

  const common = {
    className: `chatchip${className ? ` ${className}` : ''}`,
    'data-density': density,
    'data-phase': clock.phase,
    onClick,
    onDoubleClick,
    title,
  };

  if (isChild) {
    const dot = childDot(clock);
    return (
      <span {...common} data-shape="dot">
        <i
          className="chatchip-dot"
          data-hollow={dot.hollow ? 'true' : undefined}
          style={{ opacity: dot.opacity }}
        />
      </span>
    );
  }

  return (
    <span {...common} data-shape="tile">
      {/* The descending fill. Always in the DOM, at height 0 when there is
          nothing to bury, so the transition has something to run between and a
          chat that is talked to animates back UP rather than snapping. */}
      <i className="chatchip-fill" style={{ height: `${clock.fill}%` }} aria-hidden="true" />
      <b className="chatchip-glyph">{chat.icon ?? '•'}</b>
    </span>
  );
}

export interface ChatChipProps {
  /** Size only — see the densities note above. */
  density: ChatChipDensity;
  chat: ChatChipChat;
  /** The parent chat, when `chat` is a child. Supplies the clock they share. */
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
   * The SERVER's lifecycle verdict. Authoritative when present: the client
   * never decides whether a chat is over, it only draws the decision (the
   * fallback below exists for rows that predate the column, not as a second
   * opinion).
   */
  done?: boolean | undefined;
  /** Epoch ms the current clock started from. */
  clock_started_at?: number | null | undefined;
  /** Fallback clock origin for rows that have no `clock_started_at` yet. */
  last_activity_at?: number | null | undefined;
}

/** One constant, no per-chat weighting. Pinning is the only override. */
export const DECAY_DAYS = 4;

const DAY_MS = 86_400_000;

export type ChatClockPhase = 'pinned' | 'fresh' | 'ageing' | 'last-day' | 'done';

export interface ChatClock {
  phase: ChatClockPhase;
  /** Whole days remaining, DECAY_DAYS…0. */
  daysLeft: number;
  /** Percent of the tile buried from the top. 0 for pinned, last-day and done. */
  fill: number;
}

/**
 * The clock, in whole days.
 *
 * QUANTISED to days deliberately, and not only to match the prototype's steps.
 * A continuous fill would re-render every chip on every animation frame to say
 * something no one can read off a 24px tile — the difference between 61% and
 * 62% buried is not information. Whole days give four distinct, nameable
 * states (clean / a quarter / half / three-quarters) and then the dashed
 * outline, which is the resolution the mark can actually carry.
 */
export function chatClock(chat: ChatChipChat, now: number = Date.now()): ChatClock {
  if (chat.pinned) return { phase: 'pinned', daysLeft: DECAY_DAYS, fill: 0 };

  const startedAt = chat.clock_started_at ?? chat.last_activity_at ?? now;
  const elapsed = Math.max(0, Math.floor((now - startedAt) / DAY_MS));
  const daysLeft = Math.max(0, Math.min(DECAY_DAYS, DECAY_DAYS - elapsed));

  // The server's word first; the derivation is only for rows that predate it.
  if (chat.done ?? daysLeft <= 0) return { phase: 'done', daysLeft, fill: 0 };
  // The tile is spent — a dashed outline round a ghost. No fill to report.
  if (daysLeft <= 1) return { phase: 'last-day', daysLeft, fill: 0 };

  const fill = Math.round((1 - daysLeft / DECAY_DAYS) * 100);
  return { phase: fill === 0 ? 'fresh' : 'ageing', daysLeft, fill };
}

/** True iff this chat has left the live list. The sidebar's grouping rule. */
export function isChatDone(chat: ChatChipChat, now: number = Date.now()): boolean {
  return chatClock(chat, now).phase === 'done';
}

/**
 * The child dot, which FADES where the tile fills (see the note above), and
 * gives way to a hollow ring on the parent's last day — the dot's equivalent of
 * the tile's dashed outline, and the same "provisional" reading at 6px.
 */
export function childDot(clock: ChatClock): { hollow: boolean; opacity: number } {
  if (clock.phase === 'last-day' || clock.phase === 'done') return { hollow: true, opacity: 0.85 };
  const v = clock.phase === 'pinned' ? 1 : clock.daysLeft / DECAY_DAYS;
  return { hollow: false, opacity: Number((0.3 + v * 0.55).toFixed(2)) };
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
  chat: ChatChipChat & { headline?: string | null },
  now: number = Date.now(),
): string {
  const clock = chatClock(chat, now);
  const parts = [chat.name];
  if (chat.headline) parts.push(chat.headline);
  parts.push(CLOCK_WORDS[clock.phase](clock.daysLeft));
  return parts.join(' · ');
}

const CLOCK_WORDS: Record<ChatClockPhase, (daysLeft: number) => string> = {
  pinned: () => 'pinned',
  done: () => 'done',
  'last-day': () => 'last day',
  fresh: (d) => `${d}d left`,
  ageing: (d) => `${d}d left`,
};
