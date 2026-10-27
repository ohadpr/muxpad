import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * THE OVERRIDE THAT OUTLIVED THE CODE THAT WROTE IT.
 *
 * a6d9979 turned the harness's automatic compaction off in two places: the
 * SDK `settings` object in this runner, and — one line in a commit message —
 * "the shared ~/.claude/settings.json was switched the same way". 5ddfc5d
 * reverted the first and never touched the second.
 *
 * The file wins, and it wins EVERYWHERE: it is read live by every claude
 * process on the machine, muxpad's and otherwise, including ones that started
 * days before it was written. Measured on this very session — a 1M-token
 * thread that had auto-compacted roughly every two days since September:
 *
 *     2026-10-19T15:36  trigger: "auto"     preTokens: 968,746   ← the last one
 *     2026-10-21T18:04  trigger: "manual"
 *     2026-10-22T23:11  trigger: "manual"
 *     2026-10-24T17:09  trigger: "manual"
 *     2026-10-27T01:46  trigger: "manual"   preTokens: 976,913
 *
 * Every compaction after the flag was written is one a human typed, and the
 * one in between was a chat sitting at 98% answering `Prompt is too long`.
 *
 * So: a settings file that disables compaction is now SAID OUT LOUD at runner
 * start. muxpad does not rewrite the file — it is the user's, and they are
 * allowed to mean it — but an invisible override is the thing that cost a week
 * here, and a line in the log is the whole fix for that.
 */

/** `~/.claude/settings.json`, or the one `$CLAUDE_CONFIG_DIR` points at. */
export function settingsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json');
}

/**
 * What this settings object does to automatic compaction, as a sentence —
 * or null when it leaves it alone (which is the state nobody has to think
 * about, and the one this returns for a missing or unreadable file).
 */
export function compactionOverride(settings: unknown): string | null {
  if (!settings || typeof settings !== 'object') return null;
  const s = settings as Record<string, unknown>;
  if (s.autoCompactEnabled === false) {
    return 'automatic compaction is OFF in your claude settings (autoCompactEnabled: false) — this chat will fail with `Prompt is too long` at the ceiling instead of compacting';
  }
  if (typeof s.autoCompactWindow === 'number') {
    return `automatic compaction is capped at ${s.autoCompactWindow.toLocaleString()} tokens in your claude settings (autoCompactWindow) — long chats will compact far earlier than the model's window`;
  }
  return null;
}

/** Read the file and apply {@link compactionOverride}; never throws. */
export function compactionOverrideOnDisk(path = settingsPath()): string | null {
  try {
    return compactionOverride(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return null; // absent or unparseable — the harness's own defaults apply
  }
}
