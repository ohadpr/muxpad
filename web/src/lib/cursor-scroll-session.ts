import type { Terminal } from '@xterm/xterm';
import { getPaneScrollRatio, setPaneScrollRatio } from './pane-scroll';
import {
  bufferHasScrollback,
  isCursorAgentCmd,
  linesAboveBottom,
  linesAboveFromRatio,
  restoreLinesAboveBottom,
  scrollRatioFromTerm,
} from './xterm-internals';

/** Cursor CLI scroll — one module, one policy. See class docstring. */
export type CursorScrollSessionOpts = {
  paneId: string;
  getForegroundCmd: () => string | null | undefined;
  revealAfterReplay: () => void;
};

/**
 * Cursor runs on xterm's normal buffer. muxpad must not fight the viewport
 * during a live session — only wheel/touch moves scroll. We save a ratio for
 * page reload and restore it once after ring-buffer replay on mount.
 */
export class CursorScrollSession {
  private replayPending = true;
  private scrollSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private replayIdleTimer: ReturnType<typeof setTimeout> | null = null;
  private replayFallbackTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly opts: CursorScrollSessionOpts) {}

  get replayActive(): boolean {
    // Only cursor-agent hides the pane and freezes input during replay — its
    // normal-buffer output visibly scrubs as the ring buffer repaints. Other
    // foregrounds (Claude Code, plain shells) paint immediately and stay
    // interactive; gating them blanked the pane (opacity:0 / pointer-events:
    // none) for up to 3s and swallowed touch input on mobile.
    return this.replayPending && isCursorAgentCmd(this.opts.getForegroundCmd());
  }

  /** Call when WS connect starts replay (fresh mount). */
  armReplayFallback(term: Terminal): void {
    if (this.replayFallbackTimer !== null) clearTimeout(this.replayFallbackTimer);
    this.replayFallbackTimer = setTimeout(() => {
      this.replayFallbackTimer = null;
      this.finishReplayOnce(term);
    }, 3000);
  }

  /** Debounced — replay output still streaming. */
  onTerminalWriteParsed(term: Terminal): void {
    if (!this.replayPending) return;
    if (this.replayIdleTimer !== null) clearTimeout(this.replayIdleTimer);
    this.replayIdleTimer = setTimeout(() => {
      this.replayIdleTimer = null;
      this.finishReplayOnce(term);
    }, 400);
  }

  onUserScroll(term: Terminal): void {
    if (this.replayPending) return;
    this.scheduleSave(term);
  }

  onPageHide(term: Terminal): void {
    this.flushSave(term);
  }

  onTabHidden(term: Terminal): void {
    this.flushSave(term);
  }

  /** WS reconnect — skip replay scroll restore. */
  skipReplay(): void {
    this.replayPending = false;
    this.clearReplayTimers();
    this.opts.revealAfterReplay();
  }

  dispose(): void {
    this.clearReplayTimers();
    if (this.scrollSaveTimer !== null) clearTimeout(this.scrollSaveTimer);
  }

  private clearReplayTimers(): void {
    for (const t of [this.replayIdleTimer, this.replayFallbackTimer]) {
      if (t !== null) clearTimeout(t);
    }
    this.replayIdleTimer = null;
    this.replayFallbackTimer = null;
  }

  private finishReplayOnce(term: Terminal): void {
    if (!this.replayPending) return;
    this.replayPending = false;
    this.clearReplayTimers();
    this.opts.revealAfterReplay();
    if (!isCursorAgentCmd(this.opts.getForegroundCmd())) return;
    try {
      // User may have scrolled during a long replay (3s fallback) — don't clobber.
      if (linesAboveBottom(term) > 0) return;
      const ratio = getPaneScrollRatio(this.opts.paneId);
      if (ratio !== undefined && ratio > 0.01) {
        restoreLinesAboveBottom(term, linesAboveFromRatio(term, ratio));
      } else {
        term.scrollToBottom();
      }
    } catch {
      // term disposed
    }
  }

  private scheduleSave(term: Terminal): void {
    if (!isCursorAgentCmd(this.opts.getForegroundCmd())) return;
    if (!bufferHasScrollback(term)) return;
    if (this.scrollSaveTimer !== null) clearTimeout(this.scrollSaveTimer);
    this.scrollSaveTimer = setTimeout(() => {
      this.scrollSaveTimer = null;
      this.flushSave(term);
    }, 200);
  }

  private flushSave(term: Terminal): void {
    if (!isCursorAgentCmd(this.opts.getForegroundCmd())) return;
    if (!bufferHasScrollback(term)) return;
    try {
      setPaneScrollRatio(this.opts.paneId, scrollRatioFromTerm(term));
    } catch {
      // ignore
    }
  }
}
