import { Link, useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';
import { dropFromWorkingSet, useWorkingSet } from '../working-set';
import './WorkingSetTabs.css';

/**
 * THE WORKING SET, AS TABS.
 *
 * ─── Why it moved out of the rail ─────────────────────────────────────────
 *
 * It was a band at the top of the sidebar: the same rows, in the same list,
 * drawn the same way as the tree underneath it. Every complaint it collected
 * was the same complaint wearing a different hat — "active in recently active
 * is just trash" (the chat you were in was a pill twice on one screen), "not
 * horizontally aligned with the chats below", "still too noisy", "not great".
 * None of them is a tuning problem. A list that looks like the list under it
 * and means something different from the list under it is going to read as
 * noise however carefully it is coloured, and four rounds of tuning each
 * traded one casualty for another: clip the name, clip the workspace, hide
 * the workspace, collapse the line.
 *
 * Two different PLACES dissolves it, and the shape was a tab bar all along:
 * stable slots that never reorder when you use them, ⌃1–⌃6, a × that means
 * "not now", eviction by capacity, decay by time. muxpad's own model even
 * calls these things tabs — workspace → tab → pane, where a chat IS a tab —
 * so this is the app's vocabulary made visible rather than a new idea.
 *
 * ─── And it is cheaper here ───────────────────────────────────────────────
 *
 * Six tabs across a 1440px window is about 200px each. The 280px rail gave a
 * row about 160px once the workspace tag, the age and the status mark had
 * taken their share — which is why the name was the thing being clipped. The
 * axis that was scarce is the one this layout has spare.
 *
 * The cost is a row of height, and height is the scarce axis in a chat. That
 * is the trade; it is worth it because the rail gets its one job back and the
 * sidebar becomes something you can collapse without losing your place.
 *
 * ─── NOT ON A PHONE ───────────────────────────────────────────────────────
 *
 * The sheet keeps the band exactly as it was. A tab strip on a phone is six
 * things fighting for 390px, which is the problem this is solving, reproduced
 * on the surface that can least afford it. The sheet is a full-screen list
 * where the band reads fine.
 */
export function WorkingSetTabs({ activeTabSlug }: { activeTabSlug: string | null }) {
  const rows = useWorkingSet();
  const navigate = useNavigate();

  // ⌃1…⌃6, and NOT ⌘ — Chrome binds ⌘1-9 to its own tab switcher, and a
  // shortcut that fights the browser is a shortcut nobody can use.
  //
  // The handler lives HERE now rather than in the rail's band, because the
  // band no longer mounts on a desktop. It is the same binding against the
  // same slots: the numbers are worth having precisely because the slots do
  // not move, and a number pointing at a list that renumbers itself is worse
  // than no number, because you learn it and it lies.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      const n = Number(e.key);
      if (!Number.isInteger(n) || n < 1 || n > rows.length) return;
      const hit = rows[n - 1];
      if (!hit) return;
      e.preventDefault();
      void navigate({
        to: '/w/$wsSlug/t/$tabSlug',
        params: { wsSlug: hit.workspace.slug, tabSlug: hit.tab.slug },
      });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [rows, navigate]);

  // Nothing to show is NOTHING, not an empty bar. A strip with no tabs is a
  // row of height spent on a promise the app is not keeping, and on a fresh
  // install or after a long break that is the normal state.
  if (rows.length === 0) return null;

  return (
    <div className="wstabs" role="tablist" aria-label="Recently active">
      {rows.map(({ tab, workspace }) => {
        const active = tab.slug === activeTabSlug;
        return (
          <div
            className="wstab"
            key={tab.id}
            data-active={active ? 'true' : undefined}
            // Unread is the one state a nav element must carry — it is the
            // reason you would look at the strip at all — and the rail says
            // it in weight and ink, so this does too.
            data-unread={tab.unread ? 'true' : undefined}
          >
            <Link
              to="/w/$wsSlug/t/$tabSlug"
              params={{ wsSlug: workspace.slug, tabSlug: tab.slug }}
              className="wstab-link"
              role="tab"
              aria-selected={active}
              draggable={false}
              title={`${tab.name} · ${workspace.name}`}
            >
              <span className="wstab-icon" aria-hidden="true">
                {tab.icon ?? '◆'}
              </span>
              <span className="wstab-name">{tab.name}</span>
            </Link>
            {/* ── ONE TRAILING SLOT ─────────────────────────────────────
                The mark and the × are the same 20px, because two objects in
                one corner read as one confused control and a × that appears
                on hover made the tab resize under the pointer. The slot is
                always there; the × takes the mark's place when you reach for
                it. See the css.

                The mark is a DOT, not the rail's three shapes: a tick and a
                ring do not survive being this small, and "something is
                happening here" does — which is the part worth carrying
                across a window. */}
            <span className="wstab-slot">
              {tab.status && tab.status !== 'idle' ? (
                <span className="wstab-mark" data-state={tab.status} aria-hidden="true" />
              ) : null}
              {/* "Not now" — it frees the slot and nothing else: the chat stays
                exactly where it lives, un-archived, untouched. A destructive
                action on a convenience strip would make the strip
                frightening, and the strip's whole value is that reaching for
                it costs nothing. */}
              <button
                type="button"
                className="wstab-drop"
                title="Not now — free this slot"
                aria-label={`Remove ${tab.name} from Recently active`}
                onClick={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  void dropFromWorkingSet(tab.id);
                }}
              >
                ×
              </button>
            </span>
          </div>
        );
      })}
    </div>
  );
}
