const SYNC_BEGIN = '\x1b[?2026h';
const SYNC_END = '\x1b[?2026l';

/** Cap replay when a TUI emits no DEC 2026 sync frames (e.g. Cursor CLI). */
export const INK_REPLAY_TAIL_BYTES = 48 * 1024;

const CLEAR_MARKERS = [
  '\x1b[3J\x1b[H',
  '\x1b[H\x1b[2J',
  '\x1b[2J\x1b[H',
  '\x1b[2J',
  '\x1b[3J',
] as const;

function capTail(payload: string): string {
  if (payload.length <= INK_REPLAY_TAIL_BYTES) return payload;
  return payload.slice(-INK_REPLAY_TAIL_BYTES);
}

function sliceFromLastClear(snapshot: string): string | null {
  let start = -1;
  for (const marker of CLEAR_MARKERS) {
    const idx = snapshot.lastIndexOf(marker);
    if (idx > start) start = idx;
  }
  return start >= 0 ? snapshot.slice(start) : null;
}

/**
 * Ink TUIs (Claude Code) emit DEC 2026 sync blocks. Replaying only the last
 * complete frame paints the current screen without scrolling through session
 * history on a fresh xterm attach.
 *
 * Cursor CLI does not emit those markers — it streams incremental redraws on
 * the xterm normal buffer. Replaying the full ring buffer replays every
 * scroll step. Fall back to the tail after the last clear-screen sequence,
 * then cap by byte length.
 */
export function inkReplayPayload(snapshot: string): string {
  if (!snapshot) return snapshot;
  const lastBegin = snapshot.lastIndexOf(SYNC_BEGIN);
  if (lastBegin >= 0) {
    const end = snapshot.indexOf(SYNC_END, lastBegin + SYNC_BEGIN.length);
    const frame =
      end < 0
        ? snapshot.slice(lastBegin)
        : snapshot.slice(lastBegin, end + SYNC_END.length);
    return capTail(frame);
  }
  const cleared = sliceFromLastClear(snapshot);
  if (cleared) return capTail(cleared);
  return capTail(snapshot);
}
