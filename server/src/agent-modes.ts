// Agent MODES — ⚡ Do / 🧠 Deep.
//
// 'deep' is the baseline: exactly what muxpad has always done, nothing extra
// injected. 'do' overlays ONE additional block of system-prompt material on
// top of the universal agent instructions: a short behavioral contract that
// makes the agent decisive and terse.
//
// The contract text lives in `<dataDir>/do-mode.md`, a GENERATED file with the
// same lifecycle as agent-instructions.md (agent-files.ts): rewritten from
// DO_MODE_SEED below on every boot, so it always states this build's contract.
// Missing or empty → nothing is injected and 'do' silently degrades to 'deep'
// behavior; never an error.
//
// Injection uses the SAME per-backend mechanism as agent-instructions.md —
// each documented at its call site:
//   - claude  → the Agent SDK's native `systemPrompt: { preset:
//               'claude_code', append }`, with the overlay appended after the
//               universal instructions (backends/claude.ts)
//   - codex   → delimited block prepended to the first user message of each
//               NEW session (`codex exec` has no append-instructions surface)
//   - cursor  → same fallback (`cursor-agent` has no instructions flag)
//   - `muxpad claude` TUI wrapper → native --append-system-prompt
//     (scripts/muxpad cmd_claude)
//
// MID-SESSION SWITCHING — the honest semantics (see docs + PATCH
// /api/panes/:id): none of the three harnesses can change a live session's
// system prompt. The Claude Agent SDK fixes `systemPrompt` at query()
// construction and its Query control surface has no setSystemPrompt (verified
// against @anthropic-ai/claude-agent-sdk 0.3.220: interrupt /
// setPermissionMode / setModel / setMaxThinkingTokens / applyFlagSettings /
// supportedModels / getContextUsage / … and nothing prompt-shaped); codex's
// only instructions hook REPLACES the base prompt; cursor-agent has no flag
// at all. So a mid-session switch:
//   1. updates the pane row immediately (authoritative, and the pane's
//      startup_cmd is rewritten so the NEXT respawn boots natively in the new
//      mode), and
//   2. makes the runner prepend a one-time delimited <muxpad-mode> note to
//      the next user message, declaring the new contract in-conversation.
// That note is a MESSAGE, not a system prompt — a long session can drift from
// it the way it drifts from any instruction. A fresh pane (or a respawn) in
// 'do' mode gets the real system-prompt-level overlay.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentMode } from '@muxpad/shared';
import {
  type MigratedFile,
  runnerDataDir,
  shippedBodyHashes,
  writeGeneratedFile,
} from './agent-files.js';

/** Seed content — harness-neutral (claude/codex/cursor may all read it) and
 *  deliberately short: it competes for attention with the harness's own
 *  system prompt. Written to disk verbatim (under a generated-file banner) on
 *  every boot. */
export const DO_MODE_SEED = `# ⚡ Do mode

This session is in **Do mode**. Optimize for shipped results, not for
conversation.

- **Be decisive.** Act on the most reasonable assumption instead of asking.
  State the assumption in one clause and keep going.
- **Delegate the legwork.** Use subagents for search, reading, and anything
  parallelizable; run independent work concurrently rather than in sequence.
- **Be brief.** Replies are at most 3 sentences unless depth is explicitly
  requested (or the answer genuinely cannot be correct in short form).
- **Result first.** No preamble, no narration, no play-by-play of what you are
  about to do or are doing. Lead with the outcome.
- **A completed task is one line** stating what was done. Nothing else.
- **Ask only when truly blocked** on something hard to reverse — a
  destructive action, a spend, an irreversible external side effect. Anything
  reversible: pick, do it, mention it.

## Route it to whoever owns it

Speed usually comes from the right agent doing the work, not from you doing
it faster.

- **Check for an owner first.** If the request belongs to another standing
  agent's domain — a project, an area, an ongoing thread — send it there
  (\`muxpad agent list\` to find it, \`muxpad agent send <paneId> "…"\`), wait
  (\`muxpad agent wait <paneId> --timeout=SEC\`, backgrounded), and relay the
  answer. That agent has the context, history and files you don't.
- **No owner? Spawn one:** \`muxpad agent new --cwd=<dir> "task"\`.
- **Delegate legwork to subagents** — searching, reading, anything
  parallelizable — and run independent strands concurrently.
- **Wait tokenlessly.** Background the wait; don't poll.
- **Report results, not process.** The answer, and what you'd do next if it
  matters. Never a narration of who you asked and what you're waiting on.
`;

export const DO_MODE_FILE = 'do-mode.md';

export function doModePath(dataDir: string): string {
  return join(dataDir, DO_MODE_FILE);
}

