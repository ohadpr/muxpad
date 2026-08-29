// The muxpad-owned UNIVERSAL agent instructions file — one file injected into
// EVERY agent chat session regardless of backend (claude / codex / cursor).
// Capabilities like `muxpad search` and `muxpad publish` must be known to all
// harnesses; CLAUDE.md only reaches Claude, so muxpad does the injecting.
//
// Lifecycle mirrors the CEO playbook (ceo.ts): seeded ONCE at server boot,
// user-owned afterwards — never overwritten, so tuning what every agent knows
// is editing the file, not a deploy. If the file is missing (or empty) at
// injection time, backends inject nothing — no error.
//
// Per-backend injection mechanism (each documented at its call site):
// - claude  → the Agent SDK's native `systemPrompt: { preset: 'claude_code',
//             append }` (backends/claude.ts)
// - codex   → no append mechanism in `codex exec` (its only instructions
//             config REPLACES the base prompt), so the content is prepended,
//             delimited, to the first user message of each NEW session
//             (backends/codex.ts)
// - cursor  → same fallback; `cursor-agent` has no instructions flag
//             (backends/cursor.ts)
// - `muxpad claude` TUI wrapper → native `--append-system-prompt`
//   (scripts/muxpad cmd_claude)
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Seed content — concise and harness-neutral (any of the three backends may
 *  be reading this). Written once; the user owns the file afterwards. */
export const AGENT_INSTRUCTIONS_SEED = `# muxpad

You are running inside a muxpad pane — a multi-workspace terminal-and-browser
cockpit. The \`muxpad\` CLI is on PATH; run \`muxpad --help\` for the full verb
list. Capabilities worth knowing:

- \`muxpad search "query"\` (add \`--sessions\` to list matching sessions) —
  full-text search across the archived history of EVERY agent session ever
  run on this machine. Use it to recall past decisions or find which session
  discussed something.
- \`muxpad publish <file-or-dir> [--name=slug]\` — hosts the artifact and
  prints a PUBLIC internet URL. DEFAULT BEHAVIOR: whenever you produce a
  viewable artifact — an HTML page, report, dashboard, chart, site, demo,
  or any document the user will want to LOOK AT rather than read as chat
  text — publish it and hand back the URL, without being asked. "Make me a
  report/page/artifact" implies "host it". Also triggers on "publish",
  "host", "share", "link". Use \`--name=<slug>\` for a stable re-publishable
  URL; \`muxpad publish --rm <slug>\` takes one down.
- Cross-pane work: \`muxpad pane list --all\`, \`muxpad pane read <id>\`,
  \`muxpad agent send <paneId> "message"\`, and friends.
`;

export function agentInstructionsPath(dataDir: string): string {
  return join(dataDir, 'agent-instructions.md');
}

/** Seed the file at server boot. Written ONCE — an existing file is the
 *  user's and is never touched (same policy as the CEO playbook). */
export function seedAgentInstructions(dataDir: string): void {
  const path = agentInstructionsPath(dataDir);
  if (!existsSync(path)) writeFileSync(path, AGENT_INSTRUCTIONS_SEED);
}

/** Data-dir resolution for the RUNNER process, which has no Config object:
 *  the same rule the harness uses for its agent-logs dir (index.ts). */
export function runnerDataDir(): string {
  return process.env.MUXPAD_DATA_DIR ?? join(homedir(), '.muxpad');
}

/** Read the instructions at injection time. Missing, empty, or unreadable →
 *  null, and the caller injects nothing — deleting the file is a supported
 *  way to opt out, never an error. */
export function readAgentInstructions(dataDir: string = runnerDataDir()): string | null {
  try {
    const text = readFileSync(agentInstructionsPath(dataDir), 'utf8');
    return text.trim() ? text : null;
  } catch {
    return null;
  }
}

/** Delimited block for backends with NO native system-prompt/instructions
 *  mechanism — prepended to the first user message of a NEW session so the
 *  model can tell muxpad's standing instructions from the user's ask. */
export function wrapAgentInstructions(text: string): string {
  return `<muxpad-instructions>\n${text.trim()}\n</muxpad-instructions>`;
}
