// THE REVIEW BUTTON, AND THE LIST IT FILLS.
//
// The panel is not decoration — it IS the feature's safety rail. A review turns
// speech into instructions for an agent, and the two things that can go wrong
// (a mishearing, a bad split) both produce something that READS fine. The only
// defence is that you see the notes, with their pictures, before anything is
// sent. So: nothing is ever sent automatically, every note can be scrapped, and
// the frame thumbnail sits next to the words it addresses.
//
// Three states, three shapes:
//   · resting   — one round ghost button, a peer of the paperclip
//   · recording — a live strip: meter, clock, note count, Stop
//   · stopped   — the note list, with Send to this chat / Discard
//
// The mic meter is in the live strip for a measured reason: the spike's first
// successful run was preceded by two failures where the built-in microphone
// handed back a live-but-silent track. Nothing on screen said so, and the
// review was over before anybody knew. A bar that does not move is now visible
// in the first second.

import { attachmentUrl } from '../lib/attachments';
import type { ReviewItem, ReviewState } from '../lib/review/session';
import './ReviewControl.css';

function SvgScreenPointer({ size = 22 }: { size?: number }) {
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
      <rect x="2.5" y="4" width="19" height="13" rx="2" />
      <path d="M8 20.5h8" />
      {/* The pointer, which is the whole idea: you say "this one" and the
          cursor is what "this" means. */}
      <path d="M10 8.5l4.5 4.5-2 .4 1.3 2.6-1.3.6-1.3-2.6-1.2 1.6z" fill="currentColor" />
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

/** m:ss. A review is minutes long; an hour-long one is a different problem. */
export function clockOf(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** Why review cannot run, or null. `unconfigured` DISABLES with a reason rather
 *  than hiding: a missing control is indistinguishable from a bug, and this one
 *  has a fix the user can go and apply. */
export function unavailableReason(available: boolean, unconfigured: boolean): string | null {
  if (!available) return 'This browser can’t share a screen.';
  if (unconfigured) return 'Screen review needs an OpenAI key on this server.';
  return null;
}

/** The notes worth sending: transcribed, not scrapped, not empty. */
export function sendableNotes(items: readonly ReviewItem[]): ReviewItem[] {
  return items.filter((n) => n.status === 'ready' && n.text.trim());
}

export interface ReviewButtonProps {
  state: ReviewState;
  available: boolean;
  unconfigured: boolean;
  onStart: () => void;
  onStop: () => void;
}

export function ReviewButton({
  state,
  available,
  unconfigured,
  onStart,
  onStop,
}: ReviewButtonProps) {
  const live = state.phase === 'recording' || state.phase === 'starting';
  const reason = unavailableReason(available, unconfigured);
  if (live)
    return (
      <button
        type="button"
        className="review-btn is-live"
        onClick={onStop}
        aria-label="Stop the screen review"
        title="Stop the screen review"
        data-testid="review-stop-inline"
      >
        <SvgStopSquare />
      </button>
    );
  return (
    <button
      type="button"
      className="review-btn"
      onClick={onStart}
      disabled={!!reason}
      aria-label={reason ?? 'Review a screen — talk while you point'}
      title={reason ?? 'Review a screen — talk while you point'}
      data-testid="review-start"
      data-reason={reason ? 'unavailable' : undefined}
    >
      <SvgScreenPointer />
    </button>
  );
}

export interface ReviewPanelProps {
  state: ReviewState;
  elapsedMs: number;
  onStop: () => void;
  onScrap: (id: string) => void;
  onSend: () => void;
  onDiscard: () => void;
  log: readonly string[];
}

/**
 * Above the composer, while a review is happening and until it is dealt with.
 *
 * Renders nothing at rest — this strip costs the same screen space the last
 * message occupies, which is the most valuable strip in the pane.
 */
export function ReviewPanel({
  state,
  elapsedMs,
  onStop,
  onScrap,
  onSend,
  onDiscard,
  log,
}: ReviewPanelProps) {
  const recording = state.phase === 'recording' || state.phase === 'starting';
  // A FINISHED REVIEW SHOWS EVEN WITH NO NOTES, which is the case worth being
  // careful about: a review that captured nothing is exactly when the user
  // needs to be told why (a muted mic, a refused cursor, a stream that ended),
  // and an empty panel that silently closes itself is how the spike's first
  // three runs looked from the outside.
  const done = state.phase === 'stopped';
  const failed = state.phase === 'failed';
  if (!recording && !done && !failed) return null;

  if (failed)
    return (
      // biome-ignore lint/a11y/useSemanticElements: a live region for session state, not a form result.
      <div className="review-panel -error" role="status" data-testid="review-panel">
        <span className="review-msg">{state.error ?? 'Screen review couldn’t start.'}</span>
        <button type="button" className="review-dismiss" onClick={onDiscard}>
          Dismiss
        </button>
      </div>
    );

  const sendable = sendableNotes(state.items);
  return (
    // biome-ignore lint/a11y/useSemanticElements: same — a live region, not a form result.
    <div className="review-panel" role="status" data-testid="review-panel">
      <div className="review-head">
        {recording ? (
          <>
            <span className={`review-dot${state.speaking ? ' is-speaking' : ''}`} aria-hidden />
            <span className="review-state">{state.speaking ? 'Listening' : 'Watching'}</span>
            {/* The meter. A bar that does not move means a dead microphone —
                which is otherwise invisible until the review is over. */}
            <span
              className="review-meter"
              title="Microphone level — if this never moves, the wrong input device is selected"
              aria-label="Microphone level"
            >
              <span
                className="review-meter-fill"
                style={{ width: `${Math.round(state.level * 100)}%` }}
              />
            </span>
            <span className="review-clock">{clockOf(elapsedMs)}</span>
            <span className="review-count">
              {state.items.length} {state.items.length === 1 ? 'note' : 'notes'}
            </span>
            <button
              type="button"
              className="review-stop"
              onClick={onStop}
              data-testid="review-stop"
              aria-label="Stop the screen review"
            >
              <SvgStopSquare size={11} />
              Stop
            </button>
          </>
        ) : (
          <>
            <span className="review-state">
              {sendable.length} {sendable.length === 1 ? 'note' : 'notes'}
            </span>
            <span className="review-small">
              {state.kept} {state.kept === 1 ? 'frame' : 'frames'} kept of {state.sampled} sampled
            </span>
            <button
              type="button"
              className="review-send"
              onClick={onSend}
              disabled={sendable.length === 0}
              data-testid="review-send"
            >
              Send to this chat
            </button>
            <button type="button" className="review-dismiss" onClick={onDiscard}>
              Discard
            </button>
          </>
        )}
      </div>

      {state.items.length > 0 ? (
        <ol className="review-notes">
          {state.items.map((n) => (
            <li key={n.id} className={`review-note is-${n.status}`} data-testid="review-note">
              <div className="review-note-frames">
                {n.frames.slice(0, 3).map((path) => {
                  const name = path.split('/').pop() ?? path;
                  return (
                    <img
                      key={path}
                      className="review-thumb"
                      src={attachmentUrl(name)}
                      alt=""
                      loading="lazy"
                    />
                  );
                })}
              </div>
              <span className="review-note-text">
                {n.status === 'pending'
                  ? 'listening…'
                  : n.status === 'failed'
                    ? (n.error ?? 'that one didn’t transcribe')
                    : n.text}
              </span>
              <button
                type="button"
                className="review-scrap"
                onClick={() => onScrap(n.id)}
                aria-label="Scrap this note"
                title="Scrap this note"
              >
                ×
              </button>
            </li>
          ))}
        </ol>
      ) : recording ? (
        <p className="review-hint">
          Switch to the window you shared and talk while you point. Each pause ends a note.
        </p>
      ) : null}

      {/* Diagnostics, last and quiet. A review that produced nothing has to be
          able to say why — the spike's panel earned this. */}
      {log.length > 0 && state.items.length === 0 && !recording ? (
        <p className="review-log">{log[log.length - 1]}</p>
      ) : null}
    </div>
  );
}
