import type Database from 'better-sqlite3';
import { ChatActionStore } from './store/ChatActionStore.js';
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
