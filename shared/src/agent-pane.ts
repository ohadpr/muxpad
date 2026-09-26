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
