import type { ChatEvent, SpawnRound } from '@muxpad/shared';

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
 * ─── WHAT "THE WORK" IS: the child's LAST MESSAGE ────────────────────────────
 * The single message it ended on, and nothing before it.
 *
 * This was the final TURN — every assistant message back to the previous user
 * message — and that was wrong in a way only real output shows. A worker
 * narrates as it works ("I'll start by reading the constraints doc", "Now the
 * core of item 1 —", "Now the scattered re-inks"), and all of it is ONE turn,
 * because one instruction started it. So "the final turn" was the entire story
 * of how the job was done: "way too verbose and contains the entire story".
 *
 * The last message is what it said when it was FINISHED — its answer, carrying
 * the counts, the conclusion and the paths inline. Everything before it is
 * working-out, and the working-out already has a home: the sub-chat itself, one
 * click away through the card's head.
 *
 * It still never reaches back past the last user message. A worker that ended on
 * a tool call or a question has said nothing since its task arrived, and the
 * message before THAT is an answer to something else.
 */

/** Events asked of the endpoint. A final turn of prose plus its tool calls sits
 *  well inside this; the server clamps at 1000 and bounds the byte read anyway. */
export const SPAWN_WORK_TAIL = 400;

/**
 * Backstop on the expanded body.
 *
 * NOT the design bound — one message is. This exists so a worker that printed a
 * megabyte of log into its last message cannot make the parent's conversation
 * unscrollable, and it announces itself when it fires.
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
 * The child's final answer — the last thing it said, bounded.
 *
 * Pure, and separately tested, because it is the half that can be wrong: every
 * way of mis-picking it looks the same on screen, and the expensive mistake
 * (taking the whole turn) reads as a feature until you see a real worker's
 * output in it.
 *
 * Tool calls and thinking are skipped on the way back — they are not something
 * it SAID — but a user message stops the walk outright.
 */
export function finalAnswer(events: readonly ChatEvent[]): {
  text: string;
  truncated: boolean;
} {
  let said = '';
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i] as ChatEvent;
    // The turn boundary. A worker's task arrived as a user message, so anything
    // past this belongs to a different question.
    if (e.kind === 'user') break;
    if (e.kind !== 'assistant' || !e.text?.trim()) continue;
    said = e.text.trim();
    break;
  }
  if (said.length <= SPAWN_WORK_MAX_CHARS) return { text: said, truncated: false };
  return { text: said.slice(0, SPAWN_WORK_MAX_CHARS), truncated: true };
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
export async function fetchSpawnWork(
  paneIds: readonly string[],
  round?: Pick<SpawnRound, 'started_at' | 'ended_at'>,
): Promise<SpawnWork> {
  let lastReason = round
    ? 'this round is outside the available transcript window'
    : 'this worker has no transcript on this machine any more';
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
    const events = parseTranscriptJsonl(body);
    // A pane endpoint serves the current session's tail. Never substitute a
    // later job when this round has aged out of that tail or the session rotated.
    const within = round
      ? events.filter(
          (e) =>
            round.ended_at !== null &&
            e.ts !== null &&
            e.ts >= round.started_at &&
            e.ts <= round.ended_at,
        )
      : events;
    const { text, truncated } = finalAnswer(within);
    if (!text) continue;
    return { kind: 'work', text, truncated };
  }
  return { kind: 'gone', reason: lastReason };
}
