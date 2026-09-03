import { ApiError } from '../api';

// Agent backends a pane can run. Mirrors the server's BackendId allowlist.
export type AgentBackendId = 'claude' | 'codex' | 'cursor';

/**
 * How a failed conversion should be reported.
 *
 * `refused` separates the server saying NO from anything going wrong. The
 * server refuses a conversion on a chat that already has messages (409), and
 * that answer has two consequences the UI must not conflate with a network
 * blip: our "this chat is empty" belief is WRONG and must be corrected, and the
 * explanation must STICK — correcting the belief instantly re-routes the empty
 * state to its "loading conversation" branch, which is how the message used to
 * get set and thrown away in the same tick, leaving a spinner where an
 * explanation belonged.
 */
export interface ConversionFailure {
  message: string;
  /** 409: the server declined on the merits. Not an error to retry. */
  refused: boolean;
  /**
   * The server says this chat is NOT empty (`has_messages`), so our render is
   * wrong and the offer must retire. Deliberately narrower than `refused`: a
   * `mid_turn` refusal means the chat really is empty and the offer should
   * come back when the turn ends — treating it as "has messages" would leave a
   * genuinely empty chat spinning on "Loading conversation…" that will never
   * load anything.
   */
  hasMessages: boolean;
}

export function conversionFailure(e: unknown, fallback: string): ConversionFailure {
  const refused = e instanceof ApiError && e.status === 409;
  return {
    message: e instanceof Error && e.message ? e.message : fallback,
    refused,
    hasMessages: refused && (e as ApiError).code === 'has_messages',
  };
}

/** The picker's agent choices, in display order. */
export const AGENT_BACKENDS: ReadonlyArray<{ id: AgentBackendId; label: string }> = [
  { id: 'claude', label: 'Claude' },
  { id: 'codex', label: 'Codex' },
  { id: 'cursor', label: 'Cursor' },
];

/** Display name for a backend id. One table — AGENT_BACKENDS — so the picker,
 *  the launch card and the confirmation can never disagree about the name. */
export function backendLabel(id: AgentBackendId): string {
  return AGENT_BACKENDS.find((b) => b.id === id)?.label ?? id;
}

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
 * "The house chat" — what a new tab opens as, everywhere.
 *
 * ONE default, no exceptions. Four different buttons used to say "+ New tab"
 * and three of them quietly made a plain terminal instead: the sidebar's
 * per-workspace `+` opened the house chat, while "new workspace", the
 * empty-workspace button and the first-run bootstrap opened a shell. Which `+`
 * you happened to press decided what you got, and nothing in the UI said so —
 * the live install had 18 `deep` panes against 5 `do` ones as a direct result.
 * Every one of those call sites now uses THIS constant.
 *
 * A terminal is still one tap away, but it is now a LABELLED choice: the empty
 * chat's "or open instead" strip offers Terminal and Web view explicitly. The
 * rule is: creating is never a question, and changing your mind is always
 * visible.
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
