import { type ChatEvent, normalizeTranscriptLine } from '@muxpad/shared';
import type Database from 'better-sqlite3';
import { AgentSessionStore } from '../store/AgentSessionStore.js';
import type { SpawnRound } from '../store/SpawnRoundStore.js';
import { findTranscript, identityNormalize, muxpadLocate } from './TranscriptReader.js';
import { readTailLines } from './has-messages.js';

/** Recover the last answer from THIS closure, including after a server restart.
 * Never use an earlier job's answer or commentary followed by unanswered work. */
export function readWorkerAnswer(
  db: Database.Database,
  paneId: string,
  round: SpawnRound | null,
): string | null {
  if (!round?.ended_at) return null;
  const session = new AgentSessionStore(db).getByPane(paneId);
  if (!session?.current_sid) return null;
  const path =
    (session.assistant === 'claude' ? findTranscript(session.current_sid) : null) ??
    muxpadLocate(session.current_sid);
  if (!path) return null;
  const normalize = session.assistant === 'claude' ? normalizeTranscriptLine : identityNormalize;
  const start = Math.max(round.started_at, round.reopened_at ?? 0);
  let answer: string | null = null;
  /** The last thing the worker actually SAID, as opposed to thought. */
  let spoken: string | null = null;
  try {
    for (const line of readTailLines(path, 64 * 1024)) {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }
      for (const event of normalize(value) as ChatEvent[]) {
        if (
          typeof event.ts !== 'number' ||
          !Number.isFinite(event.ts) ||
          event.ts < start ||
          event.ts > round.ended_at
        )
          continue;
        if (event.kind === 'user' || event.kind === 'tool_use') {
          answer = null;
          spoken = null;
        }
        if (event.kind === 'assistant' && event.text?.trim()) {
          // DELIBERATE SPEECH BEATS THINKING OUT LOUD.
          //
          // In Chat mode the agent's plain prose is a PRIVATE scratchpad and
          // the real answer is a `reply` tool call, which the normalizer marks
          // `voice: 'reply'` (or `'fallback'` when a turn a human was waiting
          // on ended without one). Taking "the last assistant text" therefore
          // delivered the worker's muttering to the parent chat as its report
          // — "Done, replied" written after the actual reply, or the
          // provider's own "You've hit your limit…" sentence.
          //
          // `'private'` cannot be used to spot the muttering: the CLIENT adds
          // it at render time and it is never written to disk. So the rule is
          // read off the data instead — if this round contains any deliberate
          // speech, only deliberate speech counts; a transcript with none is
          // Agent mode (or pre-voice), where plain prose IS the answer.
          if (event.voice === 'reply' || event.voice === 'fallback') spoken = event.text.trim();
          else answer = event.text.trim();
        }
      }
    }
  } catch {
    return null;
  }
  if (spoken) answer = spoken;
  // The delivery renderer applies the per-child budget. Keep enough for a useful
  // result without persisting unbounded transcript output; mark any clipping.
  return answer && answer.length > 8000 ? `${answer.slice(0, 7970)}… [report truncated]` : answer;
}
