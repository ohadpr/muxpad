// The muxpad-owned UNIVERSAL agent instructions file — one file injected into
// EVERY agent chat session regardless of backend (claude / codex / cursor).
// Capabilities like `muxpad search` and `muxpad publish` must be known to all
// harnesses; CLAUDE.md only reaches Claude, so muxpad does the injecting.
//
// Lifecycle mirrors the agent-mode overlays (agent-modes.ts): seeded ONCE at server boot,
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
## Scheduling — use \`muxpad cron\`, never the harness's own

**DO NOT use your harness's built-in scheduling** — Claude Code's
\`CronCreate\`/\`CronList\`, or any backend-internal scheduler. Those live
INSIDE this session: they fire into a week-old, compacted context, expire
silently after ~7 days, lose every fire that came due while the machine was
asleep or the pane was closed, are invisible from anywhere but here, and
report nothing when they fail. Do not offer them either.

Use muxpad's instead. It is durable (SQLite, survives every restart), catches
up after downtime, never expires, is visible and editable from any pane, and
can be fired by hand before you trust it.

- From inside a pane, scheduling work for THIS session:
  \`muxpad cron new --name=pr-sweep --at='weekdays at 09:00' --pane "check my open PRs and summarize what needs me"\`
  \`--pane\` with no value means this pane. \`--at\` takes a cron expression
  (\`0 9 * * 1-5\`) or a phrase (\`daily at 09:00\`, \`weekdays at 09:00\`,
  \`every 30m\`); add \`--tz=<IANA>\` to pin a zone.
- For a recurring job that wants a FRESH context each time (a sweep, a digest,
  a report — most recurring jobs), use \`--new-tab\` instead of \`--pane\`: it
  spawns a new agent tab per fire and closes it when the run finishes cleanly.
- \`muxpad cron list\` (schedules, next due, last run, failure streak),
  \`muxpad cron show <name>\` (+ run history), \`muxpad cron run <name>\`
  (fire NOW — always test a new cron this way), \`muxpad cron pause/resume
  <name>\`, \`muxpad cron rm <name>\`.

## Working across panes

Other agents and terminals are running alongside you. The map:
\`muxpad pane list --all [--json]\` (every pane: id, workspace/tab, busy|idle,
title) and \`muxpad agent list\` (every agent session: backend, mode, status).

- Read before you act: \`muxpad pane read <id>\` (a terminal's scrollback),
  \`muxpad agent transcript <paneId> [--tail=N]\` (normalized, any backend),
  \`muxpad pane summarize <id>\` (a short summary — prefer this over pulling a
  full transcript; keep your own context lean).
- Talk to an agent pane with \`muxpad agent send <paneId> "message"\` — it
  lands in that session and queues automatically if the agent is mid-turn.
  Prefer it over \`muxpad pane send\` for agent panes: raw keystrokes fight
  the TUI.
- \`muxpad pane send <id> "cmd" [--no-enter] | --key=ctrl-c\` types into a
  LIVE terminal. Never inject into a terminal a human may be typing in —
  check \`foreground_cmd\` / recent activity (\`pane read\`) first.

## Waiting without burning tokens

- \`muxpad agent wait <paneId> --timeout=SEC\` blocks until that agent's turn
  finishes (exit 0 done/already idle, 1 not an agent pane, 2 fatal, 3
  timeout). Run it in the background from your Bash tool and you get woken
  when the worker is done — no polling, no tokens spent waiting. ALWAYS pass
  \`--timeout\` so a wedged worker can't park you forever.
- \`muxpad watch [--types=a,b] [--json]\` streams the live event bus.
- Read \`status\` in \`pane list\`, not \`busy\`. It is one of
  \`blocked\` (wants you NOW — an agent question, or a BEL),
  \`working\` (a turn or a background subagent is running),
  \`done\` (finished, unread), \`dead\` (the runner gave up), \`idle\`.
  \`agents\` alongside it counts live background subagents.
  \`busy\` is a deprecated alias for \`status === 'working'\`.
- For a RUNNER-OWNED pane, \`working\` is the runner registry — a turn or the
  durable subagent roster — so it is trustworthy: tailing a dev server on its
  terminal face no longer reads busy, and a silently-thinking agent no longer
  reads idle. For a pane with NO runner it is still the PTY-output heuristic,
  where both of those caveats DO apply.
- To block on one specific turn, still prefer \`agent wait\` / \`turn_active\`:
  \`working\` deliberately stays true while a background subagent outlives the
  turn that launched it.
`;

export function agentInstructionsPath(dataDir: string): string {
  return join(dataDir, 'agent-instructions.md');
}

/** Seed the file at server boot. Written ONCE — an existing file is the
 *  user's and is never touched (same policy as the mode overlays). */
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
