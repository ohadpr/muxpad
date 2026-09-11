// THE WIRE, from the browser's side of voice mode.
//
// Three protocols meet in this folder and it is worth being explicit about
// which is which, because they are easy to blur:
//
//   1. OpenAI's realtime events, over a WebRTC data channel labelled exactly
//      `oai-events`. Audio does NOT travel here — it rides the peer
//      connection's media tracks, negotiated by SDP. This channel carries
//      transcripts, delegations, and the two append verbs we answer with.
//   2. muxpad's `/api/voice/*` REST endpoints, which do a ONE-SHOT SDP
//      exchange and nothing else. No audio, ever, touches muxpad's server.
//   3. muxpad's existing `/ws/chat/:paneId` socket — how the voice layer
//      reaches the agent. Voice adds no new path to Claude; it speaks the
//      same `{t:'send'}` the composer does.
//
// ONLY DOCUMENTED EVENT NAMES APPEAR HERE. It is tempting to invent an
// `output_audio.started` to drive a "speaking" light, and there is no such
// event in the contract we were handed, so the UI derives speaking from
// output transcript deltas instead (see session.ts). Guessing a name gets you
// a light that never lights and an echo gate that never arms, both of which
// fail silently.

/** The data-channel label. Exact, and not configurable — the remote peer
 *  opens nothing and answers nothing on any other label. */
export const OAI_EVENT_CHANNEL = 'oai-events';

/** Per-append token budget the model imposes on both append verbs. Text over
 *  this is split across several appends (chunk.ts), never truncated. */
export const APPEND_TOKEN_CAP = 500;

/** Which side of the conversation a transcript delta describes. */
export type TranscriptChannel = 'input' | 'output';

/**
 * One transcript fragment.
 *
 * There is NO item id and NO turn-completed event, which is the whole reason
 * transcript.ts exists: utterance boundaries have to be inferred from the
 * timestamps, and `offset_ms` on a delegation is the only key that joins a
 * delegation back to the speech that caused it.
 */
export interface TranscriptDeltaEvent {
  type: 'session.input_transcript.delta' | 'session.output_transcript.delta';
  delta: string;
  start_ms: number;
  end_ms: number;
}

/** The model asking the client to go do something. METADATA ONLY — there is
 *  no task text in here, and it can land before the sentence that prompted it
 *  has finished transcribing. */
export interface DelegationCreatedEvent {
  type: 'session.delegation.created';
  event_id: string;
  offset_ms: number;
  delegation: { id: string; target: 'client' | string };
}

/** The handshake is complete and the session will now accept events. Nothing
 *  may be sent before this arrives, and `session.start` is never sent at all
 *  — the session is already started by the time we see this. */
export interface SessionStartedEvent {
  type: 'session.started';
  [k: string]: unknown;
}

export interface UnknownInboundEvent {
  type: string;
  [k: string]: unknown;
}

export type InboundEvent =
  | SessionStartedEvent
  | TranscriptDeltaEvent
  | DelegationCreatedEvent
  | UnknownInboundEvent;

/** Silent progress. The model folds it into its understanding of the world
 *  without speaking it, so it is the right place for "the agent started",
 *  heartbeats on long work, and anything derived from Chat mode's PRIVATE
 *  scratchpad — which must never be spoken. */
export interface ThinkingAppend {
  type: 'session.thinking.append';
  delegation_id: string;
  text: string;
}

/** Spoken. Multiple appends per delegation are explicitly supported, and that
 *  is the mechanism for narrating an agent over the minutes it works. */
export interface CommentaryAppend {
  type: 'session.commentary.append';
  delegation_id: string;
  text: string;
}

export type OutboundEvent = ThinkingAppend | CommentaryAppend;

/** What the session wants said or noted, before a delegation id is stamped on
 *  it and before it is chunked. The bridge that turns chat frames into these
 *  is pure precisely because this type carries no ids and no transport. */
export interface AppendIntent {
  kind: 'thinking' | 'commentary';
  text: string;
}

export function isTranscriptDelta(e: InboundEvent): e is TranscriptDeltaEvent {
  return (
    (e.type === 'session.input_transcript.delta' || e.type === 'session.output_transcript.delta') &&
    typeof (e as TranscriptDeltaEvent).delta === 'string'
  );
}

export function channelOf(e: TranscriptDeltaEvent): TranscriptChannel {
  return e.type === 'session.input_transcript.delta' ? 'input' : 'output';
}

export function isDelegationCreated(e: InboundEvent): e is DelegationCreatedEvent {
  const d = (e as DelegationCreatedEvent).delegation;
  return (
    e.type === 'session.delegation.created' &&
    !!d &&
    typeof d === 'object' &&
    typeof d.id === 'string'
  );
}
