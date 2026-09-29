/**
 * Labels for the session line — the quiet strip above the composer.
 *
 * Two of them, and they exist for the same reason: that line is ONE LINE at
 * 320px by construction, so every cell on it has a width budget. A label that
 * is longer than it needs to be does not overflow any more — it truncates the
 * cell beside it.
 */

/**
 * Collapsed label for the live cell of the composer status bar.
 *
 * ── IT REPORTS LIVENESS, NOT SUBAGENTS ──────────────────────────────────────
 * This used to take only `agentCount` and return null below one, on the stated
 * reasoning that "parent-turn busy state lives in the transcript Working… row,
 * not here". The consequence, reported: the status bar shows something running
 * ONLY when subagents happen to exist, so an ordinary turn — the common case —
 * left the bar looking idle while the sidebar row for the same pane said
 * `working`.
 *
 * Three surfaces report whether a pane is busy: the sidebar row (from the
 * server's `status`), the transcript's Working… row, and this bar. Two agreed
 * and this one was silent, which reads as a bug rather than as restraint. And
 * the transcript row is not a substitute — it scrolls away with the content,
 * while the bar is fixed and is where the session's state-at-a-glance lives
 * next to its mode, folder and model.
 *
 * So the contract is now the name: null means NOTHING is running. A turn with
 * no subagents is still a turn.
 */
export function liveStatusLabel(opts: { agentCount: number; turnActive?: boolean }): string | null {
  const { agentCount, turnActive = false } = opts;
  // Subagents win the label when they exist: "3 agents" is strictly more
  // informative than "Working…", and it is the one that opens a roster.
  if (agentCount > 0) return `${agentCount} agent${agentCount === 1 ? '' : 's'}`;
  return turnActive ? 'Working…' : null;
}

/**
 * Is this child chat RUNNING, right now?
 *
 * ── ONE QUESTION, ONE ANSWER, AND IT IS THE SIDEBAR'S ──────────────────────
 * Three surfaces reported on the same four children of `muxpad` and gave three
 * answers. Measured against the database:
 *
 *   child           retired_at   the bar   sidebar   pane status
 *   status-line     NULL         busy      spinner   working
 *   artifact-urls   NULL         busy      —         idle
 *   xws-build       NULL         busy      —         DEAD
 *   new-chat-fix    NULL         busy      —         idle
 *
 * The bar said four. One was running. It had been counting every child with
 * `retired_at IS NULL`, and RETIREMENT IS A LIFECYCLE FACT — "has this chat left
 * the live list" — not a liveness one. A worker that finished its turn and is
 * waiting is unretired; a worker whose runner died is unretired. `xws-build` was
 * literally dead while the bar advertised it as an agent at work.
 *
 * The pane's `status` is the only field that answers "is this working": for a
 * runner-owned pane it is the runner's own registry, which is why the sidebar
 * spins on it. So it is the source here too, and the bar now reads what the
 * sidebar reads.
 *
 * WHY `blocked` IS NOT RUNNING. It means the child stopped to ask YOU something
 * — the opposite of working, and the sidebar draws it as a dot rather than a
 * spinner for exactly that reason. Counting it here would put a spinner and the
 * words "1 agent" on a chat that is waiting on you and will wait forever.
 * `StateChip`'s rule is the definition; ChatPane.liveset.test.tsx derives the
 * expected set by rendering that component rather than restating it, so if the
 * rule ever changes this predicate is forced to follow.
 *
 * WHY AN ABSENT STATUS IS NOT RUNNING. A row from a server too old to report one
 * tells us nothing, and no evidence of running is not evidence of running. The
 * opposite default is precisely what produced four phantom agents.
 */
export function childIsRunning(chat: { status?: string | null | undefined }): boolean {
  return chat.status === 'working';
}

/** The children actually at work — the set behind the number above the composer. */
export function runningChildren<T extends { status?: string | null | undefined }>(
  kids: readonly T[],
): T[] {
  return kids.filter(childIsRunning);
}

/** The families we are willing to rename. Anything else is left alone. */
const CLAUDE_FAMILIES: Record<string, string> = {
  opus: 'Opus',
  sonnet: 'Sonnet',
  haiku: 'Haiku',
  fable: 'Fable',
};

/**
 * Model label for the session line: `claude-opus-5` → `Opus 5`.
 *
 * The line read `Agent · muxpad · claude-opus-5 · 25% · 2 agents` and this was
 * its longest cell — thirteen characters of which the first seven say "Claude"
 * to a reader who is already looking at the Claude logo rendered immediately to
 * its left. The vendor prefix and the release date are the two parts of a model
 * id carrying no information AT THAT SPOT, so they are what comes off.
 *
 * WHAT IT WILL NOT DO. It rewrites recognized `claude-<family>-<version>` ids
 * and nothing else:
 *   · a `displayName` the backend chose ("Opus", "Default") is a human's word,
 *     not an id — inventing a different one would be worse than long;
 *   · another vendor's id (`gpt-5-codex`) is returned verbatim, because we do
 *     not know which of its segments are noise;
 *   · an unfamiliar family (`claude-something-5`) is returned verbatim for the
 *     same reason.
 * The full, exact id is never lost: the session menu lists it under the model
 * row (`chat-model-id`) and the cell's tooltip carries it.
 */
export function sessionModelLabel(model: string): string {
  const parts = model.toLowerCase().split('-');
  if (parts.shift() !== 'claude') return model;
  const family = parts.find((p) => p in CLAUDE_FAMILIES);
  if (!family) return model;
  // Version segments are the bare numbers, minus a trailing release date —
  // `4`,`5` is a version; `20251001` is a build stamp nobody reads off a strip.
  const version = parts.filter((p) => /^\d+$/.test(p) && p.length < 4).join('.');
  const short = version ? `${CLAUDE_FAMILIES[family]} ${version}` : CLAUDE_FAMILIES[family];
  // A prettifier that LENGTHENS the string is the defect this exists to
  // prevent, so the comparison is the contract rather than a comment about it.
  return short && short.length <= model.length ? short : model;
}
