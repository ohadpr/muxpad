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
  isSilentlyBlocked,
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
  /**
   * The server's deadline for this call, and the timer that honours it.
   *
   * THE SERVER CANNOT HANG THE CALL UP. Audio is browser↔OpenAI, peer to peer;
   * muxpad is only in the SDP handshake. So when the TTL fires, or when the
   * daily budget the TTL was clamped to runs out, the server stops COUNTING and
   * makes a best-effort DELETE upstream — and that is the whole of its power.
   * If the browser ignores `expiresAt`, the call carries on.
   *
   * Measured, before this existed: with the cap set to one minute, the manager
   * logged "closed session after its 1-minute limit" at 60s and froze the meter
   * at exactly 1.0 — and the model was still answering out loud at 76s. The cap
   * was not merely exceeded, it was exceeded INVISIBLY, because the local meter
   * had stopped. Reading the deadline is what makes the ceiling real.
   */
  const deadline = useRef<number | null>(null);
  const expiryTimer = useRef<number | undefined>(undefined);
  const wakeLock = useRef<ScreenWakeLock | null>(null);
  const unBackground = useRef<(() => void) | null>(null);
  // The agent link is re-created on every ChatPane render; the session must not
  // be. Indirect through a ref so the live session always reaches the CURRENT
  // socket without being torn down and rebuilt.
  const agentRef = useRef(agent);
  agentRef.current = agent;
  // EVERY verb the link offers has to be forwarded here, not just the two the
  // session happened to need first. This wrapper silently dropped `cancelQueued`
  // and `answer`, and because both are optional on AgentLink nothing failed to
  // compile — it just meant a spoken "stop" left the backlog running, and a
  // spoken answer to a blocked agent went out as a `send` that the server
  // queued behind the very question it was answering.
  const stableAgent = useRef<AgentLink>({
    send: (t) => agentRef.current.send(t),
    stop: () => agentRef.current.stop(),
    cancelQueued: (id) => agentRef.current.cancelQueued?.(id),
    answer: (qid, answers) => agentRef.current.answer?.(qid, answers),
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

  // Playback can be refused even after a gesture (Safari ties permission to the
  // ELEMENT, and an element that has never played is not blessed). On a phone
  // that failure is invisible — you talk, it answers, you hear nothing — so it
  // has to become a tappable affordance rather than a console warning.
  const [muted, setMuted] = useState(false);
  const soundCheckRef = useRef<number | undefined>(undefined);

  // Stable: it touches a ref and nothing else, and all three of `stop`,
  // `enableSound` and `start` close over it — an identity that changed every
  // render would either rebuild them all or leave them holding a stale one.
  const clearSoundCheck = useCallback(() => {
    if (soundCheckRef.current !== undefined) window.clearTimeout(soundCheckRef.current);
    soundCheckRef.current = undefined;
  }, []);

  /** Re-entry guard. `stop` disposes the session, and disposing it fires
   *  `onState('ended')`, which now calls `stop` — once, not forever. */
  const ending = useRef(false);

  const stop = useCallback(
    (reason: EndReason = 'user') => {
      if (ending.current) return;
      ending.current = true;
      // The sound check was armed by `start()` and has a 2.5s fuse. A session
      // ended inside that window left it burning, and it fires into a dead
      // session: `isSilentlyBlocked` is true of a stopped element, so the UI
      // raises "tap to hear sound" on a call that is already over.
      clearSoundCheck();
      setMuted(false);
      if (expiryTimer.current !== undefined) window.clearTimeout(expiryTimer.current);
      expiryTimer.current = undefined;
      deadline.current = null;
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
      ending.current = false;
    },
    [clearSoundCheck],
  );

  const enableSound = useCallback(async () => {
    const el = voiceAudioElement();
    // Unmute FIRST. "Tap to hear" that only calls play() is useless against the
    // failure it exists for — an element that is already playing, muted.
    el.muted = false;
    el.volume = 1;
    try {
      await el.play();
      clearSoundCheck();
      setMuted(isSilentlyBlocked(el));
    } catch {
      setMuted(true);
    }
  }, [clearSoundCheck]);

  const start = useCallback(() => {
    if (!enabled || !supported || sessionRef.current) return;
    setDetail(null);
    setState('connecting');

    const audioEl = voiceAudioElement();
    // Both inside the gesture, both before any await that we control.
    void unlockPlayback(audioEl);
    setMuted(false);
    // If the element still isn't AUDIBLE shortly after the remote track lands,
    // treat it as blocked and offer the tap. Cheap poll beats guessing which of
    // play()'s several rejection paths fired. `paused` alone was not enough:
    // the failure that actually shipped left the element playing and muted.
    const soundCheck = window.setTimeout(() => {
      if (isSilentlyBlocked(audioEl)) setMuted(true);
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
            deadline.current = answer.expiresAt;
            return { sdp: answer.sdp, sessionId: answer.sessionId };
          },
        });
        closeTransport.current = () => transport.close();

        const session = new VoiceSession({
          transport,
          agent: stableAgent.current,
          // Loud on purpose. The `text`-instead-of-`content` bug rejected every
          // append for a whole release and produced not one observable symptom
          // except a voice that never answered; a console warning would have
          // named it in a minute.
          onProtocolError: (line) => console.warn('[voice] model rejected an event:', line),
          onState: (s, d) => {
            setState(s);
            if (d) setDetail(d);
            // A transport that dies takes the session with it; don't leave the
            // meter running or the mic light on.
            //
            // THE METER IS THE POINT, and it used to be the half that was
            // missing. This branch released the wake lock and stopped there, so
            // a dropped connection — wifi gone, peer connection failed, the tab
            // losing its network — left `remoteId` set and the server session
            // OPEN. Nothing then fired `DELETE /api/voice/session/:id`, so the
            // call went on billing until the TTL expired, up to ten minutes of
            // a call nobody was on. Measured against a live session: after the
            // peer connection was closed the UI said "ended" while
            // /api/voice/status still reported `live: true` and a climbing
            // meter. `stop()` is the only path that hangs up; take it.
            if (s === 'ended' || s === 'error') {
              wakeLock.current?.release();
              wakeLock.current = null;
              stop('transport-failed');
            }
          },
        });
        session.start();
        sessionRef.current = session;

        // Hang up ON the server's deadline, not after it. `settle` clamps what
        // it charges to this instant anyway, so every second past it is spend
        // nobody is counting. Fires immediately if the deadline has already
        // passed, which is the right answer to a clock that disagrees.
        if (deadline.current != null) {
          expiryTimer.current = window.setTimeout(
            () => stop('expired'),
            Math.max(0, deadline.current - Date.now()),
          );
        }

        wakeLock.current = new ScreenWakeLock();
        void wakeLock.current.acquire();
        // THE iOS RULE: capture is gone the moment we background, so end the
        // session rather than leave a zombie that bills for silence.
        unBackground.current = onBackgrounded(() => stop('backgrounded'));

        setStartedAt(Date.now());
        void fetchVoiceStatus().then(setStatus);
      } catch (e) {
        // ═══ HANG UP FIRST. A FAILED START CAN STILL HAVE A PAID SESSION. ═══
        //
        // `exchangeSdp` sets `remoteId` the instant the POST answers — which is
        // the instant a session exists at OpenAI and the meter starts. Every
        // step after it can throw: the browser refusing the answer SDP, the
        // session constructor, `session.start()`. All of them land here.
        //
        // This catch used to stop the mic tracks and render an error. It did
        // not hang up. So a start that failed one line past the POST left the
        // server session live for its ENTIRE TTL — ten minutes billed — and,
        // because the manager allows one live session per install, 409'd every
        // retry for those ten minutes against a call that never connected.
        // Nothing logged it: no upstream error, no server line, just a mic
        // button that refused and a bill.
        clearSoundCheck();
        closeTransport.current?.();
        closeTransport.current = null;
        deadline.current = null;
        const orphan = remoteId.current;
        remoteId.current = null;
        if (orphan) void endVoiceSession(orphan);
        for (const t of stream.getTracks()) t.stop();
        setState('error');
        setDetail(
          e instanceof VoiceUnavailableError
            ? e.message
            : e instanceof Error && e.message
              ? e.message
              : 'Voice couldn’t start.',
        );
        void fetchVoiceStatus().then(setStatus);
      }
    })();
  }, [enabled, supported, paneId, stop, clearSoundCheck]);

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
