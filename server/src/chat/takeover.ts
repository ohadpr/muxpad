import type { PtydClient } from '../ptyd-client/PtydClient.js';
import type { AgentSessionStore } from '../store/AgentSessionStore.js';

const isClaude = (fg: string | null): boolean => !!fg && /\bclaude\b/i.test(fg);

/**
 * Hand a pane's session from its Claude TUI to chat. If a Claude TUI is the
 * live foreground, SIGTERM it (the PID the wrapper recorded) and wait for it to
 * clear — then mark chat the single writer. Idempotent: a no-op if no TUI is
 * running. This is what the terminal→chat toggle triggers, so the view switch
 * and the driver switch happen together.
 */
export async function takeoverPane(
  paneId: string,
  store: AgentSessionStore,
  ptyd: PtydClient,
): Promise<{ ok: boolean; error?: string }> {
  let fg: string | null = null;
  try {
    fg = await ptyd.getForegroundCommand(paneId);
  } catch {
    fg = null;
  }
  if (isClaude(fg)) {
    const s = store.getByPane(paneId);
    if (s?.tui_pid) {
      try {
        process.kill(s.tui_pid, 'SIGTERM');
      } catch {
        // already gone, or not our process
      }
    }
    for (let i = 0; i < 25; i++) {
      await new Promise((r) => setTimeout(r, 150));
      let f: string | null = null;
      try {
        f = await ptyd.getForegroundCommand(paneId);
      } catch {
        f = null;
      }
      if (!isClaude(f)) break;
    }
    let still: string | null = null;
    try {
      still = await ptyd.getForegroundCommand(paneId);
    } catch {
      still = null;
    }
    if (isClaude(still)) return { ok: false, error: 'could not stop the terminal' };
  }
  if (store.getByPane(paneId)) store.setWriter(paneId, 'headless');
  return { ok: true };
}
