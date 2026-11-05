import type Database from 'better-sqlite3';
import { ChatActionStore } from './store/ChatActionStore.js';
import { LOCAL_NODE_ID } from './store/NodeStore.js';
import { PaneStore } from './store/PaneStore.js';

/**
 * PUBLISHING, AS A CHAT ACTION — the second producer of the generic card.
 *
 * A publish is the same kind of event as a Slack post: the agent did something
 * to the outside world, the conversation holds only its own account of it, and
 * the one thing a person wants later is the LINK. "Where's that report I made
 * last week?" was answered by scrolling, or by `muxpad publish --list` and
 * guessing which slug was the one.
 *
 * It is also what gives a chat an ARTIFACTS list at all: nothing anywhere
 * recorded which conversation published a slug. The public dir is keyed by
 * slug and the expiry store by slug, and neither has ever known who made it.
 *
 * ── `sent`, NOT `pending` ────────────────────────────────────────────────
 * Unlike Slack, a publish needs no approval: the bytes are already on disk and
 * the link already works by the time this is called. Recording it as anything
 * else would make the card claim something is still happening.
 */
export function recordPublishAction(
  db: Database.Database,
  input: { pane: string | null; name: string; slug: string; url: string; files: number },
): void {
  try {
    if (!input.pane) return; // published from an ordinary shell; no chat to draw in
    // A pane id from a request body is not evidence that the pane exists, and
    // the FK would throw rather than refuse.
    if (!new PaneStore(db).getById(input.pane)) return;
    new ChatActionStore(db).record({
      pane_id: input.pane,
      kind: 'publish.create',
      title: `Published ${input.name}`,
      // The file count is the whole body: a published tree has no "content" to
      // fold, and the thing worth clicking is the url.
      body: null,
      detail: input.files === 1 ? '1 file' : `${input.files} files`,
      url: input.url,
      state: 'sent',
      // The slug, so a republish of the same name can be recognised later —
      // and so the artifacts list has something stable to key on.
      ref: `publish:${input.slug}`,
    });
  } catch {
    /* a card is a record of a publish, never a precondition for one */
  }
}

/**
 * MAY THIS MACHINE PUBLISH UNDER THIS NAME?
 *
 * `--name` is republish-in-place: the slug is resolved against the install's
 * WHOLE public directory and the existing tree rotates to `@2`. That is the
 * point of the flag — the link you already sent keeps working — and it is a
 * hole the moment a second machine can use it, because the names are a single
 * flat namespace with no owner.
 *
 * Found in review: a compromised host could `POST /api/publish` with its own
 * file and `name: "<some personal report>"` and replace that artifact at its
 * established public URL. No `update: true` needed, and repeated writes rotate
 * the retained versions away too.
 *
 * ── THE OWNERSHIP RECORD ALREADY EXISTS ──────────────────────────────────
 * Every publish now writes a `chat_actions` row with `ref = publish:<slug>`,
 * tied to a pane, which belongs to a machine. So the question is answerable
 * without a new table: a host may use a name when
 *
 *   · no existing slug carries it — nothing to take over; or
 *   · the slug that does was published by a pane on THAT SAME host.
 *
 * ── AN UNOWNED SLUG IS NOT CLAIMABLE, AND THAT IS DELIBERATE ─────────────
 * Hundreds of artifacts predate the record and have no row. Treating "no
 * owner" as "anyone's" would leave exactly the hole this closes — those are
 * the oldest and most-shared links on the install. So an unowned name is
 * refused to a host, and the local machine (which has always been able to
 * publish anything) is unaffected: this is only ever consulted for a host.
 */
export function hostMayPublishAs(
  db: Database.Database,
  existingSlug: string | null,
  nodeId: string,
): boolean {
  if (!existingSlug) return true; // a fresh name takes nothing from anybody
  try {
    const row = db
      .prepare(
        `SELECT p.node_id AS node FROM chat_actions a
           JOIN panes p ON p.id = a.pane_id
          WHERE a.ref = ? ORDER BY a.at DESC LIMIT 1`,
      )
      .get(`publish:${existingSlug}`) as { node: string | null } | undefined;
    return !!row && (row.node ?? LOCAL_NODE_ID) === nodeId;
  } catch {
    // No table, no join, no answer — and "I cannot tell" must not authorise
    // replacing a public artifact.
    return false;
  }
}
