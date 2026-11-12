import { collectLayoutLeaves } from './layout.js';
import { BASELINE_AGENT_MODE, type LayoutNode, coerceAgentMode } from './types.js';

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
 * Does this tab offer a SECOND thing — should any surface show a `+` in it?
 *
 * No, never, for any tab. It used to say yes for a tab holding a terminal (two
 * shells side by side was a real layout) and for an empty one, and that was the
 * last door into a two-pane tab: the web created the pane, then wrote the split
 * layout itself, and the server's refusal only covered the CLI's path. A tab is
 * one chat, agent or terminal now, and the server refuses the second one on
 * every route (routes/panes.ts, routes/tabs.ts). An empty tab gets its first
 * thing from its own empty state, not from a `+`.
 *
 * Kept as a function rather than deleted because the server still publishes it
 * as `takes_panes` on every tab, and a client that reads that field should be
 * told the truth rather than nothing.
 */
export function tabTakesPanes(_panes: readonly AgentPaneLike[]): boolean {
  return false;
}

/**
 * ONE THING PER TAB — the refusal every "add a second thing here" route gives.
 *
 * Code `conflict` (409), unchanged from when only the CLI's placement path
 * refused; the sentence is what a person reads.
 */
export const ONE_THING_PER_TAB =
  'a tab holds one chat or terminal — the split was removed. Open a new one instead.';

/**
 * Does this tab already hold its one thing?
 *
 * Read off the LAYOUT, filtered to pane rows that still exist in the tab, not
 * off the row count, for two reasons. A leaf naming a pane that is gone (a row
 * deleted while its layout write was pending) holds nothing, and must not lock
 * the tab out of ever getting its first chat back. And a document's backing
 * tab deliberately keeps one agent row per block with NO layout at all
 * (web/src/lib/doc-store.ts) — it never renders as a tab, so it is not one
 * thing on screen pretending to be two.
 */
export function tabIsOccupied(layout: LayoutNode, paneIdsInTab: readonly string[]): boolean {
  const rows = new Set(paneIdsInTab);
  return collectLayoutLeaves(layout).some((id) => rows.has(id));
}

/** A layout that puts two things side by side. Never written any more. */
export function isSplitLayout(layout: LayoutNode): boolean {
  return typeof layout === 'object' && layout !== null;
}