/**
 * sha256 of every `do-mode.md` default this project ever shipped (one:
 * edb661b, the revision that introduced modes); the current seed is added at
 * use. Only the one-shot migration reads them — see
 * SHIPPED_INSTRUCTIONS_DEFAULTS.
 */
export const SHIPPED_DO_MODE_DEFAULTS: readonly string[] = [
  'dd07e927e4833873ccf0bfc5ce8a12ab4331aacb2cdbc422824e9fde1c6ac209',
];

/** What the one-shot migration needs about this file. An edited do-mode.md is
 *  kept as a `.bak` rather than folded into the notes: it is a contract that
 *  only applies in ⚡ Do mode, and the notes are injected in EVERY session. */
export const DO_MODE_MIGRATION: MigratedFile = {
  name: DO_MODE_FILE,
  knownDefaults: [...SHIPPED_DO_MODE_DEFAULTS, ...shippedBodyHashes(DO_MODE_SEED)],
  appendToNotes: false,
};

/** Rewrite the generated file at server boot. It always matches this build. */
export function seedDoMode(dataDir: string): void {
  writeGeneratedFile(dataDir, DO_MODE_FILE, DO_MODE_SEED);
}

/**
 * Read the Do-mode overlay at injection time. Returns null for mode 'deep'
 * (nothing to inject, by definition) and for a missing/empty/unreadable file
 * — the caller injects nothing, no error.
 */
export function readDoModeOverlay(
  mode: AgentMode,
  dataDir: string = runnerDataDir(),
): string | null {
  if (mode !== 'do') return null;
  try {
    const text = readFileSync(doModePath(dataDir), 'utf8');
    return text.trim() ? text : null;
  } catch {
    return null;
  }
}

/**
 * Rewrite an agent pane's `startup_cmd` so a RESPAWN boots in `mode`. This is
 * what makes a mid-session switch eventually real rather than merely
 * announced: the live session only gets the in-band note, but the next
 * respawn (ptyd restart, reboot, dead-runner sweep, "Switch folder") builds
 * the system prompt from the flag.
 *
 * 'deep' is expressed by the ABSENCE of the flag, so a deep pane's command is
 * byte-for-byte what it was before modes existed — existing rows never churn.
 * A non-agent command (or null) is returned untouched.
 */
export function applyModeToStartupCmd(cmd: string | null, mode: AgentMode): string | null {
  if (!cmd?.startsWith('muxpad agent')) return cmd;
  // A PENDING harness-pick pane is left ALONE. `muxpad agent --pick` is
  // compared verbatim in four places (the /agent-backend, /as-terminal and
  // /as-web 409 gates, and the dead-runner sweep's skip); inserting a flag
  // would silently wedge the harness picker and make the sweep churn a pane
  // whose only "fault" is waiting to be chosen. Nothing is lost: the mode is
  // on the pane ROW, and /agent-backend re-applies it to the real command the
  // moment a harness is picked.
  if (/(^|\s)--pick(\s|$)/.test(cmd)) return cmd;
  // Strip any existing flag first, so repeated switches can't accrete.
  const stripped = cmd.replace(/\s--mode\s+(do|deep)\b/g, '');
  if (mode !== 'do') return stripped;
  // Insert AFTER any --backend selector and before --model/--resume/--pick.
  // This exact ordering is load-bearing: ws.ts's self-heal rewrite composes
  // the same shape and compares the result to the stored command to decide
  // "is this a reconnect or a new runner" — a different flag order would read
  // as a new runner on every hello and re-flip the pane's face.
  const head = stripped.match(/^muxpad agent(?:\s--backend\s+(?:claude|codex|cursor))?/)?.[0];
  if (!head) return stripped;
  return `${head} --mode do${stripped.slice(head.length)}`;
}

/**
 * The one-time mid-session switch note, prepended (delimited) to the next
 * user message. Distinct tag from <muxpad-instructions> so the model can tell
 * "muxpad's standing instructions" from "your contract just changed".
 *
 * Switching TO 'do' carries the full contract (the live session's system
 * prompt has none). Switching to 'deep' just revokes it — the baseline is the
 * absence of the overlay, so there is nothing to restate.
 */
export function wrapModeNote(mode: AgentMode, overlay: string | null): string {
  const body =
    mode === 'do'
      ? overlay
        ? `The user switched this session to ⚡ Do mode. Follow this contract from now on:\n\n${overlay.trim()}`
        : 'The user switched this session to ⚡ Do mode: be decisive, act on reasonable assumptions, delegate legwork to subagents, reply in at most 3 sentences, result first with no narration, and ask only when truly blocked on something hard to reverse.'
      : 'The user switched this session back to 🧠 Deep mode. Any previous ⚡ Do-mode contract (terse, result-only, act-without-asking) no longer applies — resume your normal, thorough default behavior.';
  return `<muxpad-mode>\n${body}\n</muxpad-mode>`;
}
