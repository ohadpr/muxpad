// The muxpad-owned UNIVERSAL agent instructions injected into EVERY agent chat
// session regardless of backend (claude / codex / cursor). Capabilities like
// `muxpad search` and `muxpad publish` must be known to all harnesses;
// CLAUDE.md only reaches Claude, so muxpad does the injecting.
//
// TWO FILES, injected in this order (agent-files.ts has the reasoning):
//   <dataDir>/agent-instructions.md  GENERATED from AGENT_INSTRUCTIONS_SEED
//                                    below and rewritten on every boot, so it
//                                    always describes THIS build.
//   <dataDir>/agent-notes.md         The user's. Created once, never touched.
// Either being missing or empty simply contributes nothing — never an error.
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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type MigratedFile,
  readAgentNotes,
  runnerDataDir,
  shippedBodyHashes,
  writeGeneratedFile,
} from './agent-files.js';

/** Seed content — concise and harness-neutral (any of the three backends may
 *  be reading this). Written to disk verbatim (under a generated-file banner)
 *  on every boot. */
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

  **UPDATING? REUSE THE SLUG. Run \`muxpad publish --list\` FIRST.** Before
  publishing anything, list what is already there and look for a slug that is
  the same THING you are about to publish — a newer draft of the same page,
  another pass at the same report, a fix to the same demo. If one exists,
  update it: \`muxpad publish --update=<slug> <path>\`. \`--update\` refuses to
  create, so it fails loudly on a typo instead of silently minting a lookalike.
  Republishing keeps the previous copy at \`/<slug>@2/\` (3 kept), so updating
  in place loses nothing and the user's existing link keeps working.
  Only invent a NEW slug for a genuinely NEW artifact. Never
  \`thing2\`/\`thing3\`/\`thing-v2\` — a numbered pile of near-identical slugs
  means the user has to guess which one is current, which is precisely the
  problem \`--update\` exists to prevent.

- \`muxpad app\` — long-running local web servers muxpad keeps alive with NO
  tab: \`muxpad app list\` (slug, measured state, url), \`app start|stop <slug>\`,
  \`app logs <slug>\` when one is unreachable and you need to see why. Register
  one with \`muxpad app add --name=<n> --url=<url> --cwd=<dir> -- <command>\`.
  APPS ARE PRIVATE (tailnet only) — never publish an app's data or suggest
  exposing it; \`publish\` is for static artifacts you MEAN to be public.

## Scheduling — \`muxpad cron\` is the ONLY scheduler on this machine

**Anything that should happen LATER — once or repeatedly — is a \`muxpad
cron\`.** "Remind me tomorrow", "check this every morning", "run that at 5pm",
"do this weekly": all the same verb. There is no other scheduling mechanism
here, and this rule is absolute. There is no one-shot flag: for a ONE-OFF,
make the cron for that moment (a dated expression like \`0 17 4 9 *\` — 17:00
on Sep 4) and \`muxpad cron rm <name>\` once it has fired.

**DO NOT use your harness's own scheduling, under ANY of its names.** It is
not always a tool — it is often a SKILL or a SLASH COMMAND, which is how this
rule gets missed. Specifically ruled out:

- \`/schedule\` (Claude Code scheduled cloud agents / "routines"), including
  its one-time "run this once at 3pm" mode
- \`/loop\` (run a prompt on a recurring interval)
- the \`CronCreate\` / \`CronList\` / \`CronDelete\` tools, and \`ScheduleWakeup\`
- any other cloud, routine, wakeup, reminder or interval scheduler your
  harness offers, whatever it is called

**Do not RECOMMEND them either.** Asked "what should I use to schedule
something?", the answer is \`muxpad cron\` — do not name the harness's options
as alternatives.

Why, so this is a judgement and not a rule you have to take on faith: the
harness's schedulers live INSIDE this session. They fire into a week-old,
compacted context, expire silently after ~7 days, lose every fire that came
due while the machine was asleep or the pane was closed, are invisible from
anywhere but here, report nothing when they fail, and exist only on one
backend. muxpad's is durable (SQLite, survives every restart), catches up
after downtime, never expires, is visible and editable from any pane, works
the same on every backend, and can be fired by hand before you trust it.

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
\`muxpad pane list --all [--json]\` (every pane: id, workspace/tab, face,
status, title — \`status\` is the five-state value described under "Waiting
without burning tokens" below) and \`muxpad agent list\` (every agent session:
backend, mode, status).

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
  \`ready\` (finished, waiting for you), \`dead\` (the runner gave up), \`idle\`.
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

export const AGENT_INSTRUCTIONS_FILE = 'agent-instructions.md';

export function agentInstructionsPath(dataDir: string): string {
  return join(dataDir, AGENT_INSTRUCTIONS_FILE);
}

/**
 * sha256 of every `agent-instructions.md` default this project ever shipped,
 * oldest first (c2110d5, edb661b, ccfbebc, 3ab5df2, 6d66549), recovered by
 * evaluating AGENT_INSTRUCTIONS_SEED at each revision of this file. The
 * CURRENT seed is added at use — together they are every byte sequence muxpad
 * can have written here.
 *
 * Their one remaining job is the one-shot migration: a file matching one of
 * them is untouched plumbing, so there is nothing of the user's to rescue.
 * Add the outgoing hash whenever the seed changes, until the migration is
 * retired; anything unrecognised is treated as the user's and kept.
 */
export const SHIPPED_INSTRUCTIONS_DEFAULTS: readonly string[] = [
  '4e6713de01f8b9f5666f149cc297df7d54421e94ee51d8a420171014d6bbd7d7',
  'ea5747ded789e55db867340cd422059ac7c83eeb5c8c5aeb1b640e608814d242',
  '277aae4ac82196b5360b5d78570ec7b17cc907ea9cb7b588d199bb88985b2efb',
  '81bc702c727c66bc3302178b264fe2bbc69a1d055c457e02e3e2c45eded4908d',
  '423da5969cfd0a4cfc24c0bb8a2a156f291699a37e860988885afa9bbfca324c',
];

/** What the one-shot migration needs to know about this file: anything on
 *  disk that is not a shipped default is the user's, and belongs in the notes
 *  file (which is injected in exactly the same place). */
export const INSTRUCTIONS_MIGRATION: MigratedFile = {
  name: AGENT_INSTRUCTIONS_FILE,
  knownDefaults: [...SHIPPED_INSTRUCTIONS_DEFAULTS, ...shippedBodyHashes(AGENT_INSTRUCTIONS_SEED)],
  appendToNotes: true,
};

/** Rewrite the generated file at server boot. It always matches this build. */
export function seedAgentInstructions(dataDir: string): void {
  writeGeneratedFile(dataDir, AGENT_INSTRUCTIONS_FILE, AGENT_INSTRUCTIONS_SEED);
}

/**
 * What gets injected: muxpad's generated instructions followed by the user's
 * notes. Either half missing, empty or unreadable simply contributes nothing,
 * never an error — emptying `agent-notes.md` is how you inject none of your
 * own. The generated half is muxpad's and comes back on the next boot; opting
 * out of THAT is not a thing you do by deleting a file.
 */
export function readAgentInstructions(dataDir: string = runnerDataDir()): string | null {
  let generated: string | null = null;
  try {
    generated = readFileSync(agentInstructionsPath(dataDir), 'utf8');
  } catch {
    generated = null;
  }
  const parts = [generated, readAgentNotes(dataDir)]
    .map((t) => t?.trim())
    .filter((t): t is string => !!t);
  return parts.length ? parts.join('\n\n') : null;
}

/** Delimited block for backends with NO native system-prompt/instructions
 *  mechanism — prepended to the first user message of a NEW session so the
 *  model can tell muxpad's standing instructions from the user's ask. */
export function wrapAgentInstructions(text: string): string {
  return `<muxpad-instructions>\n${text.trim()}\n</muxpad-instructions>`;
}
