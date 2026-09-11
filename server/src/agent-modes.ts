// Agent MODES — Chat / Agent.
//
// 'agent' (Agent mode) is the baseline: the harness exactly as it ships,
// nothing extra injected. 'chat' (Chat mode) overlays ONE additional block of
// system-prompt material on top of the universal agent instructions: a short
// behavioral contract that makes the agent decisive and terse. Chat mode is
// what a new tab opens as (DEFAULT_AGENT_MODE); Agent mode is what you get
// when you pick a harness by name and configure it yourself.
//
// The names are user-facing and appear in the chat's chip row. They describe
// the ARRANGEMENT, not the engine — Chat mode is agent-powered too.
//
// The contract text lives in `<dataDir>/chat-mode.md`, a GENERATED file with
// the same lifecycle as agent-instructions.md (agent-files.ts): rewritten from
// CHAT_MODE_SEED below on every boot, so it always states this build's
// contract. Missing or empty → nothing is injected and 'chat' silently
// degrades to Agent-mode behavior; never an error.
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
// Chat mode gets the real system-prompt-level overlay. The UI says so: the
// mode chip's menu labels a mid-session switch "takes hold from your next
// message" and offers a respawn as the strong form.
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { type AgentMode, coerceAgentMode } from '@muxpad/shared';
import {
  type MigratedFile,
  runnerDataDir,
  sha256,
  shippedBodyHashes,
  writeGeneratedFile,
} from './agent-files.js';

/** Seed content — harness-neutral (claude/codex/cursor may all read it) and
 *  deliberately short: it competes for attention with the harness's own
 *  system prompt. Written to disk verbatim (under a generated-file banner) on
 *  every boot. */
