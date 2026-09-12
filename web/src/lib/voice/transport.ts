// THE TRANSPORT SEAM — the reason any of this is testable.
//
// A real session is a peer connection, a microphone, an SDP round trip and a
// data channel. None of those exist in jsdom, and none of them can be exercised
// without an API key and a bill. So the session logic never touches WebRTC: it
// talks to a VoiceTransport, which in production is the peer connection below
// and in tests is an object with a `send` spy and an `emit` helper.
//
// The interface is deliberately tiny — send an event, subscribe to events,
// subscribe to state, close — because every method on it is a method a fake has
// to implement faithfully.
//
// ═══ THE CONNECT SEQUENCE, which is order-sensitive in three places ═══
//
//   1. getUserMedia MUST be called from a user gesture. Not "should" — Safari
//      rejects it outside one, and on iOS standalone the permission does not
//      reliably persist across launches, so this happens on every session.
//   2. The data channel MUST be created BEFORE the offer. SDP describes the
//      channel; create it after and you get an offer with no data section, a
//      connection that comes up, and a channel that never opens. The label is
//      exactly `oai-events` — nothing answers on any other.
//   3. ICE gathering MUST complete before the offer is POSTed. This is a
//      one-shot SDP exchange with no trickle path back, so a candidate that
//      arrives after the POST has nowhere to go.
//
// And one thing NOT to do: `audio.format` is never set and audio is never
// chunked, resampled or VAD'd. WebRTC negotiates the codec in the SDP. Every
// one of those knobs belongs to the WebSocket API, and setting them here is how
// you get silence.

import type { InboundEvent, OutboundEvent } from './protocol';
import { OAI_EVENT_CHANNEL } from './protocol';

export type TransportState = 'idle' | 'connecting' | 'open' | 'closed' | 'failed';

export interface VoiceTransport {
  readonly state: TransportState;
  /** Queueing is the transport's problem, not the session's — but note that
   *  the SESSION still waits for `session.started` before it sends anything,
   *  because an open data channel is not a started session. */
  send(event: OutboundEvent): void;
  onEvent(cb: (e: InboundEvent) => void): () => void;
  onState(cb: (s: TransportState, detail?: string) => void): () => void;
  close(): void;
}

/** Everything the WebRTC transport needs from the outside world, so a test can
 *  supply a fake and a browser can supply the real thing. */
export interface RtcTransportDeps {
  /** Trade our offer for the model's answer via muxpad's one-shot endpoint. */
  exchangeSdp(offer: string): Promise<{ sdp: string; sessionId: string }>;
  /** The already-granted microphone stream, captured in a user gesture by the
   *  caller — NOT here, because by the time this function runs the gesture is
   *  over and Safari has stopped trusting us. */
  micStream: MediaStream;
  /** Where to play the model's voice. Supplied by the caller so it can be a
   *  long-lived element unlocked by an earlier gesture. */
  audioEl: HTMLAudioElement;
  createPeerConnection?: () => RTCPeerConnection;
}

/** ICE gathering can stall on a blocked STUN server; a stalled gather must not
 *  stall the session forever. Past this we POST what we have, which for a
 *  host-candidate-only offer is usually enough. */
const ICE_TIMEOUT_MS = 4000;

/**
 * Resolve once the peer connection has finished gathering ICE candidates —
 * or once we have waited long enough that partial candidates beat no session.
 */
function waitForIce(pc: RTCPeerConnection, timeoutMs = ICE_TIMEOUT_MS): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      pc.removeEventListener('icegatheringstatechange', onChange);
      clearTimeout(timer);
      resolve();
    };
    const onChange = () => {
      if (pc.iceGatheringState === 'complete') finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    pc.addEventListener('icegatheringstatechange', onChange);
  });
}

export interface RtcTransport extends VoiceTransport {
  readonly sessionId: string;
}

/**
 * Bring up a real session. Rejects if the SDP exchange fails — the caller maps
 * that to the UI's error state, and in particular maps a 503 to "voice isn't
 * configured", which is the path that exists on a machine with no key.
 */
