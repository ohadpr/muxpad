// The React side: one hook that owns a ReviewSession and binds it to the
// browser's capture calls, this pane's attachment route, and the two server
// endpoints.
//
// The hook holds NO logic of its own. Everything it does is wiring, because the
// moment a decision lives in a hook it can only be tested through a component —
// and this feature's decisions (when to sample, which frame belongs to which
// instruction, what to do when a frame will not upload) are all exercised
// directly against the controller.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api';
import { REVIEW_SUPPORTED, startMicTap, startScreenCapture } from './capture';
import { fetchReviewStatus, splitUtterance, transcribeUtterance } from './client';
import { ReviewSession, type ReviewState } from './session';

export interface UseReview {
  /** Can this browser + server do a review at all? */
  available: boolean;
  /** The server has no OpenAI key: show the control, disabled, with a reason. */
  unconfigured: boolean;
  state: ReviewState;
  /** Time in this review, for the strip's clock. */
  elapsedMs: number;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  scrap: (id: string) => void;
  reset: () => void;
  /** Diagnostics, newest last. The spike's panel earned its keep: a review that
   *  produced nothing has to be able to say why. */
  log: readonly string[];
}

export function useReview(paneId: string): UseReview {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const logRef = useRef<string[]>([]);

  const pushLog = useCallback((line: string) => {
    // Bounded: a long review with a flaky link must not grow a diagnostics
    // array until the tab is slow.
    logRef.current = [...logRef.current.slice(-60), line];
    setLog(logRef.current);
  }, []);

  const session = useMemo(
    () =>
      new ReviewSession({
        startCapture: () =>
          startScreenCapture({
            log: pushLog,
            // The browser's own "Stop sharing" bar is more prominent than
            // anything muxpad draws, and pressing it must end the review rather
            // than leave it sampling a dead stream.
            onEnded: () => {
              pushLog('the browser ended the capture');
              void sessionRef.current?.stop();
            },
          }),
        startAudio: () => startMicTap(),
        uploadFrame: async (blob, name) => (await api.uploadAttachment(paneId, blob, name)).path,
        transcribe: (audio) => transcribeUtterance(audio),
        split: (text, frames) => splitUtterance(text, frames),
        // performance.now, not Date.now: the session clock is what pairs a
        // frame with a word, and a wall clock that steps (NTP, sleep) would
        // move frames relative to speech.
        now: () => performance.now(),
        log: pushLog,
      }),
    [paneId, pushLog],
  );
  const sessionRef = useRef<ReviewSession | null>(null);
  sessionRef.current = session;

  const [state, setState] = useState<ReviewState>(session.current);
  useEffect(() => session.subscribe(setState), [session]);

  // The clock. Its own interval rather than a value on the state, because the
  // state changes on every block of audio (about 23 times a second) and a
  // seconds display does not need re-deriving that often — and because a
  // review that goes quiet must still show its clock moving.
  const [elapsedMs, setElapsedMs] = useState(0);
  useEffect(() => {
    if (state.phase !== 'recording' || state.startedAt === null) return;
    const from = state.startedAt;
    const tick = () => setElapsedMs(Math.max(0, performance.now() - from));
    tick();
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, [state.phase, state.startedAt]);

  // Asked once per pane. A review is started by a gesture, and the answer to
  // "is there a key" does not change between one press and the next.
  useEffect(() => {
    let live = true;
    void fetchReviewStatus().then((s) => {
      if (live) setConfigured(s === null ? null : s.configured);
    });
    return () => {
      live = false;
    };
  }, []);

  // A review holds a screen capture and a microphone. Unmounting without
  // releasing them leaves the browser's recording indicators on over a pane
  // that no longer exists.
  useEffect(
    () => () => {
      void session.stop();
    },
    [session],
  );

  return {
    // `configured === null` means the endpoint is unreachable — an old server,
    // or one that is down. Hide the control rather than offer one that cannot
    // work, exactly as voice does.
    available: REVIEW_SUPPORTED && configured !== null,
    unconfigured: configured === false,
    state,
    elapsedMs,
    // Swallowed on purpose: a cancelled picker rejects, and that is a decision
    // rather than a failure. The state carries the reason either way, so an
    // unhandled rejection in the console would be pure noise.
    start: useCallback(async () => {
      try {
        await session.start();
      } catch {
        // see above
      }
    }, [session]),
    stop: useCallback(() => session.stop(), [session]),
    scrap: useCallback((id: string) => session.scrap(id), [session]),
    reset: useCallback(() => session.reset(), [session]),
    log,
  };
}
