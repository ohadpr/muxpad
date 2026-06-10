import type { Terminal } from '@xterm/xterm';

/**
 * Why this file exists: xterm.js v5 exposes cell dimensions and the viewport
 * scrollbar width only through `_core` internals. Concentrating those reads
 * here means a future xterm bump only needs to update this one module.
 */

type V5Core = {
  _renderService?: { dimensions?: { css?: { cell?: { width: number; height: number } } } };
  viewport?: {
    scrollBarWidth?: number;
    getLinesScrolled?: (e: WheelEvent) => number;
    handleWheel?: (e: WheelEvent) => boolean;
  };
  coreMouseService?: { areMouseEventsActive?: boolean };
};

function getCore(term: Terminal): V5Core | undefined {
  return (term as unknown as { _core?: V5Core })._core;
}

export function getCellDimensions(term: Terminal): { width: number; height: number } | null {
  try {
    const cell = getCore(term)?._renderService?.dimensions?.css?.cell;
    if (!cell || cell.width <= 0 || cell.height <= 0) return null;
    return { width: cell.width, height: cell.height };
  } catch {
    return null;
  }
}

/** True for Cursor CLI (normal-buffer scrollback path). */
export function isCursorAgentCmd(cmd: string | null | undefined): boolean {
  if (!cmd) return false;
  const c = cmd.toLowerCase();
  return /cursor-agent|cursor agent/.test(c) || (/\bagent\b/.test(c) && /cursor-agent/.test(c));
}

/** True for Cursor CLI, Claude Code, and similar Ink foreground processes. */
export function isInkForegroundCmd(cmd: string | null | undefined): boolean {
  if (!cmd) return false;
  const c = cmd.toLowerCase();
  return isCursorAgentCmd(cmd) || /claude-code|claude code/.test(c) || /\bclaude\b/.test(c);
}

/** True when the running TUI has enabled xterm mouse reporting (Ink apps). */
export function areMouseEventsActive(term: Terminal): boolean {
  try {
    return getCore(term)?.coreMouseService?.areMouseEventsActive === true;
  } catch {
    return false;
  }
}

/** Public IBuffer lacks hasScrollback; length > rows is the practical signal. */
export function bufferHasScrollback(term: Terminal): boolean {
  try {
    const active = term.buffer.active;
    if (active.type === 'alternate') return false;
    return active.length > term.rows;
  } catch {
    return false;
  }
}

/** Cursor agent on a normal buffer: scroll xterm scrollback, not the PTY. */
export function shouldScrollXtermBuffer(term: Terminal, foregroundCmd?: string | null): boolean {
  try {
    if (!isCursorAgentCmd(foregroundCmd)) return false;
    return term.buffer.active.type === 'normal';
  } catch {
    return false;
  }
}

/** Touch should scroll xterm scrollback (Cursor, or a plain shell on mobile). */
export function shouldTouchScrollBuffer(
  term: Terminal,
  foregroundCmd?: string | null,
  mobile = false,
): boolean {
  if (shouldScrollXtermBuffer(term, foregroundCmd)) return true;
  if (!mobile) return false;
  // Mobile touch mirrors the wheel path: only hijack into xterm's local
  // scrollback when we would NOT forward a wheel to the PTY (i.e. plain,
  // non-mouse-reporting shells). Mouse-reporting / alt-screen TUIs like
  // Claude Code get the gesture forwarded so touch and wheel stay
  // consistent. This previously returned true for ANY normal-buffer TUI on
  // mobile, which scrolled xterm's viewport out from under Claude's
  // absolute-cursor redraws (content shifted, cursor mispositioned).
  try {
    return !shouldForwardWheelToPty(term, foregroundCmd);
  } catch {
    return false;
  }
}

/** Repaint visible rows — required on iOS after buffer scroll / refit. */
export function refreshVisibleRows(term: Terminal): void {
  try {
    term.refresh(0, term.rows - 1);
  } catch {
    // term disposed
  }
}

/** Scroll xterm's normal buffer by a signed line count (touch / wheel). */
export function scrollBufferByLines(term: Terminal, lines: number, repaint = false): boolean {
  if (lines === 0) return false;
  try {
    const active = term.buffer.active;
    if (active.type !== 'normal') return false;

    // Snap to the live prompt only on the final step — not when still a
    // full viewport away (that made one wheel tick jump to the input row).
    if (lines > 0 && active.viewportY < active.baseY) {
      const remaining = active.baseY - active.viewportY;
      const step = Math.max(1, Math.abs(lines));
      if (remaining <= step) {
        term.scrollToBottom();
        if (repaint) refreshVisibleRows(term);
        return true;
      }
    }

    const next = Math.max(0, Math.min(active.baseY, active.viewportY + lines));
    term.scrollToLine(next);
    if (repaint) refreshVisibleRows(term);
    return true;
  } catch {
    return false;
  }
}

/** How many lines the viewport sits above the live prompt (0 = at bottom). */
export function linesAboveBottom(term: Terminal): number {
  const active = term.buffer.active;
  return Math.max(0, active.baseY - active.viewportY);
}

