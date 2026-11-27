/**
 * THE AUTOPILOT'S OWN VOICE, in the log.
 *
 * The anti-yield gate (server chat/yield-gate.ts) sends prods down the
 * ORDINARY send road on purpose — same durable queue, same drain, same Stop
 * button — which means they arrive in the transcript as user messages, in the
 * place the owner's own words appear. That is right for the agent and wrong
 * for the reader: "I would like to see these Ohad agentic messages in the
 * chat labeled with some color so I can follow what happened."
 *
 * So the bubble is split: a chip saying who spoke, and the instruction under
 * it in the accent — the same family as the cron chip, because this is
 * muxpad's machinery talking, not a person.
 *
 * Matched on the marker the server writes rather than on any metadata,
 * because the three inputs that reach a user bubble (the transcript, the
 * optimistic echo, the queued preview) carry nothing else in common.
 */
export const AUTOPILOT_MARK = '[muxpad autopilot';

export interface AutopilotNote {
  /** The bracketed line, without its brackets — what the chip says. */
  label: string;
  /** Everything after it: the instruction, the reason, the way to refuse. */
  body: string;
}

/**
 * Split a prod into its chip and its body, or `null` for an ordinary message.
 *
 * Deliberately strict about the SHAPE (the marker opens the text, and its
 * line closes with `]`) so that a person quoting the autopilot — which is
 * exactly what happens when somebody pastes one back to ask about it — does
 * not have their own message relabelled as machinery.
 */
export function splitAutopilot(text: string): AutopilotNote | null {
  if (!text.startsWith(AUTOPILOT_MARK)) return null;
  const close = text.indexOf(']');
  if (close < 0) return null;
  const label = text.slice(1, close).trim();
  if (!label) return null;
  return { label, body: text.slice(close + 1).trim() };
}