export async function createRtcTransport(deps: RtcTransportDeps): Promise<RtcTransport> {
  const pc = deps.createPeerConnection
    ? deps.createPeerConnection()
    : new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });

  const eventCbs = new Set<(e: InboundEvent) => void>();
  const stateCbs = new Set<(s: TransportState, detail?: string) => void>();
  let state: TransportState = 'connecting';
  const setState = (s: TransportState, detail?: string) => {
    if (state === s || state === 'closed') return;
    state = s;
    for (const cb of stateCbs) cb(s, detail);
  };

  // (2) Channel before offer. This line's POSITION is the contract.
  const dc = pc.createDataChannel(OAI_EVENT_CHANNEL);
  dc.onmessage = (ev: MessageEvent) => {
    let parsed: InboundEvent;
    try {
      parsed = JSON.parse(typeof ev.data === 'string' ? ev.data : '') as InboundEvent;
    } catch {
      return;
    }
    if (!parsed || typeof parsed.type !== 'string') return;
    for (const cb of eventCbs) cb(parsed);
  };
  dc.onopen = () => setState('open');
  dc.onclose = () => setState('closed');

  // (1) The mic track. The stream was captured in a gesture by the caller.
  for (const track of deps.micStream.getAudioTracks()) pc.addTrack(track, deps.micStream);

  pc.ontrack = (ev: RTCTrackEvent) => {
    // NEVER require ev.streams. OpenAI's answer carries `a=msid-semantic:WMS *`,
    // and a track arriving with no associated stream is a normal outcome of
    // that — the browser hands you the track and an EMPTY streams array. The
    // original code only attached when a stream was present, so the remote
    // audio was received and then dropped on the floor: the session looked
    // perfect from the sending side (it hears you) and was silent coming back.
    // Wrapping the track ourselves is correct in both cases.
    const stream = ev.streams[0] ?? new MediaStream([ev.track]);
    deps.audioEl.srcObject = stream;
    // Belt and braces, at the ONE point in the system where audio exists and is
    // about to be played. An element left muted by a failed unlock upstream
    // produces a session that is perfect on every instrument and silent in the
    // only place that matters; this line costs nothing and closes that door for
    // good.
    deps.audioEl.muted = false;
    deps.audioEl.volume = 1;

    // Retry once on the next tick: Safari can refuse a play() issued from
    // inside the ontrack callback itself while still allowing the same call a
    // moment later on an element a gesture has already blessed.
    const tryPlay = () => void deps.audioEl.play?.().catch(() => {});
    tryPlay();
    setTimeout(tryPlay, 150);
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') setState('failed', 'peer connection failed');
    else if (pc.connectionState === 'closed') setState('closed');
  };

  // (3) Offer → local description → wait for ICE.
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await waitForIce(pc);

  // (4) One-shot exchange through muxpad. No audio crosses muxpad's server.
  const localSdp = pc.localDescription?.sdp ?? offer.sdp ?? '';
  let answer: { sdp: string; sessionId: string };
  try {
    answer = await deps.exchangeSdp(localSdp);
  } catch (e) {
    try {
      pc.close();
    } catch {
      // already gone
    }
    setState('failed', e instanceof Error ? e.message : 'sdp exchange failed');
    throw e;
  }
  await pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp });

  return {
    get state() {
      return state;
    },
    sessionId: answer.sessionId,
    send(event) {
      if (dc.readyState !== 'open') return;
      try {
        dc.send(JSON.stringify(event));
      } catch {
        // A channel that dies mid-send surfaces through onclose; dropping the
        // append is correct — there is nobody left to hear it.
      }
    },
    onEvent(cb) {
      eventCbs.add(cb);
      return () => eventCbs.delete(cb);
    },
    onState(cb) {
      stateCbs.add(cb);
      return () => stateCbs.delete(cb);
    },
    close() {
      try {
        dc.close();
      } catch {
        // ignore
      }
      try {
        pc.close();
      } catch {
        // ignore
      }
      // Releasing the mic is what actually turns off the phone's recording
      // indicator; leaving tracks live is how you get a "still listening" dot
      // over a session that ended.
      for (const t of deps.micStream.getTracks()) t.stop();
      setState('closed');
      state = 'closed';
    },
  };
}
