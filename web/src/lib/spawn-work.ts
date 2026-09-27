import type { ChatEvent } from '@muxpad/shared';

/**
 * THE WORK ITSELF — what the spawn report's summary is an index TO.
 *
 * "if I just got a summary of it I'd be bummed that I lost everything. I think
 * the summary when it shows should have an expand button to show the archived
 * sub-chat or something."
 *
 * A research worker produces 25 KB and a published url; three sentences
 * REPLACING that is a loss. So the card expands, and this is where the expansion
 * comes from.
 *
 * ─── IT IS NOT ON THE ROW, AND MUST NOT BE ────────────────────────────────────
 * The summary rides the child's tab row, which is published on every sidebar
 * list, every `tab.updated` and `/api/tabs/all` — so a 25 KB report there would
 * be 25 KB × every tab on every 5 s poll, and it would land in the `@` picker's
 * corpus too. The work is therefore FETCHED, once, when the reader asks for it,
 * from an endpoint that already exists:
 *
 *   GET /api/agent-sessions/:paneId/transcript?tail=N
 *
 * which serves the last N NORMALIZED events as JSONL whatever the backend, and
 * still answers for a RETIRED child — the `agent_sessions` row is durable and
 * the JSONL is on disk; retiring a chat removes neither.
 *
 * ─── WHAT "THE WORK" IS: the child's FINAL TURN ───────────────────────────────
 * Walk the tail backwards and collect assistant prose until the previous user
 * message. That is the last thing the worker said, which for a worker IS the
 * report — everything before it is the working-out, and the link in the card's
 * head is how you go and read that.
 *
 * Bounded by a TURN BOUNDARY rather than a character count, which is what makes
 * the bound honest: `SPAWN_WORK_MAX_CHARS` is a backstop for a pathological turn
 * and, when it bites, it SAYS SO (`truncated`) instead of quietly ending
 * mid-sentence. Truncating silently is the `HEADLINE_MAX_CHARS` mistake — you
 * cannot tell whether the part that was cut was the part you wanted.
 */

/** Events asked of the endpoint. A final turn of prose plus its tool calls sits
 *  well inside this; the server clamps at 1000 and bounds the byte read anyway. */
export const SPAWN_WORK_TAIL = 400;

/**
 * Backstop on the expanded body.
 *
 * NOT the design bound — the turn boundary is. This exists so one worker that
 * printed a megabyte of log into its last message cannot make the parent's
 * conversation unscrollable, and it announces itself when it fires.
 */
export const SPAWN_WORK_MAX_CHARS = 8_000;

/** What an expansion resolved to. `gone` is a real, permanent outcome: Claude
 *  prunes its own transcripts on a retention window, so an old worker's work
 *  WILL eventually be unreadable — and the summary on the row is then the only
 *  surviving trace, which is an argument for the summary, not against this. */
export type SpawnWork =
  | { kind: 'work'; text: string; truncated: boolean }
  | { kind: 'gone'; reason: string };

/**
 * The child's final turn, as prose.
 *
 * Pure, and separately tested, because it is the half that can be wrong: "the
 * last thing it said" is a walk backwards over a normalized event list, and the
 * failure modes (picking up the previous turn, dropping the last message, losing
 * the order) are all invisible in a fetch test.
 *
 * Tool calls and thinking are skipped — the expansion is what the worker SAID,
 * and its actions are in the sub-chat itself, one click away through the head.
 */
export function finalTurnText(events: readonly ChatEvent[]): {
  text: string;
  truncated: boolean;
} {
  const said: string[] = [];
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i] as ChatEvent;
    // The turn boundary. A worker's task arrived as a user message, so the first
    // one walking back is where its answer began.
    if (e.kind === 'user') break;
    if (e.kind !== 'assistant' || !e.text?.trim()) continue;
    said.unshift(e.text.trim());
  }
  // Blank line between messages: a turn that streamed in several assistant
  // messages is several paragraphs, and joining them with a newline would glue a
  // heading onto the paragraph above it once markdown renders.
  const joined = said.join('\n\n');
  if (joined.length <= SPAWN_WORK_MAX_CHARS) return { text: joined, truncated: false };
  return { text: joined.slice(0, SPAWN_WORK_MAX_CHARS), truncated: true };
}

/** Parse the endpoint's JSONL. A torn last line is skipped, never thrown on —
 *  the file is being appended to while we read it. */
export function parseTranscriptJsonl(body: string): ChatEvent[] {
  const out: ChatEvent[] = [];
  for (const line of body.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as ChatEvent);
    } catch {
      // A partial line at the end of the stream.
    }
  }
  return out;
}

/**
 * Fetch one worker's final turn.
 *
 * Tries the chat's panes in order, exactly as `directTo` does, and for the same
 * reason: most chats have one pane, a split with a terminal beside the agent
 * costs a second request, and a 404 means "not the agent pane" rather than an
 * error worth showing.
 *
 * NEVER returns an empty success. An expansion that opens onto nothing is the
 * one outcome this must not produce — it reads as "the work is gone" while
 * claiming to have found it — so an empty final turn is reported as `gone`, with
 * the card offering the link onward.
 *
 * Deliberately a bare `fetch` and not `req`: the response is JSONL, and `req`
 * parses JSON.
 */
export async function fetchSpawnWork(paneIds: readonly string[]): Promise<SpawnWork> {
  let lastReason = 'this worker has no transcript on this machine any more';
  for (const paneId of paneIds) {
    let body: string;
    try {
      const res = await fetch(
        `/api/agent-sessions/${encodeURIComponent(paneId)}/transcript?tail=${SPAWN_WORK_TAIL}`,
      );
      if (!res.ok) continue;
      body = await res.text();
    } catch {
      lastReason = "couldn't reach the server for this worker's transcript";
      continue;
    }
    const { text, truncated } = finalTurnText(parseTranscriptJsonl(body));
    if (!text) continue;
    return { kind: 'work', text, truncated };
  }
  return { kind: 'gone', reason: lastReason };
}
