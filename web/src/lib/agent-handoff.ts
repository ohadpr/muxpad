import { api } from '../api';
import { sendPaneMessage } from './pane-input';

/**
 * One-way TUI → agent handoff. This REPLACED live terminal⇄chat session
 * switching (takeover/relaunch, headless per-turn drivers, dual-writer
 * guards — dropped in the same PR that added this): instead of two surfaces
 * driving one session, the running TUI writes its context to a file and a
 * fresh chat-native agent session picks it up.
 *
 * Flow, fully client-orchestrated:
 *   1. Verify a Claude TUI is actually the pane's foreground (typing at a
 *      bare shell would execute garbage).
 *   2. Type a handoff instruction into the TUI: write a complete handoff
 *      document to ~/.muxpad/handoffs/<paneId>.md, then close its own pane
 *      via `muxpad pane delete` — so the terminal retires itself exactly
 *      when the handoff is durable, with no server-side watcher.
 *   3. Create an ✳ agent tab (same cwd) and send it a first message that
 *      POLLS for the handoff file — sidestepping any "is the TUI done yet"
 *      timing: the agent waits, reads, and continues the work.
 */
export interface HandoffResult {
  ok: boolean;
  error?: string;
  tabSlug?: string;
}

export async function handoffToAgent(opts: {
  paneId: string;
  workspaceId: string;
  cwd?: string | null | undefined;
  /**
   * The retirement command the TUI runs once the handoff file is written.
   * The caller knows the tab shape: `muxpad tab delete <tabId>` when this is
   * the tab's only pane (a bare pane-delete leaves an empty tab shell),
   * `muxpad pane delete <paneId>` when siblings remain.
   */
  closeCmd: string;
  /** Fired as soon as the agent tab exists — navigate immediately. */
  onTabCreated?: (tabSlug: string) => void;
}): Promise<HandoffResult> {
  const { paneId, workspaceId, cwd, closeCmd } = opts;
  const fgRes = await fetch(`/api/agent-sessions/${paneId}/foreground`).catch(() => null);
  const fg = fgRes?.ok
    ? ((await fgRes.json().catch(() => null)) as { isClaude?: boolean } | null)
    : null;
  if (!fg?.isClaude) {
    return { ok: false, error: 'No Claude TUI is running in this pane — nothing to hand off.' };
  }
  const file = `~/.muxpad/handoffs/${paneId}.md`;
  await sendPaneMessage(
    paneId,
    `Please hand off this session to another Claude instance: write a complete handoff document to ${file} — the task, key context and decisions, current state, and concrete next steps; everything a fresh session needs to continue seamlessly. When the file is fully written, run \`${closeCmd}\` to close this terminal (that's expected — a chat agent is taking over).`,
  );
  const tab = await api.createTab(workspaceId, {
    bootstrap: 'agent',
    ...(cwd ? { cwd } : {}),
  });
  opts.onTabCreated?.(tab.slug);
  const full = await api.getTab(tab.id);
  const agentPane = full.panes[0];
  if (!agentPane) return { ok: false, error: 'agent tab was created without a pane' };
  const text = `You are taking over from another Claude session. It is writing its handoff to ${file} right now. Wait for that file to exist and be non-empty (check every ~5 seconds, for up to 3 minutes), read it, and continue the work it describes. Start by confirming in 2–3 sentences what you absorbed.`;
  // The runner needs a couple of seconds to boot; the send endpoint 409s
  // until it registers.
  const deadline = Date.now() + 30_000;
  for (;;) {
    const r = await fetch(`/api/agent-sessions/${agentPane.id}/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    }).catch(() => null);
    if (r?.status === 202) return { ok: true, tabSlug: tab.slug };
    if (Date.now() > deadline) {
      return {
        ok: false,
        tabSlug: tab.slug,
        error:
          'The agent tab was created but did not accept the kickoff message — send it manually: read the handoff file and continue.',
      };
    }
    await new Promise((res) => setTimeout(res, 700));
  }
}
