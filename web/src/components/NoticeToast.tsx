import { useEffect, useState } from 'react';
import { type Notice, dismissNotice, getNotices, subscribeNotices } from '../lib/notice-store';
import './NoticeToast.css';

/**
 * Failure notices from the chrome — the replacement for `window.alert`.
 *
 * Mounted once in AppLayout for the same reason MoveUndoToast is: the actions
 * that raise one (closing a workspace, deleting a chat) often navigate, and a
 * message about a failure must outlive the route change that failure happened
 * during.
 *
 * Bottom-LEFT, stacked above the undo toasts rather than beside them: both are
 * "something just happened to a row", and two corners for one idea makes the
 * eye hunt. The undo stack owns the bottom edge because it holds the only
 * button; a notice is read, not pressed.
 */
export function NoticeToast() {
  const [notices, setNotices] = useState<Notice[]>(() => getNotices());
  useEffect(() => subscribeNotices(setNotices), []);
  if (notices.length === 0) return null;
  return (
    // An ALERT, not a status: these are failures, and the reason the native
    // dialog is gone is not that the news stopped mattering.
    <div className="notice-toasts" role="alert" aria-label="Recent failures">
      {notices.map((n) => (
        <div className="notice-toast" key={n.id}>
          <span className="notice-toast-mark" aria-hidden="true">
            <svg width="15" height="15" viewBox="0 0 15 15" aria-hidden="true">
              <circle
                cx="7.5"
                cy="7.5"
                r="6.3"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
              />
              <path
                d="M7.5 4.4v4.1"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
              <circle cx="7.5" cy="10.8" r="0.9" fill="currentColor" />
            </svg>
          </span>
          <span className="notice-toast-text">
            <span className="notice-toast-msg">{n.message}</span>
            {/* The exception, kept and kept SMALL. It is the thing that made
                the old dialog unreadable, and the thing you need when the
                sentence above it is not enough. */}
            {n.detail ? <span className="notice-toast-detail">{n.detail}</span> : null}
          </span>
          <button
            type="button"
            className="notice-toast-dismiss"
            aria-label="Dismiss"
            title="Dismiss"
            onClick={() => dismissNotice(n.id)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
