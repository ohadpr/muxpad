// The React-shaped wrapper. Owns exactly one thing: the LIFETIME of a session.
//
// All the hard logic lives in session.ts, which knows nothing about React,
// WebRTC or the DOM. This file is the part that cannot be unit tested — it
// touches getUserMedia, a peer connection, a wake lock and the visibility API —
// so it is kept deliberately thin and free of decisions.
//
// THE GESTURE RULE SHAPES THIS FILE. `start()` must be invoked directly by a
// click handler, and `requestMic()` must be the first thing it does, before any
// await. Anything else — a status fetch first, a confirm dialog, a state update
// that suspends — and Safari has already decided the gesture is over and will
// refuse the microphone. That is why there is no "check the budget, then ask
// for the mic" ordering here, even though it would be tidier.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  type VoiceStatus,
  VoiceUnavailableError,
  createVoiceSession,
  endVoiceSession,
  fetchVoiceStatus,
  minutesRemaining,
} from './client';
import {
  type EndReason,
  ScreenWakeLock,
  endReasonMessage,
  isMicDenial,
  onBackgrounded,
  requestMic,
  unlockPlayback,
  voiceAudioElement,
} from './lifecycle';
import { type AgentLink, VoiceSession, type VoiceUiState } from './session';
import { createRtcTransport } from './transport';

/** `off` is the resting state; the other five are session.ts's. */
export type VoiceControlState = VoiceUiState | 'off';

export interface UseVoiceOpts {
  paneId: string;
  /** Chat mode only. Agent mode is raw — no voice, no mic, no control. */
  enabled: boolean;
  agent: AgentLink;
}

export interface UseVoiceResult {
  /** Does this browser have the APIs at all? */
  supported: boolean;
  status: VoiceStatus | null;
  state: VoiceControlState;
  /** The sentence shown under an error/ended state. */
  detail: string | null;
  minutesLeft: number | null;
  elapsedMs: number;
  /** MUST be called straight from a click handler. */
  start: () => void;
  stop: (reason?: EndReason) => void;
  /** Audio arrived but the browser refused to play it — offer a tap. */
  muted: boolean;
  /** Unblock playback. MUST be called straight from a click handler. */
  enableSound: () => Promise<void>;
}

const hasVoiceApis = () =>
  typeof window !== 'undefined' &&
  typeof RTCPeerConnection !== 'undefined' &&
  !!navigator.mediaDevices?.getUserMedia;