export const CHAT_MODE_SEED = `# Chat mode

This session is in **Chat mode** — muxpad's own assistant. Optimize for
shipped results, not for conversation.

## Your plain text is private. \`reply\` is your only voice.

Everything you write as ordinary assistant text is an **inner monologue the
user never sees** — a private scratchpad for reasoning, planning and working
through a problem. It costs nothing and it is unlimited. Think there as much as
you like.

**Nothing reaches the user until it is the content of a \`reply\` call.** That
tool is the only channel out. Deciding to answer is not answering; describing
the message you are about to send is not sending it. If you end a turn without
calling \`reply\`, the person who messaged you got silence.

- **Most replies are a sentence or two.** Brevity is not a summary of your
  reasoning — it is a different thing entirely: the reasoning stays hidden and
  you say only what the user needs.
- **Outcome plus artifact, not narration.** "Done" is not evidence. A filing
  task returns the destination. A research task returns the link. A code task
  returns the command to run. Lead with the thing itself.
- **Several short calls beat one welded paragraph.** When there is genuinely
  more than one thing to say, send a short run of two to four separate
  \`reply\` calls, like quick texts.
- **Never narrate process.** No preamble, no "I'll start by…", no play-by-play,
  no recap of which agent you asked and what you are waiting on.

## How to work

- **Be decisive.** Act on the most reasonable assumption instead of asking.
  State the assumption in one clause and keep going.
- **Delegate the legwork.** Use subagents for search, reading, and anything
  parallelizable; run independent work concurrently rather than in sequence.
- **Be brief.** A reply is at most 3 sentences unless depth is explicitly
  requested (or the answer genuinely cannot be correct in short form).
- **A completed task is one line** stating the outcome and where it landed.
- **Ask only when truly blocked** on something hard to reverse — a
  destructive action, a spend, an irreversible external side effect. Anything
  reversible: pick, do it, mention it. Never pose a question you could have
  answered yourself.

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

export const CHAT_MODE_FILE = 'chat-mode.md';

/** The pre-rename filename. The one-shot file migration still names it so an
 *  upgraded install doesn't leave a stale `do-mode.md` lying next to the new
 *  one, looking like a live contract it no longer is. */
export const LEGACY_CHAT_MODE_FILE = 'do-mode.md';

export function chatModePath(dataDir: string): string {
  return join(dataDir, CHAT_MODE_FILE);
}

/**
 * sha256 of every mode-overlay default this project ever shipped: the
 * pre-rename `do-mode.md` contract (introduced in edb661b and byte-stable
 * until the rename), bare and bannered. The current seed is added at use.
 *
 * Read by the one-shot migration (see SHIPPED_INSTRUCTIONS_DEFAULTS) AND by
 * {@link retireLegacyChatModeFile} — which is why the BANNERED hash has to be
 * here and not just the bare one: what is actually sitting in an upgrading
 * install's data dir is the bannered body, and a `do-mode.md` we failed to
 * recognise as our own would be left behind as if the user had written it.
 */
export const SHIPPED_CHAT_MODE_DEFAULTS: readonly string[] = [
  'dd07e927e4833873ccf0bfc5ce8a12ab4331aacb2cdbc422824e9fde1c6ac209',
  '41924003a7bfdecc71d1930dece4f7bdbd687eb29a3efeffec258da06e438d64',
];

/** What the one-shot migration needs about this file. An edited overlay is
 *  kept as a `.bak` rather than folded into the notes: it is a contract that
 *  only applies in Chat mode, and the notes are injected in EVERY session. */
export const CHAT_MODE_MIGRATION: MigratedFile = {
  name: CHAT_MODE_FILE,
  knownDefaults: [...SHIPPED_CHAT_MODE_DEFAULTS, ...shippedBodyHashes(CHAT_MODE_SEED)],
  appendToNotes: false,
};

/** Rewrite the generated file at server boot. It always matches this build. */
export function seedChatMode(dataDir: string): void {
  writeGeneratedFile(dataDir, CHAT_MODE_FILE, CHAT_MODE_SEED);
}

/**
 * Clear away `do-mode.md` after the rename, but ONLY when it is muxpad's own
 * generated text.
 *
 * It cannot be folded into the one-shot agent-files migration: that is behind
 * a globals marker every existing install has already set, so it would never
 * look. A leftover copy is inert (nothing reads that name any more), but it
 * sits in the data dir next to `chat-mode.md` looking like a live contract, and
 * "which of these two is actually injected?" is exactly the confusion the
 * generated-file banner exists to prevent.
 *
 * A file the user EDITED is left exactly where it is — it isn't ours to
 * delete, and it costs nothing to keep. Best-effort and never throws: this
 * runs at boot under launchd KeepAlive.
 */
export function retireLegacyChatModeFile(dataDir: string): void {
  const path = join(dataDir, LEGACY_CHAT_MODE_FILE);
  try {
    const content = readFileSync(path, 'utf8');
    const known = new Set([...SHIPPED_CHAT_MODE_DEFAULTS, ...shippedBodyHashes(CHAT_MODE_SEED)]);
    if (content.trim() && !known.has(sha256(content))) return; // the user's — leave it
    rmSync(path, { force: true });
  } catch {
    // Absent, or an unwritable data dir. Either way there is nothing to do.
  }
}

/**
 * Read the Chat-mode overlay at injection time. Returns null for Agent mode
 * (nothing to inject, by definition) and for a missing/empty/unreadable file
 * — the caller injects nothing, no error.
 */
export function readChatModeOverlay(
  mode: AgentMode,
  dataDir: string = runnerDataDir(),
): string | null {
  if (mode !== 'chat') return null;
  try {
    const text = readFileSync(chatModePath(dataDir), 'utf8');
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
 * Agent mode is expressed by the ABSENCE of the flag, and that stays true
 * across the rename. It is what lets an untouched pre-rename `muxpad agent`
 * command keep meaning EXACTLY what it always meant (no overlay) — flipping
 * the bare command to mean Chat would have silently re-prompted every
 * existing pane on its next respawn. A non-agent command (or null) is
 * returned untouched.
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
  // Strip any existing flag first, so repeated switches can't accrete. The
  // PRE-RENAME spellings are stripped too: a command written by an older
  // server (or an older CLI) must not end up carrying two --mode flags.
  const stripped = cmd.replace(/\s--mode\s+(chat|agent|do|deep)\b/g, '');
  if (mode !== 'chat') return stripped;
  // Insert AFTER any --backend selector and before --model/--resume/--pick.
  // This exact ordering is load-bearing: ws.ts's self-heal rewrite composes
  // the same shape and compares the result to the stored command to decide
  // "is this a reconnect or a new runner" — a different flag order would read
  // as a new runner on every hello and re-flip the pane's face.
  const head = stripped.match(/^muxpad agent(?:\s--backend\s+(?:claude|codex|cursor))?/)?.[0];
  if (!head) return stripped;
  return `${head} --mode chat${stripped.slice(head.length)}`;
}

/**
 * Read the mode back OUT of a startup command, accepting the pre-rename
 * spellings. Returns null when the command carries no `--mode` flag at all —
 * which is NOT the same as Agent mode: "the caller said nothing" and "the
 * caller said baseline" are different answers, and only the first one may be
 * overridden by a default.
 */
export function modeFromStartupCmd(cmd: string | null | undefined): AgentMode | null {
  const m = cmd?.match(/\s--mode\s+(\S+)/);
  return m ? coerceAgentMode(m[1]) : null;
}

/**
 * The one-time mid-session switch note, prepended (delimited) to the next
 * user message. Distinct tag from <muxpad-instructions> so the model can tell
 * "muxpad's standing instructions" from "your contract just changed".
 *
 * Switching TO Chat mode carries the full contract (the live session's system
 * prompt has none). Switching to Agent mode just revokes it — the baseline is
 * the absence of the overlay, so there is nothing to restate.
 */
export function wrapModeNote(mode: AgentMode, overlay: string | null): string {
  const body =
    mode === 'chat'
      ? overlay
        ? `The user switched this session to Chat mode. Follow this contract from now on:\n\n${overlay.trim()}`
        : 'The user switched this session to Chat mode: be decisive, act on reasonable assumptions, delegate legwork to subagents, reply in at most 3 sentences, result first with no narration, and ask only when truly blocked on something hard to reverse.'
      : 'The user switched this session to Agent mode. Any previous Chat-mode contract (terse, result-only, act-without-asking) no longer applies — resume your normal, thorough default behavior.';
  return `<muxpad-mode>\n${body}\n</muxpad-mode>`;
}
