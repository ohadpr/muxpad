import type Database from 'better-sqlite3';
import { PaneStore } from '../store/PaneStore.js';
import { rebaseBriefing, wrapRebase } from './rebase.js';

/**
 * PERFORM a rebase: brief, then boot the chat fresh and hand it the briefing.
 *
 * {@link rebaseBriefing} writes the briefing; this is the part that acts on
 * it, and the order is the whole design:
 *
 *   1. BRIEF FIRST, and refuse if it fails. The briefing is written from the
 *      transcript the OLD session is still sitting on. A rebase that killed
 *      the runner first and then failed to summarise would have thrown away a
 *      working chat for nothing — see the best-effort contract on
 *      rebaseBriefing.
 *   2. Drop `--resume`. That flag is the only thing tying the pane to its old
 *      session; without it the runner mints a fresh one, which is what
 *      re-reads today's generated instructions (agent-files.ts) instead of
 *      the ones the old session was born with.
 *   3. Kill, then start. Same two calls the respawn route makes.
 *   4. Submit the briefing. It does NOT need the runner to be up: a
 *      runner-owned pane with nothing connected queues, and the queue drains
 *      the moment the new session hellos. So there is no poll loop here and
 *      no window where the briefing can be dropped on the floor.
 *
 * THIS KILLS WHAT THE PANE WAS HOLDING — background subagents, scheduled
 * wake-ups, an in-flight turn. That is why it is a verb the user types and
 * never something muxpad decides to do for them.
 */

/**
 * The startup command with its `--resume` removed, so the next boot is a NEW
 * conversation.
 *
 * Exported for its own test: the rest of the command is a user's — a model, a
 * backend, a mode, anything hand-typed — and a rebase that mangled it would
 * silently change what the chat IS while claiming only to refresh it.
 */
export function stripResume(cmd: string): string {
  return cmd
    .replace(/\s*--resume[ =][A-Za-z0-9._-]+/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export interface RebaseDeps {
  db: Database.Database;
  /** `killPane` then `ensurePane` — the respawn route's own two calls. */
  respawn: (paneId: string) => Promise<void>;
  /** The agent bridge's `submitSend`; queues when no runner is connected. */
  submit: (
    paneId: string,
    text: string,
  ) => { status: 'sent' | 'queued' | 'rejected'; reason?: string | undefined };
  /** Injected in tests. */
  brief?: (db: Database.Database, paneId: string) => Promise<string | null>;
}

export type RebaseResult =
  | { ok: true; queued: boolean; chars: number }
  | {
      ok: false;
      code: 'not_found' | 'not_an_agent' | 'no_briefing' | 'not_delivered';
      message: string;
    };

export async function runRebase(deps: RebaseDeps, paneId: string): Promise<RebaseResult> {
  const panes = new PaneStore(deps.db);
  const pane = panes.getById(paneId);
  if (!pane) return { ok: false, code: 'not_found', message: 'pane not found' };
  const cmd = pane.startup_cmd ?? '';
  if (!cmd.startsWith('muxpad agent')) {
    return {
      ok: false,
      code: 'not_an_agent',
      message: 'only an agent chat can be rebased — this pane runs no agent',
    };
  }

  const briefing = await (deps.brief ?? rebaseBriefing)(deps.db, paneId);
  if (!briefing) {
    // Deliberately BEFORE anything destructive. "Could not summarise" must
    // never become "summarised to nothing, and your chat is gone".
    return {
      ok: false,
      code: 'no_briefing',
      message: 'could not write a briefing from this chat — nothing was changed',
    };
  }

  const fresh = stripResume(cmd);
  if (fresh !== cmd) panes.setStartupCmd(paneId, fresh);
  await deps.respawn(paneId);

  const sent = deps.submit(paneId, wrapRebase(briefing));
  if (sent.status === 'rejected') {
    return {
      ok: false,
      code: 'not_delivered',
      message: `the chat restarted but the briefing was refused: ${sent.reason ?? 'unknown'}`,
    };
  }
  return { ok: true, queued: sent.status === 'queued', chars: briefing.length };
}
