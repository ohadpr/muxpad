import { BASELINE_AGENT_MODE, coerceAgentMode } from './types.js';

/**
 * IS THIS PANE AN AGENT — one rule, for the server and the chrome alike.
 *
 * It exists because the answer decides what UI a tab gets, and the question was
 * being asked in two places that could drift: the pane chrome (which drew the
 * surface icon from it) and nothing else — everything else simply assumed every
 * tab was a box you could put more panes in.
 *
 * ── WHAT IT IS FOR ───────────────────────────────────────────────────────────
 * Splitting is a real layout tool for a TERMINAL or a WEB VIEW: two shells side
 * by side, a server's log next to the page it serves. For a CHAT it is not. A
 * chat's parallel work is another chat — a child, nested under it in the sidebar
 * and reporting back as a card — and a second agent stuffed into the same tab is
 * that same relationship with its provenance thrown away and half the rail's
 * vocabulary (a clock, a parent, a name) unavailable to it.
 *
 * It deliberately does NOT look at the agent MODE. Chat and Agent are the same
 * primitive wearing a different contract, and the user's own statement of it is
 * the standard this file is held to: "i don't want to care if its chat or agent
 * — no reason not to include the same primitive UI everywhere."
 *
 * ── THE TWO MARKERS ──────────────────────────────────────────────────────────
 * `startup_cmd` beginning `muxpad agent` is the DURABLE one: it is stored on the
 * row, so it survives a ptyd restart, a reboot and a dead runner (the same
 * marker TabStore's clock projection and PaneStore.listAgentPanes use). The
 * `chat` face covers the pane that was CONVERTED into an agent after creation,
 * whose startup command still says whatever it was launched with.
 */

/** The shape this rule needs — a subset of PaneSpec, so a test needs no row. */
export interface AgentPaneLike {
  startup_cmd?: string | null | undefined;
  face?: string | null | undefined;
}

export function isAgentPane(pane: AgentPaneLike | null | undefined): boolean {
  if (!pane) return false;
  return (pane.startup_cmd?.startsWith('muxpad agent') ?? false) || pane.face === 'chat';
}

/**
 * WHAT A PERSON CALLS THIS ROW — the one place that decides it.
 *
 * A sidebar row holds one thing, and the owner's own words for the three are
 * the vocabulary: "a chat, an agent or a terminal". "Pane" is how the server
 * stores the thing, not what it is, and every sentence that reached a person
 * with that word in it was the storage leaking into the product.
 *
 * Chat and Agent are the agent MODE, which is fixed at creation (no harness can
 * rewrite a live session's instructions), so it is a stable identity and not a
 * passing state. A row with no recorded mode reads as Agent for the reason
 * {@link BASELINE_AGENT_MODE} gives.
 *
 * `web view` is the honest fourth answer for a `kind: 'url'` row, a page with
 * no terminal behind it. None exist on the live install and the plan retires
 * them, but calling one a terminal would be the same kind of lie this replaces.
 */
export type RowNoun = 'chat' | 'agent' | 'terminal' | 'web view';

export interface RowNounLike extends AgentPaneLike {
  kind?: string | null | undefined;
  mode?: string | null | undefined;
}

export function rowNoun(pane: RowNounLike | null | undefined): RowNoun {
  if (pane?.kind === 'url') return 'web view';
  if (!isAgentPane(pane)) return 'terminal';
  return (coerceAgentMode(pane?.mode) ?? BASELINE_AGENT_MODE) === 'chat' ? 'chat' : 'agent';
}

/** {@link rowNoun} at the start of a sentence or as a stand-alone label. */
export function rowNounTitle(pane: RowNounLike | null | undefined): string {
  const noun = rowNoun(pane);
  return noun.charAt(0).toUpperCase() + noun.slice(1);
}

/**
 * The answer to "act on this row" when the row is not there.
 *
 * Seventeen routes said `pane not found`, and the web shows an error's message
 * as written. They now share this one sentence; the `code` beside it is what
 * any caller branches on, and that is untouched.
 */
export const ROW_NOT_FOUND = 'that chat or terminal no longer exists';

/**
 * Does this tab offer PANES — i.e. should its chrome show a `+` at all?
 *
 * ANY non-agent pane is enough. A tab holding a chat and a terminal is still a
 * tab you can put another terminal in, and taking the `+` away from it would be
 * hiding a working tool because of something else in the room. What loses the
 * `+` is the tab that is nothing but agents, which is every chat.
 *
 * An EMPTY tab keeps it: with nothing in it there is no chat to protect, and
 * "this tab has no panes" needs a way out.
 */
export function tabTakesPanes(panes: readonly AgentPaneLike[]): boolean {
  return panes.length === 0 || panes.some((p) => !isAgentPane(p));
}

/**
 * Should this tab paint a PANE STRIP at all?
 *
 * Removing the `+` was only half of "one pane per tab, except terminals". The
 * strip itself still painted unconditionally, so a one-pane chat — which is
 * every chat — carried a whole row of chrome for a concept that no longer
 * applied to it:
 *
 *   · a label naming the pane you are already looking at, under a sidebar row
 *     that already names the chat
 *   · a status mark that is a SECOND copy of the sidebar row's, which is the
 *     two-surfaces-deriving-one-value bug this branch is organised against
 *   · a × labelled "Close pane" whose only effect on a single-pane tab is to
 *     leave you an empty one (archive, on the sidebar row, is the real gesture)
 *   · "Expand to split" — of what? `tabTakesPanes` is already false, so there
 *     is no second pane to be had
 *
 * So the strip paints when it has a JOB: something to switch between, or
 * somewhere to add. A tab that takes panes keeps it even at one pane (that is
 * where the `+` lives), and an agent-only tab keeps it the moment it holds two,
 * because then the strip is the only way to get from one to the other.
 *
 * Stated here rather than in TabView so the desktop strip, the mobile bar and
 * any future surface cannot drift on it — the same reason `tabTakesPanes` is
 * here and not inlined at its two call sites.
 */
export function tabShowsPaneStrip(panes: readonly AgentPaneLike[]): boolean {
  return tabTakesPanes(panes) || panes.length > 1;
}
