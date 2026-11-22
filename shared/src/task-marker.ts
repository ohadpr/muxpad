/**
 * A TASK CONTINUATION — the message muxpad sends a chat that said it was not
 * finished.
 *
 * ─── WHY THERE IS A MARKER AT ALL ───────────────────────────────────────────
 * Same reason the cron fire has one: a message that arrives in a conversation
 * without saying where it came from is read as the user's, and an agent that
 * thinks the human just spoke behaves differently — it answers rather than
 * continues, and the chat marks unread for a line nobody wrote. The marker is
 * one string so the instruction to the agent and the render hook the client
 * keys on cannot drift apart.
 *
 * ─── WHAT A CONTINUATION IS NOT ─────────────────────────────────────────────
 * It is not a second agent reviewing the first. muxpad does not ask a model
 * whether the work is done; the chat ITSELF declared the task, its acceptance
 * criteria and its next step, and the server only observes that the record is
 * still open and hands the chat its own words back. The judgement stays in the
 * one loop that has the context — a separate judge would need the whole
 * conversation to say anything useful, and would be wrong in exactly the cases
 * where it mattered.
 */
export interface TaskMarker {
  /** The durable task id. Matched on this, never on the (editable) request. */
  id: string;
  /** Which continuation this is, 1-based, for the agent and for the log. */
  attempt: number;
  /** The cap, so the message can say how much rope is left. */
  limit: number;
}

const TASK_OPEN = /^\s*<muxpad-task\b([^>]*)>([\s\S]*?)<\/muxpad-task>\s*/;

function attr(attrs: string, name: string): string | null {
  const m = attrs.match(new RegExp(`\\b${name}="([^"]*)"`));
  return m ? (m[1] as string) : null;
}

/**
 * The continuation, marker and body in one string.
 *
 * The body is deliberately the chat's OWN record read back to it — request,
 * criteria, next step — rather than an instruction invented here. Two reasons:
 * a server that paraphrases the goal is a second author of the goal, and an
 * agent handed its own acceptance criteria can check itself against them,
 * which is the whole mechanism by which this ends.
 */
export function renderTaskContinuation(
  marker: TaskMarker,
  task: { request: string; criteria: string | null; next_step: string | null },
): string {
  const lines = [
    `<muxpad-task id="${marker.id}" attempt="${marker.attempt}" limit="${marker.limit}">`,
    `Not a human. muxpad is handing you back a task YOU declared open — continuation ${marker.attempt} of at most ${marker.limit}.`,
    '</muxpad-task>',
    '',
    'You ended a turn with this task still open:',
    '',
    `**The request:** ${task.request}`,
  ];
  if (task.criteria) lines.push('', `**Done when:** ${task.criteria}`);
  if (task.next_step) lines.push('', `**Your own next step was:** ${task.next_step}`);
  lines.push(
    '',
    'Carry on with it now. Three ways this ends, and you choose:',
    '',
    `- it is finished → \`muxpad task done ${marker.id} --evidence="<what proves it>"\``,
    `- you are genuinely stuck on something only the user can settle → \`muxpad task block ${marker.id} --why="<the question>"\``,
    `- still going → \`muxpad task next ${marker.id} "<the next concrete step>"\` and keep working.`,
    '',
    'RECORDING PROGRESS IS WHAT BUYS THE NEXT CONTINUATION: if the task looks',
    'untouched since this message, it stops being handed back rather than being',
    'asked again. Nothing here overrides Stop, or a question you have already',
    'put to the user.',
  );
  return lines.join('\n');
}

/** Split a delivered continuation back into its marker and body. Null for
 *  ordinary text, including text that merely mentions the tag mid-message —
 *  only a leading block is one muxpad produced. */
export function parseTaskMarker(text: string): { marker: TaskMarker; body: string } | null {
  const m = text.match(TASK_OPEN);
  if (!m) return null;
  const attrs = m[1] ?? '';
  const id = attr(attrs, 'id');
  if (!id) return null;
  const attemptRaw = attr(attrs, 'attempt');
  const limitRaw = attr(attrs, 'limit');
  return {
    marker: {
      id,
      attempt: attemptRaw !== null && /^\d+$/.test(attemptRaw) ? Number(attemptRaw) : 1,
      limit: limitRaw !== null && /^\d+$/.test(limitRaw) ? Number(limitRaw) : 0,
    },
    body: text.slice(m[0].length),
  };
}
