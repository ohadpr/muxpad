import type Database from 'better-sqlite3';

/**
 * WHICH CHAT PUBLISHED EACH SLUG — read, never written.
 *
 * There is no record of its own, and that is the point. `POST /api/publish`
 * already writes a chat action with `ref = 'publish:<slug>'` — the card that
 * appears in the conversation that published it, carrying the pane it came
 * from (see publish-actions.ts). That row is private, indexed on `ref`, and
 * already covers everything published since the card shipped. A second table
 * would have been a copy of the same fact with its own way of going stale.
 *
 * It could not have lived beside the bytes either: everything under a slug
 * directory is served to the open internet, on a host with no index and no
 * login, so a sidecar naming the chat would publish the chat.
 *
 * PANE → TAB, because a chat is a TAB and the action records the pane inside
 * it. A pane that no longer exists simply has no origin, which reads the same
 * as never having had one — the artifact is still published and still yours.
 *
 * Nothing is inferred for the gap. Artifacts published from an ordinary shell,
 * or before the card existed, have no origin; guessing one from a timestamp
 * would be a wrong chat stated confidently.
 */
const REF_PREFIX = 'publish:';

export function publishOriginTabs(db: Database.Database): Map<string, string> {
  const out = new Map<string, string>();
  try {
    const rows = db
      .prepare(
        `SELECT a.ref AS ref, p.tab_id AS tab_id
           FROM chat_actions a
           JOIN panes p ON p.id = a.pane_id
          WHERE a.ref LIKE ? || '%'
          ORDER BY a.at ASC`,
      )
      .all(REF_PREFIX) as Array<{ ref: string; tab_id: string }>;
    // LAST WRITER WINS, which is why the query is ordered: a republish of the
    // same slug from a second chat records another action, and the current
    // answer to "where does this come from" is the chat that updated it.
    for (const r of rows) out.set(r.ref.slice(REF_PREFIX.length), r.tab_id);
  } catch {
    // A label is never a precondition for listing what is published.
  }
  return out;
}
