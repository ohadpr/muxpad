import type { Terminal } from '@xterm/xterm';

/**
 * Why this file exists: xterm.js v5 exposes cell dimensions and the viewport
 * scrollbar width only through `_core` internals. Concentrating those reads
 * here means a future xterm bump only needs to update this one module.
 */

type V5Core = {
  _renderService?: { dimensions?: { css?: { cell?: { width: number; height: number } } } };
  viewport?: { scrollBarWidth?: number };
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
