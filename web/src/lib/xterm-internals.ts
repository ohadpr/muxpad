import type { IBuffer, Terminal } from '@xterm/xterm';

/** Grid floor shared by every fit-and-send path. Must stay below any real device. */
export const MIN_FIT_COLS = 20;
export const MIN_FIT_ROWS = 5;

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
  return /cursor-agent|cursor agent/.test(c);
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

export type ProposedFit = { cols: number; rows: number };

/** True when a FitAddon proposal is safe to apply locally (and to send). */
export function proposedFitUsable(
  proposed: ProposedFit | undefined | null,
  minCols = MIN_FIT_COLS,
  minRows = MIN_FIT_ROWS,
): proposed is ProposedFit {
  return (
    !!proposed &&
    Number.isFinite(proposed.cols) &&
    Number.isFinite(proposed.rows) &&
    proposed.cols >= minCols &&
    proposed.rows >= minRows
  );
}

export type ViewportAnchor =
  | { kind: 'bottom' }
  | { kind: 'line'; text: string; offsetIntoLogical: number; linesAbove: number }
  | { kind: 'ratio'; ratio: number; linesAbove: number };

function logicalLineStart(buf: IBuffer, y: number): number {
  let start = y;
  while (start > 0) {
    const line = buf.getLine(start);
    if (!line?.isWrapped) break;
    start--;
  }
  return start;
}

function readLogicalLine(buf: IBuffer, start: number): string {
  let text = buf.getLine(start)?.translateToString(true) ?? '';
  let y = start + 1;
  while (y < buf.length) {
    const line = buf.getLine(y);
    if (!line?.isWrapped) break;
    text += line.translateToString(true);
    y++;
  }
  return text;
}

function logicalLineRowCount(buf: IBuffer, start: number): number {
  let n = 1;
  let y = start + 1;
  while (y < buf.length && buf.getLine(y)?.isWrapped) {
    n++;
    y++;
  }
  return n;
}

function findLogicalLineStart(buf: IBuffer, text: string, hintY: number): number | null {
  const matches: number[] = [];
  for (let y = 0; y < buf.length; y++) {
    if (buf.getLine(y)?.isWrapped) continue;
    if (readLogicalLine(buf, y) === text) matches.push(y);
  }
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0] ?? null;
  return matches.reduce((best, y) => (Math.abs(y - hintY) < Math.abs(best - hintY) ? y : best));
}

/** Snapshot of what the reader is looking at, for restore after a reflow. */
export function captureViewportAnchor(term: Terminal): ViewportAnchor | null {
  try {
    const buf = term.buffer.active;
    if (buf.type !== 'normal') return null;
    if (linesAboveBottom(term) === 0) return { kind: 'bottom' };
    const viewportY = buf.viewportY;
    const start = logicalLineStart(buf, viewportY);
    const text = readLogicalLine(buf, start);
    if (text.trim().length >= 2) {
      return {
        kind: 'line',
        text,
        offsetIntoLogical: viewportY - start,
        linesAbove: linesAboveBottom(term),
      };
    }
    const searchEnd = Math.min(buf.length, viewportY + Math.max(1, term.rows));
    for (let y = viewportY + 1; y < searchEnd; y++) {
      const s = logicalLineStart(buf, y);
      const t = readLogicalLine(buf, s);
      if (t.trim().length < 2) continue;
      return {
        kind: 'line',
        text: t,
        offsetIntoLogical: y - s,
        linesAbove: linesAboveBottom(term),
      };
    }
    return { kind: 'ratio', ratio: scrollRatioFromTerm(term), linesAbove: linesAboveBottom(term) };
  } catch {
    return null;
  }
}

export function restoreViewportAnchor(term: Terminal, anchor: ViewportAnchor): void {
  try {
    const buf = term.buffer.active;
    if (buf.type !== 'normal') return;
    if (anchor.kind === 'bottom') {
      term.scrollToBottom();
      return;
    }
    if (anchor.kind === 'line') {
      const hint = Math.max(0, buf.baseY - anchor.linesAbove);
      const found = findLogicalLineStart(buf, anchor.text, hint);
      if (found !== null) {
        const wrapRows = logicalLineRowCount(buf, found);
        const into = Math.max(0, Math.min(anchor.offsetIntoLogical, Math.max(0, wrapRows - 1)));
        const target = Math.max(0, Math.min(buf.baseY, found + into));
        term.scrollToLine(target);
        return;
      }
      restoreLinesAboveBottom(term, anchor.linesAbove);
      return;
    }
    restoreLinesAboveBottom(term, linesAboveFromRatio(term, anchor.ratio));
  } catch {
    // term disposed
  }
}

/** Capture the viewport, mutate (fit/resize), put the same content back. */
export function withViewportAnchor(term: Terminal, mutate: () => void): void {
  const anchor = captureViewportAnchor(term);
  mutate();
  if (anchor) restoreViewportAnchor(term, anchor);
}

/**
 * Capture-phase policy: when we own the buffer path, ALWAYS consume the
 * event even if getLinesScrolled is 0. Sub-line trackpad deltas must not
 * fall through to xterm handleWheel (pixel scroll on the same gesture).
 */
export function consumeCapturedWheel(
  term: Terminal,
  e: WheelEvent,
  foregroundCmd?: string | null,
): 'buffer' | 'none' {
  if (!shouldScrollXtermBuffer(term, foregroundCmd)) return 'none';
  scrollBufferWheel(term, e);
  return 'buffer';
}

/** False → xterm must not run its fallback handleWheel. */
export function customWheelAllowsXterm(term: Terminal, foregroundCmd?: string | null): boolean {
  return !shouldScrollXtermBuffer(term, foregroundCmd);
}

export function mayFireQueuedResize(opts: { closed: boolean; mayDrive: boolean }): boolean {
  return !opts.closed && opts.mayDrive;
}

export function shouldSkipCursorUnchangedBox(opts: {
  isCursor: boolean;
  force: boolean;
  prevW: number;
  prevH: number;
  nextW: number;
  nextH: number;
  epsilon?: number;
}): boolean {
  if (!opts.isCursor || opts.force) return false;
  const eps = opts.epsilon ?? 2;
  return Math.abs(opts.nextW - opts.prevW) < eps && Math.abs(opts.nextH - opts.prevH) < eps;
}

export function cursorShouldRefitOnVisibility(skippedFitWhileHidden: boolean): boolean {
  return skippedFitWhileHidden;
}

/** Aim SGR wheel at the transcript band (upper third), not the composer row. */
export function transcriptBandRow(rows: number, hitRow: number): number {
  return Math.min(hitRow, Math.max(1, Math.floor(rows / 3)));
}

/** End/Home jump the local buffer when the reader has scrolled up. */
export function bufferJumpForKey(term: Terminal, key: string): 'bottom' | 'top' | null {
  if (key !== 'End' && key !== 'Home') return null;
  try {
    if (term.buffer.active.type !== 'normal') return null;
    if (linesAboveBottom(term) === 0) return null;
    return key === 'End' ? 'bottom' : 'top';
  } catch {
    return null;
  }
}
