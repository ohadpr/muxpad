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
 *
 * ── TWO POPULATIONS, AND THE NUMBER ONLY EVER MEANT ONE ─────────────────────
 * Observed: the cell read `5 agents` while the sidebar showed 2 rows, and the
 * sidebar was right — of five workers spawned, three had finished. The question
 * that came back was "do the 5 agents count some additional primitive that
 * doesn't show up in the sidebar?", and THAT IT HAD TO BE ASKED IS THE BUG.
 *
 * It could be asked because the roster this cell sizes is a UNION of two
 * different things:
 *
 *   CHILD CHATS      panes muxpad spawned. They are rows in the sidebar, they
 *                    have a workspace and a slug, you can navigate to one.
 *   HARNESS SUBAGENTS the Task/Agent fan-out inside a single turn. They are not
 *                    panes, have no row anywhere, and cannot be visited.
 *
 * `agentCount` was `roster.length` — the two added together — and the word
 * "agents" then silently meant whichever mix happened to be running. A reader
 * comparing it against the sidebar is comparing against the child-chat half
 * alone, so any subagent at all makes the two disagree by construction.
 *
 * THE NUMBER IS NOW THE CHILD CHATS, full stop, so it equals the rows the
 * sidebar draws — one predicate (`childIsRunning`), one population, no
 * reconciling to do. Subagents are still reported, because they are real work
 * and the cell exists to say something is running, but they are reported as
 * THEMSELVES in a term of their own. The label can be longer than it was in the
 * mixed case; it can no longer be wrong, and a truncated `2 agents · …` still
 * beats a confident `5 agents`. (The full string rides `title`/`aria-label`.)
 *
 * NOTE f8ce795 is not this fix. It corrected the child-chat half — from "chats
 * that exist" to "chats that work" — and left the union in place, which is why
 * the cell was still over-reporting afterwards.
 */
export function liveStatusLabel(opts: {
  /** Child chats actually running — `runningChildren`, the sidebar's own set. */
  chats: number;
  /** Harness subagents in this turn's roster. A different population. */
  subagents?: number;
  turnActive?: boolean;
}): string | null {
  const { chats, subagents = 0, turnActive = false } = opts;
  const parts: string[] = [];
  // Chats first: they are the ones with rows to compare against, so the number
  // a reader checks against the sidebar is the one they read first.
  if (chats > 0) parts.push(`${chats} agent${chats === 1 ? '' : 's'}`);
  if (subagents > 0) parts.push(`${subagents} subagent${subagents === 1 ? '' : 's'}`);
  // Either population beats "Working…": it is strictly more informative, and it
  // is the one that opens a roster.
  if (parts.length > 0) return parts.join(' · ');
  return turnActive ? 'Working…' : null;
}

/**
 * What the TRANSCRIPT's working row says — the dots at the foot of the log.
 *
 * ── IT LIVES HERE SO THE TWO LABELS CANNOT SAY THE SAME THING ──────────────
 * Reported as "this double working indication is a bit annoying": the row above
 * the composer read `Working…` and the row in the log read `Working…`, a
 * hundred pixels apart. They were two ternaries in two files with nothing
 * connecting them, which is the whole reason it happened.
 *
 * They are not redundant surfaces — each answers something the other cannot,
 * and `liveStatusLabel` above already records the division:
 *
 *   THE BAR      is FIXED. It survives scrolling away, it survives text
 *                streaming, and it carries the agent/subagent counts. It is
 *                where "is this pane busy" lives, and it keeps the word.
 *   THIS ROW     is POSITIONAL. It sits where the reply will appear, and it is
 *                the only thing that can name the tool currently running.
 *
 * So this returns the tool and NOTHING ELSE. The animated dots already say
 * "something is coming, here" — that is what dots mean in every chat ever
 * built, and the row carries `aria-label="<assistant> is working"` for anyone
 * not reading them. Repeating the bar's word underneath them adds no fact.
 *
 * THE TOOL NAME IS NOT OPTIONAL, and it is why this is a label rather than a
 * deletion. Bare dots read as "maybe stuck" during a long silent tool call,
 * which is exactly when a reader starts wondering — and the bar has a 180px
 * width budget it cannot spend on `Running some_long_tool_name…`. Naming the
 * oldest unresolved tool is the one thing only this row can do, so it is the
 * only thing it says.
 */
export function workingRowLabel(toolName: string | null | undefined): string | null {
  return toolName ? `Running ${toolName}…` : null;
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
