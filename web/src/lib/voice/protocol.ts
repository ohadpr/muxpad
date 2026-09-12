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
  | SessionErrorEvent
  | UnknownInboundEvent;

/** The acknowledgement for an append. Carries `client_event_id` when we
 *  stamped one, which is what lets a rejected append be named rather than
 *  merely counted. */
export const APPEND_ACK_TYPES = new Set([
  'session.thinking.appended',
  'session.commentary.appended',
  'session.instructions.appended',
]);

export function isAppendAck(e: InboundEvent): boolean {
  return APPEND_ACK_TYPES.has(e.type);
}

/**
 * THE PAYLOAD FIELD IS `content`. NOT `text`.
 *
 * This one word was the whole feature. Both append verbs shipped sending
 * `text`, and the API answered EVERY one of them with
 *
 *   {"type":"error","error":{"code":"missing_required_parameter",
 *    "message":"Missing required parameter: 'content'.","param":"content"}}
 *
 * — on the data channel, where nothing was listening (see
 * {@link SessionErrorEvent}). So the session looked perfect from every angle we
 * could see: transcripts flowed, delegations were claimed, requests reached the
 * agent, appends were "sent" — and not one of them ever reached the model, so
 * the agent's answers were never spoken. Verified against a live session; the
 * same append with `content` is acknowledged and read aloud.
 */

/** Silent progress. The model folds it into its understanding of the world
 *  without speaking it, so it is the right place for "the agent started",
 *  the request we dispatched, and anything derived from Chat mode's PRIVATE
 *  scratchpad — which must never be spoken. */
export interface ThinkingAppend {
  type: 'session.thinking.append';
  /** Ours to choose. Echoed back on any `error` as `client_event_id`. */
  event_id?: string;
  delegation_id: string;
  content: string;
}

/** Spoken. Multiple appends per delegation are explicitly supported, and that
 *  is the mechanism for narrating an agent over the minutes it works. */
export interface CommentaryAppend {
  type: 'session.commentary.append';
  /** Ours to choose. Echoed back on any `error` as `client_event_id`. */
  event_id?: string;
  delegation_id: string;
  content: string;
}

export type OutboundEvent = ThinkingAppend | CommentaryAppend;

/**
 * An append we sent was refused, or the session itself faulted.
 *
 * THIS EXISTS BECAUSE IT WAS MISSING. The client parsed every inbound event and
 * silently discarded anything it did not recognise, which included `error` —
 * so a protocol mistake that rejected 100% of our appends produced no log line,
 * no counter and no UI. An error channel nobody reads is the same as no error
 * channel at all.
 */
export interface SessionErrorEvent {
  type: 'error';
  error: {
    type?: string;
    code?: string;
    message?: string;
    param?: string;
    /** The `event_id` WE put on the offending client event, when we set one. */
    client_event_id?: string;
  };
}

export function isSessionError(e: InboundEvent): e is SessionErrorEvent {
  const err = (e as SessionErrorEvent).error;
  return e.type === 'error' && !!err && typeof err === 'object';
}

/** One line, safe to log, never empty. */
export function describeSessionError(e: SessionErrorEvent): string {
  const { code, message, param, client_event_id } = e.error;
  const parts = [message || code || 'unspecified error'];
  if (param) parts.push(`(param: ${param})`);
  if (client_event_id) parts.push(`[for ${client_event_id}]`);
  return parts.join(' ');
}

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
