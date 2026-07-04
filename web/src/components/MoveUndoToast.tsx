import { useEffect, useState } from 'react';
import { type UndoEntry, dismissUndo, getUndos, subscribeUndos } from '../lib/move-undo-store';
import './MoveUndoToast.css';

/**
 * Transient "Moved X — Undo" toasts for pane/tab moves. Mounted once in
 * AppLayout (NOT inside a TabView) so it persists across the navigation a
 * move triggers — the toast that lets you bounce a move back has to outlive
 * the route change that the move itself caused.
 *
 * Anchored bottom-LEFT to stay clear of the bottom-right external-open
 * toast stack.
 */
export function MoveUndoToast() {
  const [entries, setEntries] = useState<UndoEntry[]>(() => getUndos());
  useEffect(() => subscribeUndos(setEntries), []);
  if (entries.length === 0) return null;
  return (
    <div className="move-undo-toasts" role="region" aria-label="Undo move">
      {entries.map((e) => (
        <Toast key={e.id} entry={e} />
      ))}
    </div>
  );
}

function Toast({ entry }: { entry: UndoEntry }) {
  const handleUndo = () => {
    // Dismiss first so a slow reverse-move can't leave a stale toast around;
    // errors in the reverse move are the caller's to log.
    dismissUndo(entry.id);
    void entry.run();
  };
  return (
    <div className="move-undo-toast" role="group">
      <span className="move-undo-toast-msg">{entry.message}</span>
      <button type="button" className="move-undo-toast-action" onClick={handleUndo}>
        Undo
      </button>
      <button
        type="button"
        className="move-undo-toast-dismiss"
        aria-label="Dismiss"
        title="Dismiss"
        onClick={() => dismissUndo(entry.id)}
      >
        ×
      </button>
    </div>
  );
}
