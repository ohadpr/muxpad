// Agent backends a pane can run. Mirrors the server's BackendId allowlist.
export type AgentBackendId = 'claude' | 'codex' | 'cursor';

/** The picker's agent choices, in display order. */
export const AGENT_BACKENDS: ReadonlyArray<{ id: AgentBackendId; label: string }> = [
  { id: 'claude', label: 'Claude' },
  { id: 'codex', label: 'Codex' },
  { id: 'cursor', label: 'Cursor' },
];

/**
 * LEGACY: a pane created before the chooser was retired, still idling with no
 * harness chosen. Nothing creates these any more — a new tab opens straight
 * into the house chat — but panes already in this state must keep rendering
 * their picker, so the marker stays recognised.
 *
 * Matched as a FLAG rather than by whole-string equality: the command may
 * carry other flags around it.
 */
export function isPendingHarnessPick(startupCmd: string | null | undefined): boolean {
  return /(^|\s)--pick(\s|$)/.test(startupCmd ?? '');
}

/**
 * "The house chat" — what a new tab opens as, and the only thing the `+`
 * button ever creates.
 *
 * It is an ordinary Claude agent pane with two deliberate properties:
 *  - NO `--model` flag, so it runs whatever Claude's own default is. Pinning
 *    a model here would silently override the account/settings default and
 *    quietly go stale as models ship.
 *  - the HOUSE overlay (`mode: 'do'` — the <dataDir>/do-mode.md contract),
 *    which is what makes it terse, decisive and delegation-minded.
 *
 * `mode` is internal plumbing. The UI never says "do" or "deep"; it offers
 * the house chat by default and "open instead: Claude · Codex · Cursor" for
 * a RAW session — the harness exactly as it ships, capabilities injection
 * only, no house contract. That's the whole vocabulary.
 */
export const HOUSE_CHAT_CREATE = {
  bootstrap: 'agent',
  backend: 'claude',
  mode: 'do',
} as const;

/** Same, as a pane-create body (a pane inside an existing tab). */
export const HOUSE_CHAT_PANE_CREATE = {
  startup_cmd: 'muxpad agent --mode do',
  face: 'chat',
  mode: 'do',
} as const;
