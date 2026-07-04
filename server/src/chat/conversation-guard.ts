/**
 * Conversation-level single-writer check. The per-pane foreground guard in
 * the chat send path can't see a Claude TUI holding the SAME session-id from
 * a DIFFERENT pane (a cross-pane `muxpad claude --resume <sid>`), and two
 * writers on one sid corrupt the transcript regardless of which pane they
 * sit in. Scan every other pane tracking the sid and report the first one
 * whose live foreground is a claude process — the caller refuses to spawn a
 * headless turn while such a rival exists.
 *
 * Returns the rival pane id, or null when the conversation is free. Fails
 * open per pane (an unreachable ptyd/foreground reads as "not claude") —
 * consistent with the per-pane check it extends.
 */
export async function findConversationRival(
  paneId: string,
  sid: string,
  sessions: { pane_id: string; current_sid: string | null }[],
  getForegroundCommand: (paneId: string) => Promise<string | null>,
): Promise<string | null> {
  const siblings = sessions.filter((s) => s.pane_id !== paneId && s.current_sid === sid);
  for (const sib of siblings) {
    const fg = await getForegroundCommand(sib.pane_id).catch(() => null);
    if (fg && /\bclaude\b/i.test(fg)) return sib.pane_id;
  }
  return null;
}