/** Restore a saved lines-above-bottom offset after ring-buffer replay. */
export function restoreLinesAboveBottom(term: Terminal, linesAboveBottom: number): void {
  const active = term.buffer.active;
  // Cap to current scrollback — after refit/truncation baseY may shrink.
  const offset = Math.max(0, Math.min(Math.round(linesAboveBottom), active.baseY));
  const target = active.baseY - offset;
  term.scrollToLine(target);
}

/** Scroll ratio for persistence across truncated replay on reload. */
export function scrollRatioFromTerm(term: Terminal): number {
  const active = term.buffer.active;
  if (active.baseY <= 0) return 0;
  return Math.max(0, Math.min(1, linesAboveBottom(term) / active.baseY));
}

export function linesAboveFromRatio(term: Terminal, ratio: number): number {
  const active = term.buffer.active;
  if (active.baseY <= 0) return 0;
  return Math.round(Math.max(0, Math.min(1, ratio)) * active.baseY);
}

/** Scroll xterm's own buffer (viewport) for wheel events. */
export function scrollBufferWheel(term: Terminal, e: WheelEvent): boolean {
  try {
    if (e.deltaY === 0 || e.shiftKey) return false;
    const lines = getCore(term)?.viewport?.getLinesScrolled?.(e) ?? 0;
    return scrollBufferByLines(term, lines);
  } catch {
    return false;
  }
}

export function shouldForwardWheelToPty(term: Terminal, foregroundCmd?: string | null): boolean {
  try {
    if (shouldScrollXtermBuffer(term, foregroundCmd)) return false;
    // Cursor on the normal buffer: never PTY-forward wheel — spurious
    // wheel events during mobile layout/replay make the agent scroll wildly.
    if (isCursorAgentCmd(foregroundCmd)) return false;
    if (isInkForegroundCmd(foregroundCmd)) return true;
    const active = term.buffer.active;
    // xterm v5: buffer.alternate, not buffer.alt. Ink TUIs (Cursor CLI,
    // Claude Code) run on the alternate screen; xterm maps wheel to ↑/↓
    // there, which scrolls input history instead of the transcript.
    if (active.type === 'alternate') return true;
    if (term.element?.classList.contains('enable-mouse-events')) return true;
    if (areMouseEventsActive(term)) return true;
    // Normal buffer: xterm scrollback viewport or ↑/↓ prompt history.
    return false;
  } catch {
    return false;
  }
}

/** Wheel bytes for the PTY: SGR mouse for Ink/mouse-reporting, else Page keys. */
export function wheelInputForPty(
  term: Terminal,
  col: number,
  row: number,
  deltaY: number,
  stepPx = 30,
  ink = false,
): string {
  if (
    ink ||
    areMouseEventsActive(term) ||
    term.element?.classList.contains('enable-mouse-events')
  ) {
    return sgrWheelInput(col, row, deltaY, stepPx);
  }
  const steps = Math.max(1, Math.min(8, Math.round(Math.abs(deltaY) / stepPx)));
  const key = deltaY > 0 ? '\x1b[6~' : '\x1b[5~';
  return key.repeat(steps);
}

/** Fire wheel through xterm's mouse encoder when a protocol is active. */
export function triggerWheelMouseEvent(
  term: Terminal,
  col: number,
  row: number,
  deltaY: number,
  stepPx = 30,
): boolean {
  try {
    const ms = getCore(term)?.coreMouseService as
      | {
          triggerMouseEvent?: (e: {
            col: number;
            row: number;
            x: number;
            y: number;
            button: number;
            action: number;
            ctrl: boolean;
            alt: boolean;
            shift: boolean;
          }) => boolean;
        }
      | undefined;
    if (!ms?.triggerMouseEvent) return false;
    const steps = Math.max(1, Math.min(8, Math.round(Math.abs(deltaY) / stepPx)));
    for (let i = 0; i < steps; i++) {
      if (
        !ms.triggerMouseEvent({
          col: col - 1,
          row: row - 1,
          x: 0,
          y: 0,
          button: 4,
          action: deltaY > 0 ? 1 : 0,
          ctrl: false,
          alt: false,
          shift: false,
        })
      ) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

/** Build DEC-1006 wheel sequences matching xterm's SGR mouse encoding. */
export function sgrWheelInput(col: number, row: number, deltaY: number, stepPx = 30): string {
  const steps = Math.max(1, Math.min(8, Math.round(Math.abs(deltaY) / stepPx)));
  const button = deltaY > 0 ? 65 : 64;
  let seq = '';
  for (let i = 0; i < steps; i++) {
    seq += `\x1b[<${button};${col};${row}M`;
  }
  return seq;
}

export function setScrollBarWidthZero(term: Terminal): void {
  try {
    const viewport = getCore(term)?.viewport;
    if (viewport && typeof viewport.scrollBarWidth === 'number') {
      viewport.scrollBarWidth = 0;
    }
  } catch {
    // ignore
  }
}
