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

/**
 * WHAT THE REBASE BUTTON MEANS, AND THE ORDER IT TRIES THINGS IN.
 *
 * There is ONE control and it promises ONE thing: **this conversation, on
 * today's instructions.** Everything below is how far muxpad can go toward
 * that for a given chat — never a different promise.
 *
 *   'auto'   what the button sends, and what every caller should want.
 *            Best available, in this order:
 *              1. TRANSCRIPT REBASE — the same turns replayed from a rewritten
 *                 session file with the stale instructions stripped out of
 *                 them. The only option that fixes rules quoted INSIDE the
 *                 history by old compactions. (Lands with transcript-rebase.ts;
 *                 until then `auto` is step 2.)
 *              2. RESUME — leave `--resume` exactly as it is and replace only
 *                 the process. The system prompt is rebuilt from today's
 *                 agent-instructions.md at every runner start, so this is a
 *                 real rebase of the base; what it cannot do is touch what the
 *                 conversation itself says about old rules.
 *            If neither is possible it REFUSES and changes nothing.
 *
 *   'keep'   force step 2.
 *
 *   'fresh'  the escape hatch, and NOT reachable from the button: replace the
 *            session and seed it with a briefing. The history stays on disk
 *            and searchable but leaves the agent's window.
 *
 * WHY `fresh` IS NOT A FALLBACK. It answers a different question. Every other
 * mode keeps the conversation; that one summarises it away, and a button that
 * silently degrades from "keep your history" to "replace it with a summary"
 * would break its own promise at exactly the moment the user could not see it
 * happening. "i want the history but I WANT IT REBASED ON THE NEW
 * INSTRUCTIONS." A briefing is a compaction wearing a nicer name.
 */
export type RebaseMode = 'auto' | 'keep' | 'fresh';

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

export async function runRebase(
  deps: RebaseDeps,
  paneId: string,
  mode: RebaseMode = 'auto',
): Promise<RebaseResult> {
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

  // ── AUTO / KEEP: the history rides along, and only the process is new ──
  //
  // `auto` is this today. The transcript rebase slots in AHEAD of it — same
  // promise, further toward it — and this stays as the fallback for a chat it
  // cannot replay (a codex/cursor session, a file that fails its integrity
  // check, one turn too large to keep whole).
  // Nothing is summarised, nothing is dropped, and the `--resume` stays
  // exactly as it is. The instructions are current the moment the runner
  // boots because the SDK's systemPrompt is built then, from a file the
  // server rewrites from source on every start.
  if (mode === 'auto' || mode === 'keep') {
    await deps.respawn(paneId);
    return { ok: true, queued: false, chars: 0 };
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