export function useVoice(opts: UseVoiceOpts): UseVoiceResult {
  const { paneId, enabled, agent } = opts;
  const [status, setStatus] = useState<VoiceStatus | null>(null);
  const [state, setState] = useState<VoiceControlState>('off');
  const [detail, setDetail] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);

  const sessionRef = useRef<VoiceSession | null>(null);
  const closeTransport = useRef<(() => void) | null>(null);
  const remoteId = useRef<string | null>(null);
  const wakeLock = useRef<ScreenWakeLock | null>(null);
  const unBackground = useRef<(() => void) | null>(null);
  // The agent link is re-created on every ChatPane render; the session must not
  // be. Indirect through a ref so the live session always reaches the CURRENT
  // socket without being torn down and rebuilt.
  const agentRef = useRef(agent);
  agentRef.current = agent;
  const stableAgent = useRef<AgentLink>({
    send: (t) => agentRef.current.send(t),
    stop: () => agentRef.current.stop(),
    onFrame: (cb) => agentRef.current.onFrame(cb),
  });

  const supported = hasVoiceApis();

  const refreshStatus = useCallback(() => {
    if (!enabled) return;
    void fetchVoiceStatus().then(setStatus);
  }, [enabled]);

  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);

  const stop = useCallback((reason: EndReason = 'user') => {
    unBackground.current?.();
    unBackground.current = null;
    wakeLock.current?.release();
    wakeLock.current = null;
    sessionRef.current?.dispose(reason);
    sessionRef.current = null;
    closeTransport.current?.();
    closeTransport.current = null;
    const id = remoteId.current;
    remoteId.current = null;
    if (id) void endVoiceSession(id);
    setStartedAt(null);
    setElapsedMs(0);
    setState('off');
    setDetail(reason === 'user' ? null : endReasonMessage(reason));
    void fetchVoiceStatus().then(setStatus);
  }, []);

  // Playback can be refused even after a gesture (Safari ties permission to the
  // ELEMENT, and an element that has never played is not blessed). On a phone
  // that failure is invisible — you talk, it answers, you hear nothing — so it
  // has to become a tappable affordance rather than a console warning.
  const [muted, setMuted] = useState(false);
  const soundCheckRef = useRef<number | undefined>(undefined);

  const clearSoundCheck = () => {
    if (soundCheckRef.current !== undefined) window.clearTimeout(soundCheckRef.current);
    soundCheckRef.current = undefined;
  };

  const enableSound = useCallback(async () => {
    const el = voiceAudioElement();
    try {
      await el.play();
      clearSoundCheck();
      setMuted(false);
    } catch {
      setMuted(true);
    }
  }, []);

  const start = useCallback(() => {
    if (!enabled || !supported || sessionRef.current) return;
    setDetail(null);
    setState('connecting');

    const audioEl = voiceAudioElement();
    // Both inside the gesture, both before any await that we control.
    void unlockPlayback(audioEl);
    setMuted(false);
    // If the element is still not playing shortly after the remote track lands,
    // treat it as blocked and offer the tap. Cheap poll beats guessing which of
    // play()'s several rejection paths fired.
    const soundCheck = window.setTimeout(() => {
      if (audioEl.srcObject && audioEl.paused) setMuted(true);
    }, 2500);
    soundCheckRef.current = soundCheck;
    const micPromise = requestMic();

    void (async () => {
      let stream: MediaStream;
      try {
        stream = await micPromise;
      } catch (e) {
        setState('error');
        setDetail(
          isMicDenial(e) ? endReasonMessage('mic-denied') : 'Couldn’t open the microphone.',
        );
        return;
      }
      try {
        const transport = await createRtcTransport({
          micStream: stream,
          audioEl,
          exchangeSdp: async (offer) => {
            const answer = await createVoiceSession(paneId, offer);
            remoteId.current = answer.sessionId;
            return { sdp: answer.sdp, sessionId: answer.sessionId };
          },
        });
        closeTransport.current = () => transport.close();

        const session = new VoiceSession({
          transport,
          agent: stableAgent.current,
          onState: (s, d) => {
            setState(s);
            if (d) setDetail(d);
            // A transport that dies takes the session with it; don't leave the
            // meter running or the mic light on.
            if (s === 'ended') {
              wakeLock.current?.release();
              wakeLock.current = null;
            }
          },
        });
        session.start();
        sessionRef.current = session;

        wakeLock.current = new ScreenWakeLock();
        void wakeLock.current.acquire();
        // THE iOS RULE: capture is gone the moment we background, so end the
        // session rather than leave a zombie that bills for silence.
        unBackground.current = onBackgrounded(() => stop('backgrounded'));

        setStartedAt(Date.now());
        void fetchVoiceStatus().then(setStatus);
      } catch (e) {
        for (const t of stream.getTracks()) t.stop();
        setState('error');
        setDetail(
          e instanceof VoiceUnavailableError
            ? e.message
            : e instanceof Error && e.message
              ? e.message
              : 'Voice couldn’t start.',
        );
      }
    })();
  }, [enabled, supported, paneId, stop]);

  // The meter. Ticks locally rather than polling the server — this number is
  // shown next to a running cost, so it should never freeze because a fetch
  // failed.
  useEffect(() => {
    if (startedAt == null) return;
    const h = window.setInterval(() => setElapsedMs(Date.now() - startedAt), 1000);
    return () => window.clearInterval(h);
  }, [startedAt]);

  // Leaving Chat mode, or unmounting the pane, ends the session. Voice exists
  // in Chat mode only, and a session outliving its pane is a meter with no
  // off switch.
  useEffect(() => {
    if (!enabled && sessionRef.current) stop('unmounted');
  }, [enabled, stop]);

  useEffect(() => {
    return () => {
      if (sessionRef.current) stop('unmounted');
    };
  }, [stop]);

  return {
    supported,
    status,
    state,
    detail,
    minutesLeft: minutesRemaining(status),
    elapsedMs,
    start,
    stop,
    /** True when audio arrived but the browser refused to play it. */
    muted,
    /** Call from a user gesture to unblock playback. */
    enableSound,
  };
}
