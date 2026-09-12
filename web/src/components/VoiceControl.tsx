// THE MIC, AND THE OFF SWITCH.
//
// Two rules shaped this component, and both come from the fact that a live
// session is SPENDING MONEY BY THE MINUTE:
//
//   1. STOPPING IS ALWAYS ONE TAP AWAY AND NEVER AMBIGUOUS. While a session is
//      live the control is a labelled Stop with a running timer, not a mic icon
//      that toggles. A toggle you have to remember the state of is the wrong
//      shape for something billable.
//   2. THE METER IS VISIBLE. Minutes remaining against the cap, when the server
//      reports one, sit next to the timer — before the user starts, so they can
//      decide, and while they talk, so they aren't surprised.
//
// Chat mode only. Agent mode is raw: no mic, no control, nothing rendered. The
// caller enforces that, and passes `enabled: false` rather than conditionally
// mounting, so the hook's cleanup still runs on a mode switch mid-session.

import type { VoiceStatus } from '../lib/voice/client';
import type { VoiceControlState } from '../lib/voice/use-voice';
import './VoiceControl.css';

function SvgMic({ size = 15 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="9" y="2" width="6" height="11" rx="3" />
      <path d="M5 10a7 7 0 0 0 14 0" />
      <path d="M12 17v4" />
    </svg>
  );
}

function SvgStopSquare({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="5" y="5" width="14" height="14" rx="2.5" />
    </svg>
  );
}

/** mm:ss. Never hours — a voice session that long is a billing incident, and
 *  the number growing past 59:59 is a louder signal than a tidy 1:00:03. */
export function clockOf(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** The word under the dot. Short, present tense, and distinct at a glance —
 *  these are read peripherally while the user is talking, not studied. */
export function stateLabel(s: VoiceControlState): string {
  switch (s) {
    case 'connecting':
      return 'Connecting';
    case 'listening':
      return 'Listening';
    case 'thinking':
      return 'Working';
    case 'speaking':
      return 'Speaking';
    case 'error':
      return 'Voice error';
    case 'ended':
      return 'Ended';
    default:
      return 'Voice';
  }
}

export function isLive(s: VoiceControlState): boolean {
  return s === 'connecting' || s === 'listening' || s === 'thinking' || s === 'speaking';
}

/**
 * Why the mic is unavailable, or null when it is fine.
 *
 * `configured: false` DISABLES with a reason rather than hiding — a missing
 * control is indistinguishable from a bug, and this one has an obvious fix the
 * user can go and apply. An unreachable status endpoint (null) is different and
 * does NOT disable: the session POST is the real gate, and refusing to try on
 * the strength of a failed side-channel would make voice unusable whenever that
 * one route hiccups.
 */
export function unavailableReason(
  status: VoiceStatus | null,
  supported: boolean,
  minutesLeft: number | null,
): string | null {
  if (!supported) return 'This browser can’t do voice (no WebRTC or no microphone).';
  if (status && !status.configured) return 'Voice isn’t set up on this server — no OpenAI key.';
  if (minutesLeft !== null && minutesLeft <= 0) return 'Voice is over today’s cap.';
  return null;
}

export interface VoiceControlProps {
  state: VoiceControlState;
  detail: string | null;
  status: VoiceStatus | null;
  supported: boolean;
  minutesLeft: number | null;
  elapsedMs: number;
  onStart: () => void;
  onStop: () => void;
}

/** The resting affordance: one round ghost button, a peer of the camera. */
export function VoiceControl({
  state,
  detail,
  status,
  supported,
  minutesLeft,
  elapsedMs,
  onStart,
  onStop,
}: VoiceControlProps) {
  const live = isLive(state);
  const reason = unavailableReason(status, supported, minutesLeft);
  if (live) {
    return (
      <button
        type="button"
        className="voice-btn is-live"
        onClick={onStop}
        aria-label="Stop voice"
        title="Stop voice"
        data-testid="voice-stop-inline"
      >
        <SvgStopSquare />
      </button>
    );
  }
  return (
    <button
      type="button"
      className="voice-btn"
      onClick={onStart}
      disabled={!!reason}
      aria-label={reason ?? 'Start voice'}
      title={reason ?? detail ?? 'Start voice'}
      data-testid="voice-start"
      data-reason={reason ? 'unavailable' : undefined}
    >
      <SvgMic />
    </button>
  );
}

export interface VoiceBarProps extends VoiceControlProps {
  onDismiss: () => void;
  /** Audio is arriving but the browser refused to play it. */
  muted?: boolean;
  /** Unblock playback — must run straight from this click. */
  onEnableSound?: () => void;
}

/**
 * The live bar, above the composer. Only rendered when there is something to
 * say — a live session, or the sentence explaining why the last one stopped.
 *
 * The Stop here is the PRIMARY one: full width of its own cell, labelled with a
 * word, and it never moves or changes meaning as the state cycles between
 * listening/working/speaking. The inline round button above is the convenience
 * copy, not the main exit.
 */
export function VoiceBar(props: VoiceBarProps) {
  const { state, detail, minutesLeft, elapsedMs, onStop, onDismiss, muted, onEnableSound } =
    props;
  const live = isLive(state);
  if (!live && !detail) return null;

  if (!live) {
    return (
      // biome-ignore lint/a11y/useSemanticElements: <output> is a form's computed result, labelled by `for`; this is a live region announcing session state, which is exactly role="status".
      <div className={`voice-bar -notice${state === 'error' ? ' -error' : ''}`} role="status">
        <span className="voice-bar-msg">{detail}</span>
        <button type="button" className="voice-bar-dismiss" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    );
  }

  return (
    // biome-ignore lint/a11y/useSemanticElements: same — a live region for session state, not a form result.
    <div className={`voice-bar -live -${state}`} role="status" data-testid="voice-bar">
      <span className="voice-dot" aria-hidden="true" />
      {/* Refused playback is INVISIBLE on a phone — you talk, it answers, you
          hear nothing, and there is no console to check. Safari ties the
          permission to the element rather than the page, so the fix is one tap
          from a real gesture; it just has to be offered. */}
      {muted && onEnableSound ? (
        <button type="button" className="voice-bar-unmute" onClick={onEnableSound}>
          Tap to hear
        </button>
      ) : (
        <span className="voice-bar-state">{stateLabel(state)}</span>
      )}
      <span className="voice-bar-clock" title="Time in this session">
        {clockOf(elapsedMs)}
      </span>
      {minutesLeft !== null ? (
        <span className="voice-bar-budget" title="Minutes left against today’s cap">
          {minutesLeft} min left
        </span>
      ) : null}
      <button
        type="button"
        className="voice-bar-stop"
        onClick={onStop}
        data-testid="voice-stop"
        aria-label="Stop voice session"
      >
        <SvgStopSquare size={11} />
        Stop
      </button>
    </div>
  );
}
